// MCP Streamable-HTTP server for AgentCore Runtime (technical design §4.6).
// Listens on 0.0.0.0:8000: GET /ping, POST /mcp. Every response is one SSE frame.
// Request headers are trusted: the container is reachable only through SigV4 InvokeAgentRuntime.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { ENV, H, IMS, type Im } from '../../shared/contract';
import { getContainerAdapter, type AdapterDeps } from './adapters/index';
import type { ContainerAdapter } from './adapters/types';
import { loadCatalog } from './catalog';
import { activeChildren } from './cli-runner';
import { handleRpc, type McpContext, type RpcRequest } from './mcp';
import { log, setMetricNamespace } from './metrics';
import { createSemaphore } from './semaphore';

const MAX_BODY = 1024 * 1024;
const REQUEST_BUDGET_MS = 27_000; // middleware aborts at 28 s

export interface StartOptions {
  port?: number;
  host?: string;
  im?: Im;
  toolsDir?: string;
  maxConcurrent?: number;
  maxQueue?: number;
  adapter?: ContainerAdapter;
  adapterDeps?: AdapterDeps;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const env = opts.adapterDeps?.env ?? process.env;
  const im = (opts.im ?? env[ENV.IM]) as Im;
  if (!IMS.includes(im)) throw new Error(`IM must be one of ${IMS.join(', ')} (got ${String(im)})`);
  setMetricNamespace(env[ENV.METRIC_NAMESPACE]);
  const catalog = loadCatalog(opts.toolsDir ?? env[ENV.IM_TOOLS_DIR] ?? '/app/tools', im);
  const adapter = opts.adapter ?? getContainerAdapter(im, opts.adapterDeps);
  const maxConcurrent = opts.maxConcurrent ?? (Number(env[ENV.MAX_CONCURRENT]) || 10);
  const m: McpContext = { im, catalog, adapter, withSemaphore: createSemaphore(maxConcurrent, opts.maxQueue ?? 20) };
  await adapter.init().catch(() => undefined);

  let lastStatus = '';
  let lastChange = Math.floor(Date.now() / 1000);
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/ping') {
      const status = adapter.busy?.() ? 'HealthyBusy' : 'Healthy';
      // time_of_last_update must only move when the status changes, or idle reaping never fires.
      if (status !== lastStatus) {
        lastStatus = status;
        lastChange = Math.floor(Date.now() / 1000);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status, time_of_last_update: lastChange }));
      return;
    }
    if (req.method !== 'POST' || path !== '/mcp') {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        res.writeHead(413, { 'Cache-Control': 'no-store', Connection: 'close' }).end();
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) void handle(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<void> {
    let msg: RpcRequest;
    try {
      msg = JSON.parse(body) as RpcRequest;
    } catch {
      return sse(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return sse(res, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    if (!('id' in msg) || msg.id === undefined || msg.id === null) {
      res.writeHead(202, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    const hdr = (n: string) => {
      const v = req.headers[n.toLowerCase()];
      return (Array.isArray(v) ? v[0] : v) || undefined;
    };
    try {
      const out = await handleRpc(m, msg, {
        userId: hdr(H.userId) ?? 'anonymous',
        userToken: hdr(H.userToken),
        authorizeUrl: hdr(H.authorizeUrl),
        requestId: hdr(H.requestId) ?? '',
        caller: hdr(H.caller),
        signal: ac.signal,
        deadline: Date.now() + REQUEST_BUDGET_MS,
      });
      sse(res, out);
    } catch (e) {
      log('ERROR', 'rpc_failed', { method: msg.method, error: String((e as Error).stack ?? e) });
      sse(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
    }
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? (Number(env[ENV.PORT]) || 8000), opts.host ?? '0.0.0.0', resolve));
  const port = (server.address() as AddressInfo).port;
  log('INFO', 'listening', { port, im, tier1: catalog.tier1.length, catalog: catalog.catalog.tools.length, cliVersion: catalog.catalog.cliVersion });
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await adapter.shutdown?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function sse(res: http.ServerResponse, payload: unknown): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** SIGTERM: stop accepting, wait 5 s, SIGTERM children, wait 2 s, SIGKILL, exit 0. */
function installShutdown(s: RunningServer): void {
  let down = false;
  const shutdown = async (signal: string) => {
    if (down) return;
    down = true;
    log('INFO', 'shutdown_start', { signal, active_children: activeChildren.size });
    s.server.close();
    await new Promise((r) => setTimeout(r, 5000));
    for (const c of activeChildren) c.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2000));
    for (const c of activeChildren) c.kill('SIGKILL');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.on('unhandledRejection', (r) => log('ERROR', 'unhandledRejection', { reason: String(r) }));
  startServer()
    .then(installShutdown)
    .catch((e) => {
      log('CRITICAL', 'startup_failed', { error: String((e as Error).stack ?? e) });
      process.exit(1);
    });
}

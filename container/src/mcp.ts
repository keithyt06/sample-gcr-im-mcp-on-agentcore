// JSON-RPC dispatch and the generic tool executor (technical design §4.6, §5.3).
import { CONTROL_METHODS, type Im } from '../../shared/contract';
import { CLI } from '../../shared/versions';
import { discover, familyOf, listTools, resolveTool, type LoadedCatalog } from './catalog';
import { runCli } from './cli-runner';
import { ToolError, envelope, errorResult } from './errors';
import { log } from './metrics';
import { ServerBusyError, type WithSemaphore } from './semaphore';
import type { CallContext, CliRun, ContainerAdapter, Prepared, ToolResult } from './adapters/types';

export const SERVER_NAME = 'gcr-im-mcp-on-agentcore';
export const SERVER_VERSION = '0.1.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CLI_TIMEOUT_CAP_MS = 24_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

export interface McpContext {
  im: Im;
  catalog: LoadedCatalog;
  adapter: ContainerAdapter;
  withSemaphore: WithSemaphore;
  now?: () => number;
}

export interface RequestMeta {
  userId: string;
  userToken?: string;
  authorizeUrl?: string;
  requestId: string;
  caller?: string;
  signal: AbortSignal;
  deadline: number;
}

export async function handleRpc(m: McpContext, req: RpcRequest, meta: RequestMeta): Promise<RpcResponse> {
  const id = req.id ?? null;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (req.method) {
    case 'initialize': {
      const pv = typeof req.params?.protocolVersion === 'string' && PROTOCOLS.includes(req.params.protocolVersion) ? req.params.protocolVersion : '2025-03-26';
      const fam = familyOf(m.im);
      return ok({
        protocolVersion: pv,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, cli: { name: CLI[fam].pkg, version: CLI[fam].version } },
        instructions: instructions(m),
      });
    }
    case 'tools/list':
      return ok({ tools: listTools(m.catalog) });
    case 'ping':
      return ok({});
    case 'tools/call': {
      const name = typeof req.params?.name === 'string' ? req.params.name : '';
      const args = isObject(req.params?.arguments) ? req.params.arguments : {};
      return ok(await callTool(m, name, args, meta));
    }
    default:
      if ((CONTROL_METHODS as readonly string[]).includes(req.method ?? '') && meta.caller === 'control' && m.adapter.controlRpc) {
        try {
          return ok(await m.adapter.controlRpc(req.method!, req.params ?? {}, ctxOf(meta)));
        } catch (e) {
          log('ERROR', 'control_rpc_failed', { method: req.method, error: String((e as Error).message ?? e) });
          return fail(-32000, String((e as Error).message ?? e));
        }
      }
      return fail(-32601, 'Method not found');
  }
}

function instructions(m: McpContext): string {
  const p = m.catalog.prefix;
  return [
    `DISCOVERY: ${m.catalog.tier1.length} high-frequency ${m.im} tools are listed directly. For anything else call ${p}discover(query), then ${p}invoke(tool_name, args).`,
    'AUTHORIZATION: when a tool result contains authorize_url, stop and show the user that link. Do not retry until the user confirms.',
    'DESTRUCTIVE: tools marked destructive need explicit user approval; pass _confirm: true only after the user agrees.',
    'Tool results are JSON envelopes. ok:false carries error.code and error.user_action; follow user_action.',
    'LANGUAGE: reply in the language the user writes in.',
  ].join('\n');
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function ctxOf(meta: RequestMeta): CallContext {
  return { userId: meta.userId, userToken: meta.userToken, authorizeUrl: meta.authorizeUrl, requestId: meta.requestId, signal: meta.signal, deadline: meta.deadline };
}

export async function callTool(m: McpContext, name: string, args: Record<string, unknown>, meta: RequestMeta): Promise<ToolResult> {
  const c = m.catalog;
  if (name === `${c.prefix}discover`) {
    return { content: [{ type: 'text', text: JSON.stringify({ tools: discover(c, args as { query?: string; category?: string; limit?: number }) }) }] };
  }
  let toolName = name;
  let toolArgs = args;
  const isInvoke = name === `${c.prefix}invoke`;
  if (isInvoke) {
    toolName = typeof args.tool_name === 'string' ? args.tool_name : '';
    toolArgs = isObject(args.args) ? args.args : {};
  }
  // Direct calls are limited to the listed tier-1 tools; everything else goes through <im>_invoke.
  const direct = toolName.startsWith(c.prefix) && c.tier1Names.has(toolName.slice(c.prefix.length));
  const tool = isInvoke || direct ? resolveTool(c, toolName) : undefined;
  if (!tool) return envelope('unknown_tool', `Unknown tool: ${toolName || '(empty)'}`, { user_action: `Use ${c.prefix}discover to find a valid tool name.` });
  if (tool.unavailable) return envelope('invalid_argument', `${c.prefix}${tool.name} is not available in this server: ${tool.unavailable}`);
  if (tool.risk === 'high-risk-write' && toolArgs._confirm !== true) {
    return envelope('user_approval_required', `${c.prefix}${tool.name} is a destructive operation and needs explicit user approval.`);
  }
  const cliArgs = { ...toolArgs };
  delete cliArgs._confirm;

  const ctx = ctxOf(meta);
  const now = m.now ?? Date.now;
  try {
    return await m.withSemaphore(async () => {
      let prep: Prepared | undefined;
      try {
        prep = await m.adapter.prepare(ctx);
        const argv = m.adapter.argv(tool, cliArgs, ctx);
        let attempt = 0;
        let run: CliRun;
        for (;;) {
          const timeoutMs = Math.min(CLI_TIMEOUT_CAP_MS, ctx.deadline - now());
          if (timeoutMs <= 0) return envelope('timeout', 'Request deadline reached before the IM CLI could run.');
          run = await runCli(m.adapter.bin, argv, { env: prep.env, cwd: prep.cwd, timeoutMs, maxBuffer: MAX_BUFFER, signal: meta.signal });
          const wait = run.exitCode !== 0 ? m.adapter.retryable?.(run, attempt) : undefined;
          if (wait === undefined || now() + wait >= ctx.deadline - 1000) break;
          await new Promise((r) => setTimeout(r, wait));
          attempt++;
        }
        if (run.aborted) return envelope('timeout', 'The client disconnected; the IM CLI call was cancelled.');
        if (run.timedOut) return envelope('timeout', 'The IM CLI call exceeded the time limit.');
        if (run.overflow) return envelope('output_too_large', 'The IM CLI output exceeded 4 MB.');
        return m.adapter.mapResult(run, tool, ctx);
      } catch (e) {
        if (e instanceof ToolError) return errorResult(e);
        throw e;
      } finally {
        if (prep) await prep.dispose().catch((e) => log('ERROR', 'dispose_failed', { error: String(e) }));
      }
    }, meta.signal);
  } catch (e) {
    if (e instanceof ServerBusyError) return envelope('server_busy', 'Too many concurrent requests.');
    if ((e as Error).message === 'client_aborted') return envelope('timeout', 'The client disconnected while queued.');
    log('ERROR', 'tool_call_failed', { tool: tool.name, error: String((e as Error).stack ?? e) });
    return envelope('cli_failed', 'Internal error while running the tool.');
  }
}

// Test harness: starts the container server against fake CLIs on PATH with an isolated HOME.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { H, type Im } from '../../shared/contract';
import type { SecretsApi, ImAppSecret } from '../../container/src/secrets';
import { startServer, type RunningServer, type StartOptions } from '../../container/src/server';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const FAKES = join(ROOT, 'test/container/fakes');
export const TOOLS_DIR = join(ROOT, 'container/tools');

export interface FakeCall {
  bin: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  pid: number;
}

/** In-memory SecretsApi. */
export class MemorySecrets implements SecretsApi {
  imApp: ImAppSecret = { appId: 'cli_test', appSecret: 's3cret', configured: true };
  users = new Map<string, Record<string, unknown>>();
  tags = new Map<string, Record<string, string>>();
  puts: string[] = [];
  imAppCalls = 0;
  failPut = false;
  async getImApp() {
    this.imAppCalls++;
    return this.imApp;
  }
  async getUserSecret(name: string) {
    return this.users.get(name) ?? null;
  }
  async putUserSecret(name: string, value: Record<string, unknown>) {
    if (this.failPut) throw new Error('put failed');
    this.puts.push(name);
    this.users.set(name, value);
  }
  async tagUserSecret(name: string, tags: Record<string, string>) {
    this.tags.set(name, { ...this.tags.get(name), ...tags });
  }
}

export interface Harness {
  srv: RunningServer;
  home: string;
  tmp: string;
  secrets: MemorySecrets;
  control(c: Record<string, unknown>): void;
  calls(): FakeCall[];
  rpc(method: string, params?: unknown, headers?: Record<string, string>, id?: number | string | null): Promise<{ status: number; body: any; raw: string; headers: Headers }>;
  call(name: string, args?: Record<string, unknown>, headers?: Record<string, string>): Promise<{ result: any; envelope: any }>;
  close(): Promise<void>;
}

export async function startHarness(im: Im, o: Partial<StartOptions> & { env?: Record<string, string>; secrets?: MemorySecrets } = {}): Promise<Harness> {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  };
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const home = mkdtempSync(join(tmpdir(), `imc-home-${im}-`));
  const tmp = mkdtempSync(join(tmpdir(), `imc-tmp-${im}-`));
  setEnv('HOME', home);
  setEnv('PATH', `${FAKES}:${process.env.PATH}`);
  setEnv('IM_MCP_TMP_DIR', tmp);
  // A secret-looking var in the server process: it must never reach the CLI.
  setEnv('AWS_SECRET_ACCESS_KEY', 'should-not-leak');
  setEnv('AWS_ACCESS_KEY_ID', 'AKIDLEAKCHECK');
  setEnv('SECRET_PROBE', 'should-not-leak');
  const secrets = o.secrets ?? new MemorySecrets();
  const env = {
    IM: im,
    IM_APP_ID: 'cli_test',
    IM_APP_SECRET_ID: 'slug/im-app',
    USER_SECRET_PREFIX: 'slug/users',
    DINGTALK_DWS_AGENTCODE: 'test-agent',
    METRIC_NAMESPACE: 'ImMcp/test',
    ...o.env,
  };
  const srv = await startServer({ port: 0, host: '127.0.0.1', im, toolsDir: TOOLS_DIR, adapterDeps: { secrets, env, wecomUrlWaitMs: 5000, ...o.adapterDeps }, ...o });
  const h: Harness = {
    srv,
    home,
    tmp,
    secrets,
    control(c) {
      writeFileSync(join(home, 'fake-control.json'), JSON.stringify(c));
    },
    calls() {
      const p = join(home, 'fake.log');
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeCall);
    },
    async rpc(method, params = {}, headers = {}, id = 1) {
      const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
      if (id !== null) body.id = id;
      const r = await fetch(`${srv.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [H.userId]: 'user-a', [H.requestId]: 'req-1', ...headers },
        body: JSON.stringify(body),
      });
      const raw = await r.text();
      const m = /^event: message\ndata: (.*)\n\n$/s.exec(raw);
      return { status: r.status, body: m ? JSON.parse(m[1]!) : undefined, raw, headers: r.headers };
    },
    async call(name, args = {}, headers = {}) {
      const r = await h.rpc('tools/call', { name, arguments: args }, headers);
      const result = r.body.result;
      let envelope: any;
      try {
        envelope = JSON.parse(result.content[0].text);
      } catch {
        envelope = undefined;
      }
      return { result, envelope };
    },
    async close() {
      await srv.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return h;
}

export const tokenHeaders = (userId: string, token: string, authorizeUrl = 'https://mcp.example.com/authorize?t=incr') => ({
  [H.userId]: userId,
  [H.userToken]: token,
  [H.authorizeUrl]: authorizeUrl,
});

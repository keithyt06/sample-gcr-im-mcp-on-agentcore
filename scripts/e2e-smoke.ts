// Infra-level E2E smoke test (technical design §7.4, G2a). Needs no IM credentials.
//   npm run e2e -- --stack ImMcp-<slug> --region <r>      (or -c config=<path>)
// Reads the stack outputs, runs 8 checks, prints PASS/FAIL for each, exits non-zero on any FAIL.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, cliFamilyOf } from '../infra/lib/config.js';
import type { Im } from '../shared/contract.js';
import { die, isMain, parseArgs, resolveTarget, stackOutputs } from './common.js';
import { E2E_USER_ID, mintTestToken } from './mint-test-token.js';

const IM_HOSTS: Record<Exclude<Im, 'wecom'>, string> = {
  feishu: 'accounts.feishu.cn',
  lark: 'accounts.larksuite.com',
  dingtalk: 'login.dingtalk.com',
};

const b64url = (b: Buffer) => b.toString('base64url');

interface RpcResult {
  status: number;
  headers: Headers;
  body: any;
}

/** POST a JSON-RPC message to /mcp; the response is a single SSE frame (or plain JSON for HTTP errors). */
async function rpc(mcpUrl: string, token: string | undefined, method: string, params: unknown = {}, id = 1): Promise<RpcResult> {
  const r = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  const data = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  let body: unknown = text;
  try {
    body = JSON.parse(data || text);
  } catch {
    /* keep text */
  }
  return { status: r.status, headers: r.headers, body };
}

function readTier1(im: Im): string[] | undefined {
  const p = join(REPO_ROOT, 'container/tools', cliFamilyOf(im), 'tier1.json');
  if (!existsSync(p)) return undefined;
  const j = JSON.parse(readFileSync(p, 'utf8')) as unknown;
  const list = Array.isArray(j) ? j : ((j as { tools?: unknown[] }).tools ?? []);
  return list.map((x) => (typeof x === 'string' ? x : String((x as { name: string }).name)));
}

type Check = () => Promise<string | void>;

async function main(): Promise<void> {
  const args = parseArgs();
  const t = resolveTarget(args);
  const outs = await stackOutputs(t);
  const base = (outs.BaseUrl ?? die(`stack ${t.stack} has no BaseUrl output`)).replace(/\/$/, '');
  const mcpUrl = `${base}/mcp`;
  const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json().catch(() => ({})) as Promise<Record<string, unknown>>);
  const redirectIm = !!outs.CallbackUrl;
  let imName: Im | undefined;
  let clientId = '';
  let token = '';
  let firstTool = '';
  const results: { name: string; ok: boolean; detail: string }[] = [];

  const step = async (name: string, fn: Check) => {
    try {
      const detail = (await fn()) ?? '';
      results.push({ name, ok: true, detail });
      console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
    } catch (e) {
      results.push({ name, ok: false, detail: (e as Error).message });
      console.log(`FAIL  ${name}  ${(e as Error).message}`);
    }
  };
  const expect = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  console.log(`stack ${t.stack} (${t.region}) base ${base}`);

  await step('1 GET /.well-known/oauth-authorization-server', async () => {
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(r.status === 200, `status ${r.status}`);
    const j = (await r.json()) as { issuer?: string };
    expect(j.issuer === base, `issuer ${j.issuer} !== ${base}`);
  });

  await step('2 GET /.well-known/oauth-protected-resource/mcp', async () => {
    const r = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status === 200, `status ${r.status}`);
    const j = (await r.json()) as { resource?: string };
    expect(j.resource === mcpUrl, `resource ${j.resource} !== ${mcpUrl}`);
  });

  await step('3 POST /mcp without token -> 401 + WWW-Authenticate', async () => {
    const r = await rpc(mcpUrl, undefined, 'initialize');
    expect(r.status === 401, `status ${r.status}`);
    const h = r.headers.get('www-authenticate') ?? '';
    expect(h.includes('resource_metadata="'), `WWW-Authenticate: ${h}`);
  });

  const redirectUri = 'http://127.0.0.1:33418/callback';
  await step('4 POST /register (DCR) -> 201', async () => {
    const r = await fetch(String(meta.registration_endpoint ?? `${base}/register`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'e2e-smoke', redirect_uris: [redirectUri] }),
    });
    expect(r.status === 201, `status ${r.status}`);
    const j = (await r.json()) as { client_id?: string };
    expect(j.client_id, 'no client_id');
    clientId = j.client_id!;
  });

  await step('5 GET /authorize (PKCE) -> IM', async () => {
    expect(clientId, 'no client_id from step 4');
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const u = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: b64url(randomBytes(8)),
    }))
      u.searchParams.set(k, v);
    const r = await fetch(u, { redirect: 'manual' });
    if (redirectIm) {
      expect(r.status === 302, `status ${r.status}`);
      const loc = new URL(r.headers.get('location') ?? 'about:blank');
      const found = (Object.entries(IM_HOSTS) as [Im, string][]).find(([, h]) => h === loc.host);
      expect(found, `redirect host ${loc.host} is not an IM host`);
      imName = found![0];
      return loc.host;
    }
    expect(r.status === 200, `status ${r.status}`);
    const html = await r.text();
    expect(html.includes('work.weixin.qq.com'), 'QR page does not contain work.weixin.qq.com');
    imName = 'wecom';
  });

  await step('6 minted token -> initialize + tools/list', async () => {
    token = await mintTestToken({ region: t.region, rootKeySecretName: outs.RootKeySecretName, userId: E2E_USER_ID });
    const init = await rpc(mcpUrl, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-smoke', version: '0' } });
    expect(init.status === 200, `initialize status ${init.status} ${JSON.stringify(init.body).slice(0, 200)}`);
    const list = await rpc(mcpUrl, token, 'tools/list', {}, 2);
    expect(list.status === 200, `tools/list status ${list.status}`);
    const names: string[] = (list.body?.result?.tools ?? []).map((x: { name: string }) => x.name);
    expect(names.length > 0, 'no tools');
    const prefix = names.find((n) => n.endsWith('_discover'))?.replace(/_discover$/, '') as Im | undefined;
    expect(prefix, 'no <im>_discover tool');
    imName ??= prefix;
    const tier1 = readTier1(prefix!);
    if (tier1) {
      const want = [...tier1.map((n) => `${prefix}_${n}`), `${prefix}_discover`, `${prefix}_invoke`].sort();
      expect(JSON.stringify([...names].sort()) === JSON.stringify(want), `tools differ from tier1 (${names.length} vs ${want.length})`);
    }
    firstTool = names.find((n) => !n.endsWith('_discover') && !n.endsWith('_invoke')) ?? '';
    return `${names.length} tools`;
  });

  await step('7 tools/call without IM credential -> im_not_authorized', async () => {
    expect(firstTool, 'no tier-1 tool from step 6');
    const r = await rpc(mcpUrl, token, 'tools/call', { name: firstTool, arguments: {} }, 3);
    expect(r.status === 200, `status ${r.status}`);
    const res = r.body?.result;
    expect(res?.isError === true, `isError ${res?.isError}`);
    const env = JSON.parse(res.content?.[0]?.text ?? '{}') as { error?: { code?: string; authorize_url?: string } };
    expect(env.error?.code === 'im_not_authorized', `code ${env.error?.code}`);
    if (redirectIm) expect(env.error?.authorize_url?.startsWith(`${base}/authorize?t=`), `authorize_url ${env.error?.authorize_url}`);
    return firstTool;
  });

  await step('8 throttle: 40 parallel POST /register -> at least one 429', async () => {
    const codes = await Promise.all(
      Array.from({ length: 40 }, () =>
        fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirectUri] }) }).then(
          (r) => r.status,
          () => 0,
        ),
      ),
    );
    const n429 = codes.filter((c) => c === 429).length;
    expect(n429 > 0, `no 429 (statuses: ${[...new Set(codes)].join(',')})`);
    return `${n429}/40 throttled`;
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed${imName ? ` (im=${imName})` : ''}`);
  process.exit(failed ? 1 : 0);
}

if (isMain(import.meta.url)) main().catch((e: Error) => die(e.message));

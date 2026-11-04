import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { RUNTIME_HEADERS } from '../../shared/contract';
import { handler, resetCredentialCache } from '../../lambda/middleware/index';
import type { HttpResult } from '../../lambda/shared/http';
import { mintAccessToken, runtimeSessionId, verifyIncrToken } from '../../lambda/shared/tokens';
import { BASE, ev, fakeFetch, headersOf, installFakes, KEYS, PREFIX, secrets, setEnv, smMock, ssmMock, sseResp, USER_A, USER_B, useRuntime, type FetchCall } from './helpers';

let out: MockInstance<typeof console.log>;
let upstream: (c: FetchCall) => Response | Promise<Response>;
let rt: ReturnType<typeof fakeFetch>;

const now = () => Math.floor(Date.now() / 1000);
function storeCred(userId: string, accessToken: string, expiresIn = 3600): void {
  secrets.set(`${PREFIX}/${userId}`, {
    value: JSON.stringify({ accessToken, refreshToken: 'rt', expiresAt: now() + expiresIn, issuedAt: now(), im: 'feishu', imUid: 'ou' }),
    tags: {},
  });
}

beforeEach(() => {
  installFakes();
  setEnv('feishu');
  resetCredentialCache();
  upstream = () => sseResp({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  rt = fakeFetch([['/invocations', (c) => upstream(c)]]);
  useRuntime(rt);
  out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => out.mockRestore());

const rpc = (msg: unknown, token: string = mintAccessToken(KEYS, USER_A), extraHeaders: Record<string, string> = {}) =>
  handler(
    ev('POST', '/mcp', {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...extraHeaders },
      body: typeof msg === 'string' ? msg : JSON.stringify(msg),
    }),
  );
const body = (r: HttpResult) => JSON.parse(r.body ?? '{}') as Record<string, unknown>;
const sseJson = (r: HttpResult) => JSON.parse(/data: (.*)/.exec(r.body ?? '')![1]!) as { result: { isError: boolean; content: { text: string }[] } };

describe('auth', () => {
  it('401 without a bearer, with resource_metadata', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '');
    expect(r.statusCode).toBe(401);
    expect(r.headers!['WWW-Authenticate']).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(rt.calls).toHaveLength(0);
  });
  it('401 invalid_token for a bad / expired / incr token', async () => {
    for (const t of ['garbage', mintAccessToken(KEYS, USER_A, 10, now() - 100)]) {
      const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, t);
      expect(r.statusCode).toBe(401);
      expect(r.headers!['WWW-Authenticate']).toBe(`Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    }
  });
  it('503 when the root key, base url, or user secret is unavailable', async () => {
    smMock.on(GetSecretValueCommand).rejects(new Error('throttle'));
    let r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.statusCode).toBe(503);
    expect(r.headers!['Retry-After']).toBe('2');
    expect(body(r)).toEqual({ error: 'backend_unavailable' });

    installFakes();
    setEnv('feishu');
    ssmMock.on(GetParameterCommand).rejects(new Error('ssm'));
    r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.statusCode).toBe(503);

    installFakes();
    setEnv('feishu');
    useRuntime(rt);
    smMock.on(GetSecretValueCommand).callsFake((i: { SecretId: string }) => {
      if (i.SecretId === 'team-a/root-key') return { SecretString: 'test-root-key-0123456789abcdef0123456789abcdef' };
      throw Object.assign(new Error('rate'), { name: 'ThrottlingException' });
    });
    r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } });
    expect(r.statusCode).toBe(503);
  });
  it('unexpected errors propagate (Lambda error → API 5xx alarm)', async () => {
    delete process.env.NEEDS_USER_TOKEN;
    await expect(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow(/NEEDS_USER_TOKEN/);
  });
});

describe('methods and body', () => {
  it('GET → 405, DELETE → 204, others → 405', async () => {
    const t = mintAccessToken(KEYS, USER_A);
    expect((await handler(ev('GET', '/mcp', { headers: { authorization: `Bearer ${t}` } }))).statusCode).toBe(405);
    expect((await handler(ev('DELETE', '/mcp', { headers: { authorization: `Bearer ${t}` } }))).statusCode).toBe(204);
    expect((await handler(ev('PUT', '/mcp', { headers: { authorization: `Bearer ${t}` } }))).statusCode).toBe(405);
  });
  it('400 -32700 parse error, -32600 batch / non-object / bad method type, -32601 im/*', async () => {
    expect(body(await rpc('{not json'))).toMatchObject({ error: { code: -32700 } });
    const batch = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(batch.statusCode).toBe(400);
    expect(body(batch)).toMatchObject({ error: { code: -32600 } });
    expect(body(await rpc('"str"'))).toMatchObject({ error: { code: -32600 } });
    expect(body(await rpc({ jsonrpc: '2.0', id: 3, method: 7 }))).toMatchObject({ error: { code: -32600 }, id: 3 });
    const ctl = await rpc({ jsonrpc: '2.0', id: 1, method: 'im/auth.start' });
    expect(ctl.statusCode).toBe(400);
    expect(body(ctl)).toMatchObject({ error: { code: -32601 } });
    expect(rt.calls).toHaveLength(0);
  });
  it('413 for > 1 MB', async () => {
    const r = await rpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { a: 'a'.repeat(1024 * 1024) } }));
    expect(r.statusCode).toBe(413);
  });
  it('notifications and client responses → 202, no upstream call', async () => {
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
    expect((await rpc({ jsonrpc: '2.0', id: 5, result: {} })).statusCode).toBe(202);
    expect(rt.calls).toHaveLength(0);
  });
});

describe('IM credential handling (redirect IMs)', () => {
  it('tools/call without credential → 200 SSE envelope with authorize_url, no upstream call', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'feishu_im_messages_send' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers!['Content-Type']).toBe('text/event-stream');
    const p = sseJson(r);
    expect(p.result.isError).toBe(true);
    const env = JSON.parse(p.result.content[0]!.text) as { ok: boolean; error: { code: string; authorize_url: string } };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('im_not_authorized');
    const u = new URL(env.error.authorize_url);
    expect(u.origin + u.pathname).toBe(`${BASE}/authorize`);
    expect(verifyIncrToken(KEYS, u.searchParams.get('t')!)).toEqual({ userId: USER_A });
    expect(rt.calls).toHaveLength(0);
  });
  it('near-expiry credential (< 120 s) counts as missing', async () => {
    storeCred(USER_A, 'u-at', 60);
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } });
    expect(sseJson(r).result.isError).toBe(true);
  });
  it('tools/list and initialize are forwarded without User-Token', async () => {
    for (const method of ['initialize', 'tools/list', 'ping']) {
      const r = await rpc({ jsonrpc: '2.0', id: 1, method });
      expect(r.statusCode).toBe(200);
    }
    for (const c of rt.calls) expect(headersOf(c)['x-amzn-bedrock-agentcore-runtime-custom-user-token']).toBeUndefined();
  });
  it('signed request: exact header set, derived session id, client session id ignored, raw body forwarded', async () => {
    storeCred(USER_A, 'u-at-alice');
    const msg = { jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'feishu_x', arguments: { q: 1 } } };
    const r = await rpc(msg, mintAccessToken(KEYS, USER_A), { 'Mcp-Session-Id': 'client-chosen' });
    expect(r.statusCode).toBe(200);
    expect(r.headers!['Mcp-Session-Id']).toBe(runtimeSessionId(KEYS, USER_A));
    expect(r.headers!['Cache-Control']).toBe('no-store');
    const c = rt.calls[0]!;
    expect(c.url).toBe(`https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/${encodeURIComponent(process.env.RUNTIME_ARN!)}/invocations`);
    expect(JSON.parse(c.body)).toEqual(msg);
    const h = headersOf(c);
    expect(h['mcp-session-id']).toBe(runtimeSessionId(KEYS, USER_A));
    expect(h['content-type']).toBe('application/json');
    expect(h.accept).toBe('application/json, text/event-stream');
    const custom = Object.keys(h).filter((k) => k.startsWith('x-amzn-bedrock-agentcore-runtime-custom-')).sort();
    expect(custom).toEqual(RUNTIME_HEADERS.map((x) => x.toLowerCase()).filter((x) => !x.endsWith('-caller') || true).sort());
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-user-id']).toBe(USER_A);
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-user-token']).toBe('u-at-alice');
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-caller']).toBe('mcp');
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-request-id']).toBe('req-1');
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-authorize-url']).toMatch(new RegExp(`^${BASE}/authorize\\?t=`));
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 .*SignedHeaders=[^,]*x-amzn-bedrock-agentcore-runtime-custom-user-token/);
    expect(h.host).toBe('bedrock-agentcore.ap-northeast-1.amazonaws.com');
    // token never logged
    expect(out.mock.calls.map((x) => String(x[0])).join('\n')).not.toContain('u-at-alice');
  });
  it('two users get their own token and session; credentials are cached', async () => {
    storeCred(USER_A, 'tok-a');
    storeCred(USER_B, 'tok-b');
    for (let i = 0; i < 3; i++) {
      await rpc({ jsonrpc: '2.0', id: i, method: 'tools/call' }, mintAccessToken(KEYS, USER_A));
      await rpc({ jsonrpc: '2.0', id: i, method: 'tools/call' }, mintAccessToken(KEYS, USER_B));
    }
    const pairs = rt.calls.map((c) => [headersOf(c)['x-amzn-bedrock-agentcore-runtime-custom-user-id'], headersOf(c)['x-amzn-bedrock-agentcore-runtime-custom-user-token']]);
    expect(pairs).toEqual([[USER_A, 'tok-a'], [USER_B, 'tok-b'], [USER_A, 'tok-a'], [USER_B, 'tok-b'], [USER_A, 'tok-a'], [USER_B, 'tok-b']]);
    const userGets = smMock.commandCalls(GetSecretValueCommand).filter((c) => String(c.args[0].input.SecretId).startsWith(PREFIX));
    expect(userGets).toHaveLength(2);
  });
  it('credential cache evicts beyond 500 users', async () => {
    for (let i = 0; i < 501; i++) {
      const u = i.toString(16).padStart(32, '0');
      storeCred(u, `t${i}`);
      await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call' }, mintAccessToken(KEYS, u));
    }
    expect(rt.calls).toHaveLength(501);
  });
});

describe('wecom (no user token)', () => {
  it('forwards tools/call without User-Token or Authorize-Url', async () => {
    setEnv('wecom');
    await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wecom_x' } });
    const h = headersOf(rt.calls[0]!);
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-user-token']).toBeUndefined();
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-authorize-url']).toBeUndefined();
    expect(smMock.commandCalls(GetSecretValueCommand).filter((c) => String(c.args[0].input.SecretId).startsWith(PREFIX))).toHaveLength(0);
  });
});

describe('upstream mapping', () => {
  it('429 → 429 + Retry-After', async () => {
    upstream = () => new Response('slow down', { status: 429 });
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.statusCode).toBe(429);
    expect(r.headers!['Retry-After']).toBe('2');
  });
  it.each([500, 503, 403, 404])('%i → 502 upstream_error', async (s) => {
    upstream = () => new Response('err', { status: s });
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.statusCode).toBe(502);
    expect(body(r)).toEqual({ error: 'upstream_error' });
  });
  it('timeout → 504; network error → 502', async () => {
    upstream = () => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    };
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(504);
    upstream = () => {
      throw new TypeError('fetch failed');
    };
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(502);
  });
  it('content type passed through, defaults to json', async () => {
    upstream = () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 });
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.headers!['Content-Type']).toContain('text/plain');
    upstream = () => {
      const res = new Response('{}', { status: 200 });
      res.headers.delete('content-type');
      return res;
    };
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).headers!['Content-Type']).toBe('application/json');
  });
});

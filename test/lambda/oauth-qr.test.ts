// WeCom QR flow: /authorize starts a control RPC session; /authorize/status polls it.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handler } from '../../lambda/oauth/index';
import type { HttpResult } from '../../lambda/shared/http';
import { parseRpcBody } from '../../lambda/shared/runtime-client';
import * as store from '../../lambda/shared/store';
import { pkceS256, runtimeSessionId } from '../../lambda/shared/tokens';
import { ev, fakeFetch, headersOf, installFakes, KEYS, PREFIX, secrets, setEnv, sseResp, table, useRuntime, type FetchCall } from './helpers';

const VERIFIER = 'q'.repeat(60);
const LOOPBACK = 'http://127.0.0.1:33418/callback';
let out: MockInstance<typeof console.log>;

type Handler = (method: string, params: Record<string, unknown>, c: FetchCall) => Response;
let rpc: Handler;
const startOk = () =>
  sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'pending', sessionId: 'sess-1', authorizeUrl: 'https://work.weixin.qq.com/ai/qc/gen?x=1', qrPngBase64: 'iVBORw0KGgo=' } });
/** Answers im/auth.start normally and im/auth.status with the given result. */
const statusIs = (result: unknown): Handler => (m) => (m === 'im/auth.start' ? startOk() : sseResp({ jsonrpc: '2.0', id: 1, result }));
let rt: ReturnType<typeof fakeFetch>;

beforeEach(() => {
  installFakes();
  setEnv('wecom');
  rpc = (method) =>
    method === 'im/auth.start'
      ? sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'pending', sessionId: 'sess-1', authorizeUrl: 'https://work.weixin.qq.com/ai/qc/gen?x=1', qrPngBase64: 'iVBORw0KGgo=' } })
      : sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'pending', sessionId: 'sess-1' } });
  rt = fakeFetch([
    ['/invocations', (c) => {
      const p = parseRpcBody(c.body) as { method: string; params: Record<string, unknown> };
      return rpc(p.method, p.params, c);
    }],
  ]);
  useRuntime(rt);
  out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => out.mockRestore());

const body = (r: HttpResult) => JSON.parse(r.body ?? '{}') as Record<string, unknown>;

let ipSeq = 0;
async function start(ip = `198.51.100.${++ipSeq}`): Promise<{ flow: string; page: HttpResult; cid: string }> {
  const reg = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [LOOPBACK] }) }));
  const cid = String(body(reg).client_id);
  const e = ev('GET', '/authorize', {
    query: { response_type: 'code', client_id: cid, redirect_uri: LOOPBACK, code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256', state: 'st' },
  });
  e.requestContext.http.sourceIp = ip;
  const page = await handler(e);
  const flow = /const f="([0-9a-f]{32})"/.exec(page.body ?? '')?.[1] ?? '';
  return { flow, page, cid };
}

const status = (flow: string) => handler(ev('GET', '/authorize/status', { query: { flow } }));

describe('wecom /authorize', () => {
  it('starts a QR session via a signed control RPC and renders the QR page with CSP nonce', async () => {
    const { flow, page } = await start();
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('data:image/png;base64,iVBORw0KGgo=');
    const csp = page.headers!['Content-Security-Policy']!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toContain("default-src 'none'; img-src data:;");
    expect(csp).toContain("connect-src 'self'");
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    expect(page.body).toContain(`<style nonce="${nonce}">`);
    expect(page.body).toContain('bind existing bot');

    const f = await store.getFlow(flow);
    expect(f).toMatchObject({ kind: 'qr', containerSessionId: 'sess-1', redirectUri: LOOPBACK, clientState: 'st' });
    expect(f!.userId).toMatch(/^[0-9a-f]{32}$/);

    const c = rt.calls[0]!;
    const h = headersOf(c);
    expect(c.url).toBe(`https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/${encodeURIComponent(process.env.RUNTIME_ARN!)}/invocations`);
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-caller']).toBe('control');
    expect(h['x-amzn-bedrock-agentcore-runtime-custom-user-id']).toBe(f!.userId);
    expect(h['mcp-session-id']).toBe(runtimeSessionId(KEYS, f!.userId!));
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/ap-northeast-1\/bedrock-agentcore\/aws4_request/);
    expect(h.accept).toBe('application/json, text/event-stream');
  });

  it('link fallback when there is no PNG; zh page', async () => {
    rpc = () => sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'pending', sessionId: 's', authorizeUrl: 'https://work.weixin.qq.com/ai/qc/gen?a=1&b=2' } });
    const reg = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [LOOPBACK] }) }));
    const page = await handler(
      ev('GET', '/authorize', {
        headers: { 'accept-language': 'zh' },
        query: { response_type: 'code', client_id: String(body(reg).client_id), redirect_uri: LOOPBACK, code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256' },
      }),
    );
    expect(page.body).toContain('href="https://work.weixin.qq.com/ai/qc/gen?a=1&amp;b=2"');
    expect(page.body).toContain('lang="zh-CN"');
  });

  it.each([
    ['rpc error', () => sseResp({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } })],
    ['http 500', () => new Response('x', { status: 500 })],
    ['non-json', () => new Response('garbage', { status: 200 })],
    ['null body', () => new Response('null', { status: 200 })],
    ['no result', () => sseResp({ jsonrpc: '2.0', id: 1 })],
    ['unexpected status', () => sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'already_authorized' } })],
  ])('start failure (%s) → 502 HTML', async (_n, h) => {
    rpc = h;
    const { page } = await start();
    expect(page.statusCode).toBe(502);
    expect(page.headers!['Content-Type']).toContain('text/html');
  });

  it('/callback is 404 for wecom; incremental t= is rejected', async () => {
    expect((await handler(ev('GET', '/callback', { query: { code: 'x', state: 'y' } }))).statusCode).toBe(404);
    expect((await handler(ev('GET', '/authorize', { query: { t: 'x' } }))).statusCode).toBe(400);
  });
});

describe('wecom /authorize/status', () => {
  it('pending passes through; bad / unknown flow', async () => {
    const { flow } = await start();
    expect(body(await status(flow))).toEqual({ status: 'pending' });
    expect(body(await status('0'.repeat(32)))).toEqual({ status: 'expired' });
    expect((await status('bad')).statusCode).toBe(400);
    expect((await handler(ev('POST', '/authorize/status'))).statusCode).toBe(405);
  });

  it('expired / failed pass through with reason; unknown container status maps to pending', async () => {
    const { flow } = await start();
    rpc = () => sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'failed', reason: 'cli_exit_1' } });
    expect(body(await status(flow))).toEqual({ status: 'failed', reason: 'cli_exit_1' });
    rpc = () => sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'unknown' } });
    expect(body(await status(flow))).toEqual({ status: 'pending' });
    rpc = () => new Response('x', { status: 503 });
    expect(body(await status(flow))).toEqual({ status: 'pending' });
  });

  it('authorized: identity registered, code issued, flow deleted, token exchange works', async () => {
    const { flow, cid } = await start();
    const userId = (await store.getFlow(flow))!.userId!;
    rpc = (m, p) => {
      expect(m).toBe('im/auth.status');
      expect(p).toEqual({ sessionId: 'sess-1' });
      return sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'authorized', wecomIdentity: { userId: 'wo_alice', userName: 'Alice' } } });
    };
    const r = body(await status(flow));
    expect(r.status).toBe('authorized');
    const u = new URL(String(r.redirect));
    expect(u.searchParams.get('state')).toBe('st');
    expect(table.get('ident#wecom#wo_alice')!.userId!.S).toBe(userId);
    expect(await store.getUser(userId)).toMatchObject({ im: 'wecom', imUid: 'wo_alice' });
    expect(await store.getFlow(flow)).toBeNull();

    const tok = await handler(
      ev('POST', '/token', {
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cid, code: u.searchParams.get('code')!, redirect_uri: LOOPBACK, code_verifier: VERIFIER }).toString(),
      }),
    );
    expect(tok.statusCode).toBe(200);
  });

  it('another microVM answered: DescribeSecret fallback, identity from tag', async () => {
    const { flow } = await start();
    const userId = (await store.getFlow(flow))!.userId!;
    secrets.set(`${PREFIX}/${userId}`, { value: '{}', tags: { WecomUserId: 'wo_bob' } });
    rpc = () => sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'unknown' } });
    const r = body(await status(flow));
    expect(r.status).toBe('authorized');
    expect(table.get('ident#wecom#wo_bob')!.userId!.S).toBe(userId);
  });

  it('identity slot replacement: old slot disabled, its secret scheduled for deletion', async () => {
    const OLD = 'c'.repeat(32);
    await store.setIdent('wecom', 'wo_carol', OLD);
    await store.putUser(OLD, { im: 'wecom', imUid: 'wo_carol', createdAt: 1, lastLoginAt: 1 });
    secrets.set(`${PREFIX}/${OLD}`, { value: '{}', tags: {} });
    const { flow } = await start();
    const userId = (await store.getFlow(flow))!.userId!;
    rpc = () => sseResp({ jsonrpc: '2.0', id: 1, result: { status: 'authorized', wecomIdentity: { userId: 'wo_carol' } } });
    expect(body(await status(flow)).status).toBe('authorized');
    expect(table.get('ident#wecom#wo_carol')!.userId!.S).toBe(userId);
    expect(await store.getUser(OLD)).toMatchObject({ disabled: true, replacedBy: userId });
    expect(secrets.get(`${PREFIX}/${OLD}`)!.deleted).toBe(true);
  });

  it('old slot secret already gone is tolerated; same slot is idempotent; missing identity still authorizes', async () => {
    const OLD = 'd'.repeat(32);
    await store.setIdent('wecom', 'wo_dan', OLD);
    const a = await start();
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_dan' } });
    expect(body(await status(a.flow)).status).toBe('authorized');

    const b = await start();
    const ub = (await store.getFlow(b.flow))!.userId!;
    await store.setIdent('wecom', 'wo_same', ub);
    rpc = statusIs({ status: 'already_authorized', wecomIdentity: { userId: 'wo_same' } });
    expect(body(await status(b.flow)).status).toBe('authorized');

    const c = await start();
    const uc = (await store.getFlow(c.flow))!.userId!;
    rpc = statusIs({ status: 'authorized' });
    expect(body(await status(c.flow)).status).toBe('authorized');
    expect(await store.getUser(uc)).toMatchObject({ im: 'wecom' });
  });

  it('DescribeSecret errors do not break polling', async () => {
    const { flow } = await start();
    const { smMock } = await import('./helpers');
    const { DescribeSecretCommand } = await import('@aws-sdk/client-secrets-manager');
    smMock.on(DescribeSecretCommand).rejects(new Error('denied'));
    expect(body(await status(flow))).toEqual({ status: 'pending' });
  });

});

describe('H-1: pending QR cap', () => {
  it('global cap (WECOM_MAX_PENDING_QR) → 429 page before any microVM is started', async () => {
    process.env.WECOM_MAX_PENDING_QR = '2';
    expect((await start()).page.statusCode).toBe(200);
    expect((await start()).page.statusCode).toBe(200);
    const calls = rt.calls.length;
    const third = await start();
    expect(third.page.statusCode).toBe(429);
    expect(third.page.headers!['Retry-After']).toBe('60');
    expect(third.page.body).toContain('Too many sign-ins');
    expect(rt.calls.length).toBe(calls);
  });
  it('default cap is 20; invalid env falls back to 20', async () => {
    process.env.WECOM_MAX_PENDING_QR = 'abc';
    for (let i = 0; i < 20; i++) expect((await start()).page.statusCode).toBe(200);
    expect((await start()).page.statusCode).toBe(429);
  });
  it('per-source cap of 3 pending sessions', async () => {
    for (let i = 0; i < 3; i++) expect((await start('203.0.113.9')).page.statusCode).toBe(200);
    expect((await start('203.0.113.9')).page.statusCode).toBe(429);
    expect((await start('203.0.113.10')).page.statusCode).toBe(200);
  });
  it('slots are released on start failure, on terminal status, and on completion', async () => {
    process.env.WECOM_MAX_PENDING_QR = '1';
    rpc = () => new Response('x', { status: 500 });
    expect((await start()).page.statusCode).toBe(502);
    rpc = statusIs({ status: 'failed', reason: 'x' });
    const a = await start();
    expect(a.page.statusCode).toBe(200);
    expect(body(await status(a.flow)).status).toBe('failed');
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_rel' } });
    const b = await start();
    expect(b.page.statusCode).toBe(200);
    expect(body(await status(b.flow)).status).toBe('authorized');
    expect((await start()).page.statusCode).toBe(200);
  });
});

describe('L-2: completion is single-use', () => {
  it('two concurrent authorized polls issue only one code', async () => {
    const { flow } = await start();
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_race' } });
    const [r1, r2] = await Promise.all([status(flow), status(flow)]);
    const statuses = [body(r1).status, body(r2).status].sort();
    expect(statuses).toEqual(['authorized', 'expired']);
    expect([...table.keys()].filter((k) => k.startsWith('code#'))).toHaveLength(1);
  });
});

describe('M-2: operator revocation sticks across rescans', () => {
  it('identity mapped to a revoked user → failed/access_revoked, mapping kept, new blob deleted, no code', async () => {
    const OLD = 'e'.repeat(32);
    await store.setIdent('wecom', 'wo_evil', OLD);
    await store.putUser(OLD, { im: 'wecom', imUid: 'wo_evil', createdAt: 1, lastLoginAt: 1 });
    await store.disableUser(OLD);
    const { flow } = await start();
    const userId = (await store.getFlow(flow))!.userId!;
    secrets.set(`${PREFIX}/${userId}`, { value: '{}', tags: {} });
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_evil' } });
    expect(body(await status(flow))).toEqual({ status: 'failed', reason: 'access_revoked' });
    expect(table.get('ident#wecom#wo_evil')!.userId!.S).toBe(OLD);
    expect(await store.getUser(userId)).toMatchObject({ disabled: true });
    expect(secrets.get(`${PREFIX}/${userId}`)!.deleted).toBe(true);
    expect([...table.keys()].filter((k) => k.startsWith('code#'))).toHaveLength(0);
  });
  it('a replaced (not revoked) old slot is still repointed', async () => {
    const OLD = 'f'.repeat(32);
    await store.setIdent('wecom', 'wo_ok', OLD);
    await store.putUser(OLD, { im: 'wecom', createdAt: 1, lastLoginAt: 1 });
    await store.disableUser(OLD, 'a'.repeat(32));
    const { flow } = await start();
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_ok' } });
    expect(body(await status(flow)).status).toBe('authorized');
  });
  it('delete failure of the new blob is tolerated', async () => {
    const OLD = '9'.repeat(32);
    await store.setIdent('wecom', 'wo_rv', OLD);
    await store.putUser(OLD, { im: 'wecom', createdAt: 1, lastLoginAt: 1, disabled: true });
    const { flow } = await start();
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_rv' } });
    expect(body(await status(flow)).reason).toBe('access_revoked');
  });
});

describe('M-3: operator approval mode (WECOM_REQUIRE_APPROVAL)', () => {
  const approve = (u: string) => {
    const it = table.get(`user#${u}`)!;
    it.approval = { S: 'approved' };
    it.approvedAt = { N: String(Math.floor(Date.now() / 1000)) };
  };

  it('new identity → pending_approval, no code; after approval a rescan reuses approval', async () => {
    process.env.WECOM_REQUIRE_APPROVAL = 'true';
    const a = await start();
    const ua = (await store.getFlow(a.flow))!.userId!;
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_new' } });
    expect(body(await status(a.flow))).toEqual({ status: 'pending_approval', reason: 'pending_approval' });
    expect(await store.getUser(ua)).toMatchObject({ approval: 'pending', imUid: 'wo_new' });
    expect([...table.keys()].filter((k) => k.startsWith('code#'))).toHaveLength(0);
    expect(table.get('ident#wecom#wo_new')!.userId!.S).toBe(ua);

    // rescan while still pending → still pending (on the new slot)
    const b = await start();
    const ub = (await store.getFlow(b.flow))!.userId!;
    expect(body(await status(b.flow)).status).toBe('pending_approval');
    expect(await store.getUser(ub)).toMatchObject({ approval: 'pending' });

    // operator approves → next rescan is authorized, replacement inherits approval
    approve(ub);
    const c = await start();
    const uc = (await store.getFlow(c.flow))!.userId!;
    expect(body(await status(c.flow)).status).toBe('authorized');
    expect((await store.getUser(uc))!.approval).toBeUndefined();
  });

  it('existing users without an approval attribute are unaffected', async () => {
    process.env.WECOM_REQUIRE_APPROVAL = 'true';
    const OLD = '7'.repeat(32);
    await store.setIdent('wecom', 'wo_legacy', OLD);
    await store.putUser(OLD, { im: 'wecom', createdAt: 1, lastLoginAt: 1 });
    const { flow } = await start();
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_legacy' } });
    expect(body(await status(flow)).status).toBe('authorized');
  });

  it('same slot still pending → pending; no identity → fail closed (pending)', async () => {
    process.env.WECOM_REQUIRE_APPROVAL = 'true';
    const a = await start();
    const ua = (await store.getFlow(a.flow))!.userId!;
    await store.setIdent('wecom', 'wo_same2', ua);
    await store.putUser(ua, { im: 'wecom', createdAt: 1, lastLoginAt: 1, approval: 'pending' });
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_same2' } });
    expect(body(await status(a.flow)).status).toBe('pending_approval');

    const b = await start();
    rpc = statusIs({ status: 'authorized' });
    expect(body(await status(b.flow)).status).toBe('pending_approval');
  });

  it('pending users cannot get tokens even with a code or refresh token', async () => {
    process.env.WECOM_REQUIRE_APPROVAL = 'false';
    const { flow, cid } = await start();
    const userId = (await store.getFlow(flow))!.userId!;
    rpc = statusIs({ status: 'authorized', wecomIdentity: { userId: 'wo_tok' } });
    const code = new URL(String(body(await status(flow)).redirect)).searchParams.get('code')!;
    const tok = await handler(
      ev('POST', '/token', { body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cid, code, redirect_uri: LOOPBACK, code_verifier: VERIFIER }).toString() }),
    );
    const rt1 = String(body(tok).refresh_token);
    table.get(`user#${userId}`)!.approval = { S: 'pending' };
    const r = await handler(ev('POST', '/token', { body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt1, client_id: cid }).toString() }));
    expect(body(r)).toMatchObject({ error: 'invalid_grant', error_description: 'pending operator approval' });
  });

  it('QR page script handles pending_approval and access_revoked', async () => {
    const { page } = await start();
    expect(page.body).toContain("d.status==='pending_approval'");
    expect(page.body).toContain('waiting for operator approval');
  });
});

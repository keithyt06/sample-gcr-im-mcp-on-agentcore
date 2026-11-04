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

async function start(): Promise<{ flow: string; page: HttpResult; cid: string }> {
  const reg = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [LOOPBACK] }) }));
  const cid = String(body(reg).client_id);
  const page = await handler(
    ev('GET', '/authorize', {
      query: { response_type: 'code', client_id: cid, redirect_uri: LOOPBACK, code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256', state: 'st' },
    }),
  );
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

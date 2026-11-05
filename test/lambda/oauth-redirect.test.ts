// OAuth AS for redirect IMs: well-known, DCR, authorize, callback, token, refresh, router.
import { GetSecretValueCommand, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { callback } from '../../lambda/oauth/callback';
import { resetAdapter } from '../../lambda/oauth/context';
import { handler } from '../../lambda/oauth/index';
import { getLambdaAdapter, type RedirectAdapter } from '../../lambda/shared/adapters';
import type { HttpResult } from '../../lambda/shared/http';
import * as store from '../../lambda/shared/store';
import { mintIncrToken, pkceS256, signClientId, verifyAccessToken } from '../../lambda/shared/tokens';
import {
  BASE,
  configureApp,
  ddbMock,
  emfLines,
  ev,
  fakeFetch,
  installFakes,
  jsonResp,
  KEYS,
  PREFIX,
  secrets,
  setEnv,
  smMock,
  ssmMock,
  table,
  USER_A,
} from './helpers';

const VERIFIER = 'v'.repeat(50);
const CHALLENGE = pkceS256(VERIFIER);
const LOOPBACK = 'http://127.0.0.1:33418/callback';

let out: MockInstance<typeof console.log>;
let feishuFetch: ReturnType<typeof fakeFetch>;
let openId = 'ou_alice';

function installFeishu(): void {
  feishuFetch = fakeFetch([
    ['/auth/v3/app_access_token/internal', () => jsonResp(200, { code: 0, app_access_token: 'app-tok', expire: 7200 })],
    ['/authen/v1/oidc/access_token', () => jsonResp(200, { code: 0, data: { access_token: 'u-at', refresh_token: 'u-rt', expires_in: 7200, open_id: openId, scope: 'im:message' } })],
    ['/authen/v1/user_info', () => jsonResp(200, { code: 0, data: { name: 'Alice <script>' } })],
  ]);
  resetAdapter({ fetch: feishuFetch });
}

beforeEach(() => {
  installFakes();
  setEnv('feishu');
  configureApp();
  openId = 'ou_alice';
  installFeishu();
  out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => out.mockRestore());

const body = (r: HttpResult) => JSON.parse(r.body ?? '{}') as Record<string, unknown>;
const loc = (r: HttpResult) => new URL(r.headers!.Location!);

async function registerClient(uris = [LOOPBACK]): Promise<string> {
  const r = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: uris, client_name: 'Test' }) }));
  expect(r.statusCode).toBe(201);
  return body(r).client_id as string;
}

function authorizeQuery(clientId: string, extra: Record<string, string> = {}) {
  return { response_type: 'code', client_id: clientId, redirect_uri: LOOPBACK, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'cs-1', ...extra };
}

async function fullLogin(clientId: string): Promise<{ code: string; state: string }> {
  const a = await handler(ev('GET', '/authorize', { query: authorizeQuery(clientId) }));
  expect(a.statusCode).toBe(302);
  const state = loc(a).searchParams.get('state')!;
  const c = await handler(ev('GET', '/callback', { query: { code: 'im-code', state } }));
  expect(c.statusCode).toBe(302);
  const back = loc(c);
  expect(back.origin + back.pathname).toBe(LOOPBACK);
  expect(back.searchParams.get('state')).toBe('cs-1');
  return { code: back.searchParams.get('code')!, state };
}

const tokenReq = (fields: Record<string, string>, json = false) =>
  handler(
    ev('POST', '/token', {
      headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    }),
  );

describe('well-known', () => {
  it('authorization server metadata', async () => {
    const r = await handler(ev('GET', '/.well-known/oauth-authorization-server'));
    expect(r.statusCode).toBe(200);
    expect(r.headers!['Cache-Control']).toBe('no-store');
    expect(body(r)).toEqual({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp', 'offline_access'],
    });
  });
  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])('PRM at %s', async (p) => {
    const r = await handler(ev('GET', p));
    expect(body(r)).toEqual({ resource: `${BASE}/mcp`, authorization_servers: [BASE], bearer_methods_supported: ['header'], scopes_supported: ['mcp', 'offline_access'] });
  });
  it('wrong method, unknown route, wecom-only route', async () => {
    expect((await handler(ev('POST', '/.well-known/oauth-authorization-server'))).statusCode).toBe(405);
    expect((await handler(ev('POST', '/.well-known/oauth-protected-resource'))).statusCode).toBe(405);
    expect((await handler(ev('GET', '/nope'))).statusCode).toBe(404);
    expect((await handler(ev('GET', '/authorize/status', { query: { flow: 'x' } }))).statusCode).toBe(404);
    expect((await handler(ev('GET', '/register'))).statusCode).toBe(405);
    expect((await handler(ev('GET', '/token'))).statusCode).toBe(405);
    expect((await handler(ev('POST', '/authorize'))).statusCode).toBe(405);
    expect((await handler(ev('POST', '/callback'))).statusCode).toBe(405);
  });
  it('SSM failure → 503 with Retry-After', async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error('throttle'));
    const r = await handler(ev('GET', '/.well-known/oauth-authorization-server'));
    expect(r.statusCode).toBe(503);
    expect(r.headers!['Retry-After']).toBe('2');
  });
});

describe('DCR /register', () => {
  it.each([
    [['http://127.0.0.1:1/cb'], 201],
    [['http://localhost:65000/cb'], 201],
    [['https://quicksight.aws.amazon.com/sn/oauthcallback'], 201],
    [['https://eu-west-1.quicksight.aws.amazon.com/cb'], 201],
    [['https://corp.example.com/cb'], 400],
    [['cursor://callback'], 400],
    [['http://example.com/cb'], 400],
  ])('%j → %i', async (uris, status) => {
    const r = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: uris }) }));
    expect(r.statusCode).toBe(status);
    if (status === 400) expect(body(r).error).toBe('invalid_redirect_uri');
  });
  it('extra host + wildcard via env', async () => {
    process.env.EXTRA_REDIRECT_HOSTS = 'corp.example.com,*.apps.example.com';
    for (const u of ['https://corp.example.com/cb', 'https://x.apps.example.com/cb']) {
      expect((await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [u] }) }))).statusCode).toBe(201);
    }
    expect((await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: ['https://apps.example.com/cb'] }) }))).statusCode).toBe(400);
  });
  it('Quick hosts are not allowed when QUICK_REDIRECT_HOSTS is empty (aws-cn)', async () => {
    process.env.QUICK_REDIRECT_HOSTS = '';
    const r = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: ['https://quicksight.aws.amazon.com/cb'] }) }));
    expect(r.statusCode).toBe(400);
  });
  it('response shape', async () => {
    const r = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [LOOPBACK], client_name: 'Kiro' }), base64: true }));
    expect(body(r)).toMatchObject({
      client_name: 'Kiro',
      redirect_uris: [LOOPBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(String(body(r).client_id)).toMatch(/^c1\./);
  });
  it.each([
    ['not json'],
    ['[]'],
    ['{}'],
    [JSON.stringify({ redirect_uris: [] })],
    [JSON.stringify({ redirect_uris: ['a', 'b', 'c', 'd', 'e', 'f'] })],
    [JSON.stringify({ redirect_uris: [1] })],
    ['x'.repeat(9000)],
  ])('invalid metadata %#', async (b) => {
    const r = await handler(ev('POST', '/register', { body: b }));
    expect(r.statusCode).toBe(400);
    expect(body(r).error).toBe('invalid_client_metadata');
  });
  it('overlong redirect uri', async () => {
    const r = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [`http://127.0.0.1/${'a'.repeat(2001)}`] }) }));
    expect(body(r).error).toBe('invalid_redirect_uri');
  });
});

describe('GET /authorize (client flow) validation order', () => {
  it('response_type first, as HTML (never a redirect)', async () => {
    const cid = await registerClient();
    const r = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid, { response_type: 'token' }) }));
    expect(r.statusCode).toBe(400);
    expect(r.headers!['Content-Type']).toContain('text/html');
    expect(r.headers!.Location).toBeUndefined();
  });
  it('unknown client_id → HTML', async () => {
    const r = await handler(ev('GET', '/authorize', { query: authorizeQuery('c1.bogus.sig') }));
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('not registered');
    const r2 = await handler(ev('GET', '/authorize', { query: { response_type: 'code' } }));
    expect(r2.statusCode).toBe(400);
  });
  it('redirect_uri not registered for the client → HTML', async () => {
    const cid = await registerClient();
    const r = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid, { redirect_uri: 'http://127.0.0.1:1/other' }) }));
    expect(r.statusCode).toBe(400);
    expect(r.headers!['Content-Type']).toContain('text/html');
  });
  it('loopback port may differ from registration', async () => {
    const cid = await registerClient();
    const r = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid, { redirect_uri: 'http://127.0.0.1:5555/callback' }) }));
    expect(r.statusCode).toBe(302);
  });
  it('a stale client whose host is no longer allowed is rejected', async () => {
    const cid = signClientId(KEYS, ['https://old.example.com/cb']);
    const r = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid, { redirect_uri: 'https://old.example.com/cb' }) }));
    expect(r.statusCode).toBe(400);
  });
  it('PKCE errors go back to the client with state', async () => {
    const cid = await registerClient();
    for (const extra of [{ code_challenge: '' }, { code_challenge_method: 'plain' }, { state: 's'.repeat(2000) }] as Record<string, string>[]) {
      const r = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid, extra) }));
      expect(r.statusCode).toBe(302);
      const u = loc(r);
      expect(u.origin).toBe('http://127.0.0.1:33418');
      expect(u.searchParams.get('error')).toBe('invalid_request');
    }
  });
  it('success: flow stored and 302 to the Feishu authorize URL', async () => {
    const cid = await registerClient();
    const r = await handler(ev('GET', '/authorize', { query: { ...authorizeQuery(cid), scope: 'mcp', resource: `${BASE}/mcp` } }));
    const u = loc(r);
    expect(u.host).toBe('accounts.feishu.cn');
    expect(u.pathname).toBe('/open-apis/authen/v1/authorize');
    expect(u.searchParams.get('client_id')).toBe('cli_test00000001');
    expect(u.searchParams.get('redirect_uri')).toBe(`${BASE}/callback`);
    expect(u.searchParams.get('scope')).toBe('offline_access im:message');
    const state = u.searchParams.get('state')!;
    expect(await store.getFlow(state)).toMatchObject({ kind: 'redirect', clientId: cid, redirectUri: LOOPBACK, clientState: 'cs-1', codeChallenge: CHALLENGE });
  });
  it('app id falls back to the im-app secret when IM_APP_ID is unset', async () => {
    delete process.env.IM_APP_ID;
    configureApp('cli_fromsecret01');
    const cid = await registerClient();
    const r = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    expect(loc(r).searchParams.get('client_id')).toBe('cli_fromsecret01');
  });
  it('Accept-Language zh renders the Chinese page', async () => {
    const r = await handler(ev('GET', '/authorize', { query: { response_type: 'x' }, headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5' } }));
    expect(r.body).toContain('lang="zh-CN"');
    const r2 = await handler(ev('GET', '/authorize', { query: { response_type: 'x' }, headers: { 'Accept-Language': 'fr, zh;q=0' } }));
    expect(r2.body).toContain('lang="en"');
  });
});

describe('GET /authorize?t= (incremental)', () => {
  it('valid t + extra_scope → 302 with union of scopes', async () => {
    const t = mintIncrToken(KEYS, USER_A);
    const r = await handler(ev('GET', '/authorize', { query: { t, extra_scope: 'calendar:calendar,im:message' } }));
    expect(r.statusCode).toBe(302);
    const u = loc(r);
    expect(u.searchParams.get('scope')).toBe('offline_access im:message calendar:calendar');
    expect(await store.getFlow(u.searchParams.get('state')!)).toMatchObject({ kind: 'incremental', userId: USER_A });
  });
  it('invalid t, bad scope, t + redirect_uri', async () => {
    expect((await handler(ev('GET', '/authorize', { query: { t: 'bogus' } }))).statusCode).toBe(400);
    const t = mintIncrToken(KEYS, USER_A);
    expect((await handler(ev('GET', '/authorize', { query: { t, extra_scope: 'Bad Scope' } }))).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `s${i}x`).join(',');
    expect((await handler(ev('GET', '/authorize', { query: { t, extra_scope: many } }))).statusCode).toBe(400);
    expect((await handler(ev('GET', '/authorize', { query: { t, redirect_uri: LOOPBACK } }))).statusCode).toBe(400);
  });
});

describe('GET /callback', () => {
  it('new user: identity + user created, credential stored on CMK, code issued', async () => {
    const cid = await registerClient();
    await fullLogin(cid);
    const ident = table.get('ident#feishu#ou_alice')!;
    const userId = ident.userId!.S!;
    expect(table.get(`user#${userId}`)).toBeDefined();
    const s = secrets.get(`${PREFIX}/${userId}`)!;
    expect(JSON.parse(s.value!)).toMatchObject({ accessToken: 'u-at', refreshToken: 'u-rt', im: 'feishu', imUid: 'ou_alice' });
    expect(s.kms).toBeDefined();
    const exch = feishuFetch.calls.find((c) => c.url.includes('oidc/access_token'))!;
    expect((exch.init.headers as Record<string, string>).Authorization).toBe('Bearer app-tok');
    // no token or code values in logs
    const logs = out.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).not.toContain('u-at');
    expect(logs).not.toContain('app-secret-value');
    expect(logs).not.toContain(userId);
  });
  it('existing identity reuses the userId', async () => {
    const cid = await registerClient();
    await fullLogin(cid);
    const u1 = table.get('ident#feishu#ou_alice')!.userId!.S!;
    await fullLogin(cid);
    expect(table.get('ident#feishu#ou_alice')!.userId!.S!).toBe(u1);
    expect([...secrets.keys()].filter((k) => k.startsWith(PREFIX))).toHaveLength(1);
  });
  it('missing / expired / replayed state → 400 HTML', async () => {
    expect((await handler(ev('GET', '/callback', { query: { code: 'x' } }))).statusCode).toBe(400);
    expect((await handler(ev('GET', '/callback', { query: { code: 'x', state: 'f'.repeat(32) } }))).body).toContain('expired');
    const cid = await registerClient();
    const { state } = await fullLogin(cid);
    expect((await handler(ev('GET', '/callback', { query: { code: 'im-code', state } }))).statusCode).toBe(400);
  });
  it('user denied consent → access_denied back to the client', async () => {
    const cid = await registerClient();
    const a = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    const state = loc(a).searchParams.get('state')!;
    const r = await handler(ev('GET', '/callback', { query: { state, error: 'access_denied' } }));
    expect(loc(r).searchParams.get('error')).toBe('access_denied');
    expect(loc(r).searchParams.get('state')).toBe('cs-1');
  });
  it('incremental: same identity → 200 success page with escaped display name', async () => {
    const cid = await registerClient();
    await fullLogin(cid);
    const userId = table.get('ident#feishu#ou_alice')!.userId!.S!;
    const a = await handler(ev('GET', '/authorize', { query: { t: mintIncrToken(KEYS, userId) } }));
    const r = await handler(ev('GET', '/callback', { query: { code: 'c2', state: loc(a).searchParams.get('state')! } }));
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Alice &lt;script&gt;');
    expect(r.body).not.toContain('<script>');
    expect(r.headers!['Content-Security-Policy']).toMatch(/default-src 'none'; style-src 'nonce-[^']+'/);
  });
  it('incremental: decline → HTML; mismatch → 403 identity_mismatch', async () => {
    const a0 = await handler(ev('GET', '/authorize', { query: { t: mintIncrToken(KEYS, USER_A) } }));
    expect((await handler(ev('GET', '/callback', { query: { state: loc(a0).searchParams.get('state')! } }))).statusCode).toBe(400);
    const a = await handler(ev('GET', '/authorize', { query: { t: mintIncrToken(KEYS, USER_A) } }));
    const r = await handler(ev('GET', '/callback', { query: { code: 'c', state: loc(a).searchParams.get('state')! } }));
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('does not match');
    expect([...secrets.keys()].filter((k) => k.startsWith(PREFIX))).toHaveLength(0);
  });
  it('disabled user → 403 access revoked', async () => {
    const cid = await registerClient();
    await fullLogin(cid);
    const userId = table.get('ident#feishu#ou_alice')!.userId!.S!;
    await store.disableUser(userId);
    const a = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    const r = await handler(ev('GET', '/callback', { query: { code: 'c', state: loc(a).searchParams.get('state')! } }));
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('revoked');
  });
  it('store failure after 3 attempts → 500 + TokenStoreFailed EMF', async () => {
    const cid = await registerClient();
    const a = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    smMock.on(CreateSecretCommand).rejects(new Error('kms down'));
    const sleep = vi.fn(async () => undefined);
    const adapter = getLambdaAdapter('feishu', { fetch: feishuFetch }) as RedirectAdapter;
    const r = await callback(ev('GET', '/callback', { query: { code: 'c', state: loc(a).searchParams.get('state')! } }), adapter, { sleep });
    expect(r.statusCode).toBe(500);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(smMock.commandCalls(CreateSecretCommand)).toHaveLength(3);
    expect(emfLines(out)).toEqual(['TokenStoreFailed']);
  });
  it('store succeeds on retry', async () => {
    const cid = await registerClient();
    const a = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    smMock.on(CreateSecretCommand).rejectsOnce(new Error('blip')).callsFake((i: { Name: string; SecretString: string }) => {
      secrets.set(i.Name, { value: i.SecretString, tags: {} });
      return {};
    });
    const adapter = getLambdaAdapter('feishu', { fetch: feishuFetch }) as RedirectAdapter;
    const r = await callback(ev('GET', '/callback', { query: { code: 'c', state: loc(a).searchParams.get('state')! } }), adapter, { sleep: async () => undefined });
    expect(r.statusCode).toBe(302);
  });
  it('IM exchange failure → 502 HTML; app not configured → 500 HTML', async () => {
    const cid = await registerClient();
    const a = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    resetAdapter({ fetch: fakeFetch([['', () => new Response('<html>blocked</html>', { status: 403 })]]) });
    const r = await handler(ev('GET', '/callback', { query: { code: 'c', state: loc(a).searchParams.get('state')! } }));
    expect(r.statusCode).toBe(502);
    expect(r.headers!['Content-Type']).toContain('text/html');

    installFeishu();
    const a2 = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    secrets.set('team-a/im-app', { value: JSON.stringify({ configured: false, appSecret: 'x' }), tags: {} });
    const { resetAppSecretCache } = await import('../../lambda/shared/app-secret');
    resetAppSecretCache();
    const r2 = await handler(ev('GET', '/callback', { query: { code: 'c', state: loc(a2).searchParams.get('state')! } }));
    expect(r2.statusCode).toBe(500);
    expect(r2.body).toContain('secret:set-im-app');
  });
  it('unexpected errors become a 500 HTML page / JSON', async () => {
    const cid = await registerClient();
    const a = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    ddbMock.on(PutItemCommand).rejects(new Error('ddb down'));
    const r = await handler(ev('GET', '/callback', { query: { code: 'c', state: loc(a).searchParams.get('state')! } }));
    expect(r.statusCode).toBe(500);
    expect(r.headers!['Content-Type']).toContain('text/html');
    const r2 = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [LOOPBACK] }) }));
    expect(r2.statusCode).toBe(201); // DCR is stateless
  });
  it('root key unavailable on an HTML route → 503 page', async () => {
    smMock.on(GetSecretValueCommand).rejects(new Error('throttle'));
    const r = await handler(ev('GET', '/authorize', { query: { t: 'x' } }));
    expect(r.statusCode).toBe(503);
    expect(r.headers!['Content-Type']).toContain('text/html');
  });
  it('authorize with a placeholder app secret and no IM_APP_ID → 500 page', async () => {
    delete process.env.IM_APP_ID;
    secrets.set('team-a/im-app', { value: JSON.stringify({ configured: false, appSecret: 'x' }), tags: {} });
    const cid = await registerClient();
    const r = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    expect(r.statusCode).toBe(500);
    expect(r.body).toContain('secret:set-im-app');
  });
});

describe('POST /token', () => {
  async function codeFor(): Promise<{ cid: string; code: string }> {
    const cid = await registerClient();
    const { code } = await fullLogin(cid);
    return { cid, code };
  }
  const exchange = (cid: string, code: string, o: Record<string, string> = {}) =>
    tokenReq({ grant_type: 'authorization_code', client_id: cid, code, redirect_uri: LOOPBACK, code_verifier: VERIFIER, ...o });

  it('authorization_code + PKCE → token pair; lastLoginAt updated', async () => {
    const { cid, code } = await codeFor();
    const r = await exchange(cid, code);
    expect(r.statusCode).toBe(200);
    const b = body(r);
    expect(b).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp offline_access' });
    expect(String(b.refresh_token)).toMatch(/^r1\./);
    const v = verifyAccessToken(KEYS, String(b.access_token));
    expect(v?.userId).toBe(table.get('ident#feishu#ou_alice')!.userId!.S);
    expect(r.headers!['Cache-Control']).toBe('no-store');
  });
  it('JSON body accepted', async () => {
    const { cid, code } = await codeFor();
    const r = await tokenReq({ grant_type: 'authorization_code', client_id: cid, code, redirect_uri: LOOPBACK, code_verifier: VERIFIER }, true);
    expect(r.statusCode).toBe(200);
  });
  it('code replay → invalid_grant', async () => {
    const { cid, code } = await codeFor();
    expect((await exchange(cid, code)).statusCode).toBe(200);
    const r = await exchange(cid, code);
    expect(r.statusCode).toBe(400);
    expect(body(r).error).toBe('invalid_grant');
  });
  it('PKCE mismatch / redirect mismatch / other client / bad client', async () => {
    const a = await codeFor();
    expect(body(await exchange(a.cid, a.code, { code_verifier: 'w'.repeat(50) })).error).toBe('invalid_grant');
    const b = await codeFor();
    expect(body(await exchange(b.cid, b.code, { redirect_uri: 'http://127.0.0.1:1/other' })).error).toBe('invalid_grant');
    const c = await codeFor();
    const other = await registerClient();
    expect(body(await exchange(other, c.code)).error).toBe('invalid_grant');
    const r = await exchange('c1.nope.nope', 'x');
    expect(r.statusCode).toBe(401);
    expect(body(r).error).toBe('invalid_client');
  });
  it('loopback redirect at /token may use another port', async () => {
    const { cid, code } = await codeFor();
    expect((await exchange(cid, code, { redirect_uri: 'http://127.0.0.1:9999/callback' })).statusCode).toBe(200);
  });
  it('missing fields → invalid_request', async () => {
    const cid = await registerClient();
    expect(body(await tokenReq({ grant_type: 'authorization_code', client_id: cid })).error).toBe('invalid_request');
    expect(body(await exchange(cid, 'x', { code_verifier: 'short' })).error).toBe('invalid_request');
    expect(body(await tokenReq({})).error).toBe('invalid_request');
    expect(body(await tokenReq({ grant_type: 'password' })).error).toBe('unsupported_grant_type');
  });
  it('disabled user cannot exchange', async () => {
    const { cid, code } = await codeFor();
    await store.disableUser(table.get('ident#feishu#ou_alice')!.userId!.S!);
    expect(body(await exchange(cid, code)).error).toBe('invalid_grant');
  });

  it('refresh rotation; replay revokes the whole family', async () => {
    const { cid, code } = await codeFor();
    const rt1 = String(body(await exchange(cid, code)).refresh_token);
    const r2 = await tokenReq({ grant_type: 'refresh_token', refresh_token: rt1, client_id: cid });
    expect(r2.statusCode).toBe(200);
    const rt2 = String(body(r2).refresh_token);
    expect(rt2).not.toBe(rt1);
    // replay of rt1
    const replay = await tokenReq({ grant_type: 'refresh_token', refresh_token: rt1, client_id: cid });
    expect(body(replay)).toMatchObject({ error: 'invalid_grant', error_description: 'refresh_token reuse detected' });
    // rt2 is now dead too
    expect(body(await tokenReq({ grant_type: 'refresh_token', refresh_token: rt2, client_id: cid })).error).toBe('invalid_grant');
  });
  it('refresh: wrong client, bad token, disabled user', async () => {
    const { cid, code } = await codeFor();
    const rt = String(body(await exchange(cid, code)).refresh_token);
    const other = await registerClient();
    expect(body(await tokenReq({ grant_type: 'refresh_token', refresh_token: rt, client_id: other })).error).toBe('invalid_grant');
    expect(body(await tokenReq({ grant_type: 'refresh_token', refresh_token: 'nope', client_id: cid })).error).toBe('invalid_grant');
    expect((await tokenReq({ grant_type: 'refresh_token', refresh_token: 'r1.x', client_id: 'bad' })).statusCode).toBe(401);
    const second = await codeFor();
    const rt2 = String(body(await exchange(second.cid, second.code)).refresh_token);
    await store.disableUser(table.get('ident#feishu#ou_alice')!.userId!.S!);
    expect(body(await tokenReq({ grant_type: 'refresh_token', refresh_token: rt2, client_id: second.cid })).error).toBe('invalid_grant');
  });
});

describe('confidential clients (manual registration, e.g. Amazon Quick form)', () => {
  async function confidential(method: string): Promise<{ cid: string; secret: string }> {
    const r = await handler(
      ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [LOOPBACK], token_endpoint_auth_method: method }) }),
    );
    expect(r.statusCode).toBe(201);
    const b = body(r);
    expect(b.token_endpoint_auth_method).toBe(method);
    expect(b.client_secret_expires_at).toBe(0);
    return { cid: String(b.client_id), secret: String(b.client_secret) };
  }
  const exchange = (f: Record<string, string>, headers: Record<string, string> = {}) =>
    handler(
      ev('POST', '/token', {
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(f).toString(),
      }),
    );
  const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

  it('public registration returns no secret', async () => {
    const r = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [LOOPBACK] }) }));
    expect(body(r).client_secret).toBeUndefined();
    expect(body(r).token_endpoint_auth_method).toBe('none');
  });
  it('unknown auth method → invalid_client_metadata', async () => {
    const r = await handler(ev('POST', '/register', { body: JSON.stringify({ redirect_uris: [LOOPBACK], token_endpoint_auth_method: 'private_key_jwt' }) }));
    expect(body(r).error).toBe('invalid_client_metadata');
  });
  it('client_secret_post: right secret → tokens; refresh also checks it', async () => {
    const { cid, secret } = await confidential('client_secret_post');
    const { code } = await fullLogin(cid);
    const r = await exchange({ grant_type: 'authorization_code', client_id: cid, client_secret: secret, code, redirect_uri: LOOPBACK, code_verifier: VERIFIER });
    expect(r.statusCode).toBe(200);
    const rt = String(body(r).refresh_token);
    expect((await exchange({ grant_type: 'refresh_token', client_id: cid, client_secret: 'wrong', refresh_token: rt })).statusCode).toBe(401);
    expect((await exchange({ grant_type: 'refresh_token', client_id: cid, client_secret: secret, refresh_token: rt })).statusCode).toBe(200);
  });
  it('client_secret_basic: right secret → tokens; wrong secret → 401; mismatched body client_id → 401', async () => {
    const { cid, secret } = await confidential('client_secret_basic');
    const { code } = await fullLogin(cid);
    const f = { grant_type: 'authorization_code', code, redirect_uri: LOOPBACK, code_verifier: VERIFIER };
    expect((await exchange(f, { Authorization: basic(cid, 'nope') })).statusCode).toBe(401);
    const other = await registerClient();
    expect((await exchange({ ...f, client_id: other }, { Authorization: basic(cid, secret) })).statusCode).toBe(401);
    expect((await exchange(f, { Authorization: basic(cid, secret) })).statusCode).toBe(200);
  });
  it('a secret from another client is rejected', async () => {
    const a = await confidential('client_secret_post');
    const b = await confidential('client_secret_post');
    const { code } = await fullLogin(a.cid);
    const r = await exchange({ grant_type: 'authorization_code', client_id: a.cid, client_secret: b.secret, code, redirect_uri: LOOPBACK, code_verifier: VERIFIER });
    expect(body(r).error).toBe('invalid_client');
  });
});

describe('dingtalk authorize URL (no PKCE upstream)', () => {
  it('302s to login.dingtalk.com with prompt=consent', async () => {
    setEnv('dingtalk');
    configureApp('dingclientid0001');
    resetAdapter();
    const cid = await registerClient();
    const r = await handler(ev('GET', '/authorize', { query: authorizeQuery(cid) }));
    const u = loc(r);
    expect(u.host).toBe('login.dingtalk.com');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toBe('openid corpid');
    expect(u.searchParams.has('code_challenge')).toBe(false);
  });
});


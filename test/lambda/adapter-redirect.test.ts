import { describe, expect, it } from 'vitest';
import { getLambdaAdapter, ImUpstreamError, type RedirectAdapter } from '../../lambda/shared/adapters';
import { fakeFetch, jsonResp } from './helpers';

const NOW_MS = 1_800_000_000_000;
const app = { appId: 'cli_x', appSecret: 's' };
const now = () => NOW_MS;

const feishu = (f: typeof fetch, brand: 'feishu' | 'lark' = 'feishu') => getLambdaAdapter(brand, { fetch: f, now }) as RedirectAdapter;
const ding = (f: typeof fetch) => getLambdaAdapter('dingtalk', { fetch: f, now }) as RedirectAdapter;

describe('getLambdaAdapter', () => {
  it('modes per IM', () => {
    expect(getLambdaAdapter('feishu').mode).toBe('redirect');
    expect(getLambdaAdapter('lark').im).toBe('lark');
    expect(getLambdaAdapter('dingtalk').im).toBe('dingtalk');
    expect(getLambdaAdapter('wecom')).toEqual({ mode: 'qr', im: 'wecom' });
  });
});

describe('feishu / lark', () => {
  it.each([
    ['feishu', 'accounts.feishu.cn'],
    ['lark', 'accounts.larksuite.com'],
  ] as const)('%s authorize URL', (brand, host) => {
    const u = new URL(feishu(fakeFetch([]), brand).authorizeUrl({ appId: 'cli_x', callbackUrl: 'https://b/callback', state: 's1', scopes: ['a', 'b:c'] }));
    expect(u.host).toBe(host);
    expect(u.pathname).toBe('/open-apis/authen/v1/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'cli_x', response_type: 'code', redirect_uri: 'https://b/callback', state: 's1', scope: 'a b:c' });
    expect(new URL(feishu(fakeFetch([]), brand).authorizeUrl({ appId: 'x', callbackUrl: 'https://b', state: 's', scopes: [] })).searchParams.has('scope')).toBe(false);
  });

  it('exchange: parses fields, app token cached, display name best effort', async () => {
    const f = fakeFetch([
      ['open.larksuite.com/open-apis/auth/v3/app_access_token/internal', () => jsonResp(200, { code: 0, app_access_token: 'apt' })],
      ['oidc/access_token', () => jsonResp(200, { code: 0, data: { access_token: 'at', refresh_token: 'rt', expires_in: 7200, open_id: 'ou_1', scope: 'x' } })],
      ['user_info', () => jsonResp(200, { code: 0, data: { name: 'Bob' } })],
    ]);
    const a = feishu(f, 'lark');
    const r = await a.exchangeCode({ code: 'c', callbackUrl: 'https://b/callback', app });
    expect(r).toEqual({
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW_MS / 1000 + 7200, issuedAt: NOW_MS / 1000, scope: 'x' },
      identity: { imUid: 'ou_1', displayName: 'Bob' },
    });
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ app_id: 'cli_x', app_secret: 's' });
    expect(JSON.parse(f.calls[1]!.body)).toEqual({ grant_type: 'authorization_code', code: 'c' });
    await a.exchangeCode({ code: 'c2', callbackUrl: 'https://b/callback', app });
    expect(f.calls.filter((c) => c.url.includes('app_access_token'))).toHaveLength(1);
  });

  it('display name failures are ignored', async () => {
    for (const ui of [() => jsonResp(200, { code: 1 }), () => { throw new Error('net'); }]) {
      const f = fakeFetch([
        ['app_access_token', () => jsonResp(200, { code: 0, app_access_token: 'apt' })],
        ['oidc/access_token', () => jsonResp(200, { code: 0, data: { access_token: 'at', expires_in: '60', open_id: 'ou' } })],
        ['user_info', ui],
      ]);
      const r = await feishu(f).exchangeCode({ code: 'c', callbackUrl: 'x', app });
      expect(r.identity).toEqual({ imUid: 'ou', displayName: undefined });
      expect(r.tokens.expiresAt).toBe(NOW_MS / 1000 + 60);
    }
  });

  it.each([
    ['app token rejected', [['app_access_token', () => jsonResp(200, { code: 10003, msg: 'bad secret' })]]],
    ['non-JSON exchange', [['app_access_token', () => jsonResp(200, { code: 0, app_access_token: 'a' })], ['oidc', () => new Response('<html>', { status: 200 })]]],
    ['business error', [['app_access_token', () => jsonResp(200, { code: 0, app_access_token: 'a' })], ['oidc', () => jsonResp(200, { code: 20003 })]]],
    ['missing open_id', [['app_access_token', () => jsonResp(200, { code: 0, app_access_token: 'a' })], ['oidc', () => jsonResp(200, { code: 0, data: { access_token: 'a', expires_in: 1 } })]]],
    ['missing expires_in', [['app_access_token', () => jsonResp(200, { code: 0, app_access_token: 'a' })], ['oidc', () => jsonResp(200, { code: 0, data: { access_token: 'a', open_id: 'o' } })]]],
    ['network error', [['app_access_token', () => { throw new TypeError('fetch failed'); }]]],
    ['JSON array body', [['app_access_token', () => jsonResp(200, [1])]]],
  ] as [string, [string, () => Response][]][])('exchange failure: %s → ImUpstreamError', async (_n, routes) => {
    await expect(feishu(fakeFetch(routes)).exchangeCode({ code: 'c', callbackUrl: 'x', app })).rejects.toBeInstanceOf(ImUpstreamError);
  });

  it('refresh: success, revoked codes, transient', async () => {
    const mk = (resp: () => Response) =>
      feishu(fakeFetch([['app_access_token', () => jsonResp(200, { code: 0, app_access_token: 'a' })], ['refresh_access_token', resp]]));
    expect(await mk(() => jsonResp(200, { code: 0, data: { access_token: 'n', refresh_token: 'r', expires_in: 100 } })).refresh({ refreshToken: 'x', app })).toEqual({
      ok: true,
      tokens: { accessToken: 'n', refreshToken: 'r', expiresAt: NOW_MS / 1000 + 100, issuedAt: NOW_MS / 1000, scope: undefined },
    });
    for (const code of [20016, 20017, 20064]) {
      expect(await mk(() => jsonResp(200, { code })).refresh({ refreshToken: 'x', app })).toEqual({ ok: false, revoked: true, reason: `code=${code}` });
    }
    expect(await mk(() => jsonResp(200, { code: 99991663 })).refresh({ refreshToken: 'x', app })).toMatchObject({ ok: false, revoked: false });
    expect(await mk(() => new Response('oops', { status: 502 })).refresh({ refreshToken: 'x', app })).toEqual({ ok: false, revoked: false, reason: 'code=http_502' });
    expect(await mk(() => jsonResp(200, { code: 0, data: { refresh_token: 'r' } })).refresh({ refreshToken: 'x', app })).toMatchObject({ ok: false, revoked: false });
    expect(await mk(() => { throw new TypeError('x'); }).refresh({ refreshToken: 'x', app })).toMatchObject({ ok: false, revoked: false });
    const noApp = feishu(fakeFetch([['app_access_token', () => jsonResp(200, { code: 1 })]]));
    expect(await noApp.refresh({ refreshToken: 'x', app })).toMatchObject({ ok: false, revoked: false });
  });
});

describe('dingtalk', () => {
  it('authorize URL', () => {
    const u = new URL(ding(fakeFetch([])).authorizeUrl({ appId: 'dingid', callbackUrl: 'https://b/callback', state: 's', scopes: ['openid', 'corpid'] }));
    expect(u.origin + u.pathname).toBe('https://login.dingtalk.com/oauth2/auth');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'dingid', redirect_uri: 'https://b/callback', response_type: 'code', scope: 'openid corpid', state: 's', prompt: 'consent' });
  });

  it.each([
    ['expireIn', { accessToken: 'a', refreshToken: 'r', expireIn: 7200 }],
    ['expiresIn', { accessToken: 'a', refreshToken: 'r', expiresIn: 7200 }],
  ])('exchange accepts %s; identity unionId, nick', async (_n, tok) => {
    const f = fakeFetch([
      ['userAccessToken', () => jsonResp(200, tok)],
      ['contact/users/me', () => jsonResp(200, { unionId: 'u1', openId: 'o1', nick: 'Dee' })],
    ]);
    const r = await ding(f).exchangeCode({ code: 'c', callbackUrl: 'x', app });
    expect(r.tokens).toMatchObject({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW_MS / 1000 + 7200 });
    expect(r.identity).toEqual({ imUid: 'u1', displayName: 'Dee' });
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ clientId: 'cli_x', clientSecret: 's', code: 'c', grantType: 'authorization_code' });
    expect((f.calls[1]!.init.headers as Record<string, string>)['x-acs-dingtalk-access-token']).toBe('a');
  });

  it('identity falls back to openId; missing → error', async () => {
    const mk = (me: unknown, status = 200) =>
      ding(fakeFetch([['userAccessToken', () => jsonResp(200, { accessToken: 'a', expireIn: 1 })], ['users/me', () => jsonResp(status, me)]]));
    expect((await mk({ openId: 'o1' }).exchangeCode({ code: 'c', callbackUrl: 'x', app })).identity.imUid).toBe('o1');
    await expect(mk({}).exchangeCode({ code: 'c', callbackUrl: 'x', app })).rejects.toBeInstanceOf(ImUpstreamError);
    await expect(mk({ unionId: 'u' }, 401).exchangeCode({ code: 'c', callbackUrl: 'x', app })).rejects.toBeInstanceOf(ImUpstreamError);
  });

  it('exchange failures', async () => {
    await expect(ding(fakeFetch([['userAccessToken', () => jsonResp(400, { code: 'invalid' })]])).exchangeCode({ code: 'c', callbackUrl: 'x', app })).rejects.toBeInstanceOf(ImUpstreamError);
    await expect(ding(fakeFetch([['userAccessToken', () => new Response('<html/>')]])).exchangeCode({ code: 'c', callbackUrl: 'x', app })).rejects.toBeInstanceOf(ImUpstreamError);
  });

  it('refresh: success, 4xx revoked, 5xx transient, bad body, network', async () => {
    const mk = (resp: () => Response) => ding(fakeFetch([['userAccessToken', resp]]));
    expect(await mk(() => jsonResp(200, { accessToken: 'n', refreshToken: 'r2', expiresIn: 10 })).refresh({ refreshToken: 'r', app })).toMatchObject({ ok: true, tokens: { accessToken: 'n', refreshToken: 'r2' } });
    expect(await mk(() => jsonResp(400, {})).refresh({ refreshToken: 'r', app })).toEqual({ ok: false, revoked: true, reason: 'http_400' });
    expect(await mk(() => jsonResp(503, {})).refresh({ refreshToken: 'r', app })).toEqual({ ok: false, revoked: false, reason: 'http_503' });
    expect(await mk(() => new Response('x')).refresh({ refreshToken: 'r', app })).toMatchObject({ ok: false, revoked: false });
    expect(await mk(() => { throw new TypeError('net'); }).refresh({ refreshToken: 'r', app })).toMatchObject({ ok: false, revoked: false });
  });

  it('upstream calls carry a timeout signal', async () => {
    const f = fakeFetch([['userAccessToken', () => jsonResp(200, { accessToken: 'n', expiresIn: 10 })]]);
    await ding(f).refresh({ refreshToken: 'r', app });
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

// Feishu / Lark OAuth (v1 OIDC endpoints, as proven in the Lark sample). Brand = im.
import { fetchJson, num, resolveDeps, str } from './common';
import {
  ImUpstreamError,
  type AdapterDeps,
  type ImApp,
  type ImTokenSet,
  type RedirectAdapter,
  type RefreshResult,
  type ResolvedDeps,
} from './types';

const HOSTS = {
  feishu: { accounts: 'accounts.feishu.cn', open: 'open.feishu.cn' },
  lark: { accounts: 'accounts.larksuite.com', open: 'open.larksuite.com' },
} as const;

/** Terminal refresh codes: 20016 revoked, 20017 invalid refresh token, 20064 refresh token expired. */
export const FEISHU_REVOKED_CODES = new Set([20016, 20017, 20064]);
const APP_TOKEN_TTL_MS = 90 * 60 * 1000;

export function createFeishuAdapter(brand: 'feishu' | 'lark', d?: AdapterDeps): RedirectAdapter {
  const deps: ResolvedDeps = resolveDeps(d);
  const host = HOSTS[brand];
  // Promise cache so concurrent callers (refresh runs 5 in parallel) share one request.
  const appTokens = new Map<string, { token: Promise<string>; until: number }>();

  const post = (api: string, path: string, body: unknown, bearer?: string) =>
    fetchJson(deps, api, `https://${host.open}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });

  async function fetchAppToken(app: ImApp): Promise<string> {
    const r = await post('app_access_token', '/open-apis/auth/v3/app_access_token/internal', {
      app_id: app.appId,
      app_secret: app.appSecret,
    });
    const token = str(r.body?.app_access_token);
    if (!token || r.body?.code !== 0) throw new ImUpstreamError('app_access_token', `code=${String(r.body?.code ?? r.status)}`);
    return token;
  }

  function appAccessToken(app: ImApp): Promise<string> {
    const c = appTokens.get(app.appId);
    if (c && deps.now() < c.until) return c.token;
    const token = fetchAppToken(app);
    appTokens.set(app.appId, { token, until: deps.now() + APP_TOKEN_TTL_MS });
    token.catch(() => appTokens.delete(app.appId));
    return token;
  }

  function toTokens(data: Record<string, unknown>, api: string): ImTokenSet {
    const accessToken = str(data.access_token);
    const expiresIn = num(data.expires_in);
    if (!accessToken || expiresIn === undefined) throw new ImUpstreamError(api, 'missing access_token/expires_in');
    const issuedAt = Math.floor(deps.now() / 1000);
    return { accessToken, refreshToken: str(data.refresh_token), expiresAt: issuedAt + expiresIn, issuedAt, scope: str(data.scope) };
  }

  /** `/authen/v1/user_info`: open_id + name. The OIDC token response no longer always carries open_id. */
  async function userInfo(accessToken: string): Promise<{ openId?: string; name?: string }> {
    try {
      const r = await fetchJson(deps, 'user_info', `https://${host.open}/open-apis/authen/v1/user_info`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = r.body?.data as Record<string, unknown> | undefined;
      return r.body?.code === 0 ? { openId: str(data?.open_id), name: str(data?.name) } : {};
    } catch {
      return {};
    }
  }

  return {
    mode: 'redirect',
    im: brand,
    authorizeUrl({ appId, callbackUrl, state, scopes }) {
      const u = new URL(`https://${host.accounts}/open-apis/authen/v1/authorize`);
      u.searchParams.set('client_id', appId);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', callbackUrl);
      u.searchParams.set('state', state);
      if (scopes.length) u.searchParams.set('scope', scopes.join(' '));
      return u.toString();
    },
    async exchangeCode({ code, app }) {
      const appToken = await appAccessToken(app);
      const r = await post('oidc_access_token', '/open-apis/authen/v1/oidc/access_token', { grant_type: 'authorization_code', code }, appToken);
      const data = r.body?.data as Record<string, unknown> | undefined;
      if (r.body?.code !== 0 || !data) throw new ImUpstreamError('oidc_access_token', `code=${String(r.body?.code ?? r.status)}`);
      const tokens = toTokens(data, 'oidc_access_token');
      const info = await userInfo(tokens.accessToken);
      const imUid = str(data.open_id) ?? info.openId;
      if (!imUid) throw new ImUpstreamError('oidc_access_token', 'missing open_id (token response and user_info)');
      return { tokens, identity: { imUid, displayName: info.name } };
    },
    async refresh({ refreshToken, app }): Promise<RefreshResult> {
      let appToken: string;
      try {
        appToken = await appAccessToken(app);
      } catch (e) {
        return { ok: false, revoked: false, reason: e instanceof Error ? e.message : 'app_access_token failed' };
      }
      let r;
      try {
        r = await post('oidc_refresh', '/open-apis/authen/v1/oidc/refresh_access_token', { grant_type: 'refresh_token', refresh_token: refreshToken }, appToken);
      } catch (e) {
        return { ok: false, revoked: false, reason: e instanceof Error ? e.message : 'network_error' };
      }
      const code = num(r.body?.code);
      const data = r.body?.data as Record<string, unknown> | undefined;
      if (code === 0 && data) {
        try {
          return { ok: true, tokens: toTokens(data, 'oidc_refresh') };
        } catch (e) {
          return { ok: false, revoked: false, reason: (e as Error).message };
        }
      }
      if (code !== undefined && FEISHU_REVOKED_CODES.has(code)) return { ok: false, revoked: true, reason: `code=${code}` };
      return { ok: false, revoked: false, reason: `code=${String(code ?? `http_${r.status}`)}` };
    },
  };
}

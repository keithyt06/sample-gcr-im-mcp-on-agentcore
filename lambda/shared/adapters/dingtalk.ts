// DingTalk OAuth (ported from quick-dingtalk-mcp, MIT (c) Keith Yu). Upstream uses a
// clientSecret exchange with no PKCE, matching dws itself (technical design R13).
import { fetchJson, num, resolveDeps, str } from './common';
import { ImUpstreamError, type AdapterDeps, type ImTokenSet, type RedirectAdapter, type ResolvedDeps } from './types';

const AUTHORIZE_URL = 'https://login.dingtalk.com/oauth2/auth';
const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const USER_ME_URL = 'https://api.dingtalk.com/v1.0/contact/users/me';

export function createDingtalkAdapter(d?: AdapterDeps): RedirectAdapter {
  const deps: ResolvedDeps = resolveDeps(d);

  const postToken = (api: string, body: unknown) =>
    fetchJson(deps, api, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /** Accepts both `expireIn` (older docs) and `expiresIn` (dws parser). */
  function toTokens(b: Record<string, unknown> | null, api: string): ImTokenSet {
    const accessToken = str(b?.accessToken);
    const expiresIn = num(b?.expiresIn ?? b?.expireIn);
    if (!accessToken || expiresIn === undefined) throw new ImUpstreamError(api, 'missing accessToken/expireIn');
    const issuedAt = Math.floor(deps.now() / 1000);
    return { accessToken, refreshToken: str(b?.refreshToken), expiresAt: issuedAt + expiresIn, issuedAt, scope: str(b?.scope) };
  }

  return {
    mode: 'redirect',
    im: 'dingtalk',
    authorizeUrl({ appId, callbackUrl, state, scopes }) {
      const u = new URL(AUTHORIZE_URL);
      u.searchParams.set('client_id', appId);
      u.searchParams.set('redirect_uri', callbackUrl);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', scopes.join(' '));
      u.searchParams.set('state', state);
      u.searchParams.set('prompt', 'consent');
      return u.toString();
    },
    async exchangeCode({ code, app }) {
      const r = await postToken('user_access_token', {
        clientId: app.appId,
        clientSecret: app.appSecret,
        code,
        grantType: 'authorization_code',
      });
      if (r.status >= 400) throw new ImUpstreamError('user_access_token', `http_${r.status}`);
      const tokens = toTokens(r.body, 'user_access_token');
      const me = await fetchJson(deps, 'users_me', USER_ME_URL, {
        method: 'GET',
        headers: { 'x-acs-dingtalk-access-token': tokens.accessToken },
      });
      if (me.status >= 400) throw new ImUpstreamError('users_me', `http_${me.status}`);
      const imUid = str(me.body?.unionId) ?? str(me.body?.openId);
      if (!imUid) throw new ImUpstreamError('users_me', 'missing unionId/openId');
      return { tokens, identity: { imUid, displayName: str(me.body?.nick) } };
    },
    async refresh({ refreshToken, app }) {
      let r;
      try {
        r = await postToken('refresh_token', {
          clientId: app.appId,
          clientSecret: app.appSecret,
          refreshToken,
          grantType: 'refresh_token',
        });
      } catch (e) {
        return { ok: false, revoked: false, reason: e instanceof Error ? e.message : 'network_error' };
      }
      if (r.status >= 400 && r.status < 500) return { ok: false, revoked: true, reason: `http_${r.status}` };
      if (r.status >= 500) return { ok: false, revoked: false, reason: `http_${r.status}` };
      try {
        return { ok: true, tokens: toTokens(r.body, 'refresh_token') };
      } catch (e) {
        return { ok: false, revoked: false, reason: (e as Error).message };
      }
    },
  };
}

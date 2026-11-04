// POST /token: authorization_code (+ PKCE S256) and rotating refresh_token grants (§4.4).
import { formOrJson, json, type HttpEvent, type HttpResult } from '../shared/http';
import { loadKeys } from '../shared/keys';
import { hashUserId, log } from '../shared/log';
import { redirectMatches } from '../shared/redirects';
import { consumeCode, consumeRefresh, getUser, putRefresh, touchUser } from '../shared/store';
import { ACCESS_TTL_SEC, mintAccessToken, newRefreshToken, newState, pkceS256, safeEqual, verifyClientId, type Keys } from '../shared/tokens';

type OAuthError = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type';

const err = (error: OAuthError, description: string): HttpResult =>
  json(error === 'invalid_client' ? 401 : 400, { error, error_description: description }, { Pragma: 'no-cache' });

async function issue(keys: Keys, userId: string, clientId: string, family: string | undefined): Promise<HttpResult> {
  const refreshToken = newRefreshToken();
  await putRefresh(refreshToken, { userId, clientId, family: family ?? newState() }, family === undefined);
  return json(
    200,
    { access_token: mintAccessToken(keys, userId), token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refreshToken, scope: 'mcp' },
    { Pragma: 'no-cache' },
  );
}

export async function token(event: HttpEvent): Promise<HttpResult> {
  const f = formOrJson(event);
  const keys = await loadKeys();

  if (f.grant_type === 'authorization_code') {
    if (!f.client_id || !verifyClientId(keys, f.client_id)) return err('invalid_client', 'unknown client_id');
    if (!f.code || !f.redirect_uri) return err('invalid_request', 'code and redirect_uri are required');
    if (!f.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier)) return err('invalid_request', 'code_verifier must be 43-128 chars');
    const rec = await consumeCode(f.code);
    if (!rec) return err('invalid_grant', 'invalid or expired code');
    if (!safeEqual(rec.clientId, f.client_id)) return err('invalid_grant', 'code was issued to another client');
    if (!redirectMatches(f.redirect_uri, rec.redirectUri)) return err('invalid_grant', 'redirect_uri mismatch');
    if (!safeEqual(pkceS256(f.code_verifier), rec.codeChallenge)) return err('invalid_grant', 'code_verifier mismatch');
    const user = await getUser(rec.userId);
    if (user?.disabled) return err('invalid_grant', 'access revoked');
    await touchUser(rec.userId);
    log('INFO', 'token_issued', { userIdHash: hashUserId(rec.userId), grant: 'authorization_code' });
    return issue(keys, rec.userId, f.client_id, undefined);
  }

  if (f.grant_type === 'refresh_token') {
    if (!f.refresh_token || !f.refresh_token.startsWith('r1.')) return err('invalid_grant', 'invalid refresh_token');
    if (!f.client_id || !verifyClientId(keys, f.client_id)) return err('invalid_client', 'unknown client_id');
    const r = await consumeRefresh(f.refresh_token);
    if (!r.ok) {
      if (r.reason === 'replay') log('CRITICAL', 'refresh_token_reuse_detected', { note: 'token family revoked' });
      return err('invalid_grant', r.reason === 'replay' ? 'refresh_token reuse detected' : 'invalid refresh_token');
    }
    if (!safeEqual(r.rec.clientId, f.client_id)) return err('invalid_grant', 'refresh_token was issued to another client');
    const user = await getUser(r.rec.userId);
    if (user?.disabled) return err('invalid_grant', 'access revoked');
    log('INFO', 'token_issued', { userIdHash: hashUserId(r.rec.userId), grant: 'refresh_token' });
    return issue(keys, r.rec.userId, f.client_id, r.rec.family);
  }

  if (!f.grant_type) return err('invalid_request', 'grant_type is required');
  return err('unsupported_grant_type', 'unsupported grant_type');
}

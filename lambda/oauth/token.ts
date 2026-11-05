// POST /token: authorization_code (+ PKCE S256) and rotating refresh_token grants (§4.4).
import { formOrJson, header, json, type HttpEvent, type HttpResult } from '../shared/http';
import { loadKeys } from '../shared/keys';
import { hashUserId, log } from '../shared/log';
import { redirectMatches } from '../shared/redirects';
import { consumeCode, consumeRefresh, getUser, putRefresh, touchUser, userStatus } from '../shared/store';
import { ACCESS_TTL_SEC, clientSecretFor, mintAccessToken, newRefreshToken, newState, pkceS256, safeEqual, verifyClientId, type Keys } from '../shared/tokens';

type OAuthError = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type';

const err = (error: OAuthError, description: string): HttpResult =>
  json(error === 'invalid_client' ? 401 : 400, { error, error_description: description }, { Pragma: 'no-cache' });

async function issue(keys: Keys, userId: string, clientId: string, family: string | undefined): Promise<HttpResult> {
  const refreshToken = newRefreshToken();
  const stored = await putRefresh(refreshToken, { userId, clientId, family: family ?? newState() }, family === undefined);
  if (!stored) return err('invalid_grant', 'refresh_token family revoked');
  return json(
    200,
    { access_token: mintAccessToken(keys, userId), token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refreshToken, scope: 'mcp' },
    { Pragma: 'no-cache' },
  );
}

/** RFC 6749 §2.3.1: client_secret_basic. Values are form-urlencoded inside the Basic credentials. */
function basicCredentials(event: HttpEvent): { id: string; secret: string } | undefined {
  const h = header(event, 'authorization');
  const m = h?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!m) return undefined;
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) return undefined;
  try {
    return { id: decodeURIComponent(raw.slice(0, i).replace(/\+/g, ' ')), secret: decodeURIComponent(raw.slice(i + 1).replace(/\+/g, ' ')) };
  } catch {
    return undefined;
  }
}

/** Public clients send no secret. A presented secret (post or basic) must match, otherwise invalid_client. */
function authenticateClient(keys: Keys, f: Record<string, string>, event: HttpEvent): boolean {
  const basic = basicCredentials(event);
  if (basic) {
    if (f.client_id && f.client_id !== basic.id) return false;
    f.client_id = basic.id;
  }
  if (!f.client_id || !verifyClientId(keys, f.client_id)) return false;
  const secret = basic?.secret ?? f.client_secret;
  return secret === undefined || secret === '' || safeEqual(secret, clientSecretFor(keys, f.client_id));
}

export async function token(event: HttpEvent): Promise<HttpResult> {
  const f = formOrJson(event);
  const keys = await loadKeys();
  if ((f.grant_type === 'authorization_code' || f.grant_type === 'refresh_token') && !authenticateClient(keys, f, event)) {
    return err('invalid_client', 'unknown client_id or bad client_secret');
  }

  if (f.grant_type === 'authorization_code') {
    if (!f.code || !f.redirect_uri) return err('invalid_request', 'code and redirect_uri are required');
    if (!f.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier)) return err('invalid_request', 'code_verifier must be 43-128 chars');
    const rec = await consumeCode(f.code);
    if (!rec) return err('invalid_grant', 'invalid or expired code');
    if (!safeEqual(rec.clientId, f.client_id)) return err('invalid_grant', 'code was issued to another client');
    if (!redirectMatches(f.redirect_uri, rec.redirectUri)) return err('invalid_grant', 'redirect_uri mismatch');
    if (!safeEqual(pkceS256(f.code_verifier), rec.codeChallenge)) return err('invalid_grant', 'code_verifier mismatch');
    const status = userStatus(await getUser(rec.userId));
    if (status !== 'active') return err('invalid_grant', status === 'pending_approval' ? 'pending operator approval' : 'access revoked');
    await touchUser(rec.userId);
    log('INFO', 'token_issued', { userIdHash: hashUserId(rec.userId), grant: 'authorization_code' });
    return issue(keys, rec.userId, f.client_id, undefined);
  }

  if (f.grant_type === 'refresh_token') {
    if (!f.refresh_token || !f.refresh_token.startsWith('r1.')) return err('invalid_grant', 'invalid refresh_token');
    const r = await consumeRefresh(f.refresh_token);
    if (!r.ok) {
      if (r.reason === 'replay') log('CRITICAL', 'refresh_token_reuse_detected', { note: 'token family revoked' });
      return err('invalid_grant', r.reason === 'replay' ? 'refresh_token reuse detected' : 'invalid refresh_token');
    }
    if (!safeEqual(r.rec.clientId, f.client_id)) return err('invalid_grant', 'refresh_token was issued to another client');
    const status = userStatus(await getUser(r.rec.userId));
    if (status !== 'active') return err('invalid_grant', status === 'pending_approval' ? 'pending operator approval' : 'access revoked');
    log('INFO', 'token_issued', { userIdHash: hashUserId(r.rec.userId), grant: 'refresh_token' });
    return issue(keys, r.rec.userId, f.client_id, r.rec.family);
  }

  if (!f.grant_type) return err('invalid_request', 'grant_type is required');
  return err('unsupported_grant_type', 'unsupported grant_type');
}

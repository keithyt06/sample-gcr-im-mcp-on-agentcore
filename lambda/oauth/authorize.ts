// GET /authorize: client flow (PKCE) and the incremental-scope flow (`t=`), technical design §4.4.
import { ENV } from '../../shared/contract';
import type { RedirectAdapter } from '../shared/adapters';
import { loadAppSecret } from '../shared/app-secret';
import { baseUrl } from '../shared/base-url';
import { envOpt } from '../shared/env';
import { query, redirect, type HttpEvent, type HttpResult } from '../shared/http';
import { loadKeys } from '../shared/keys';
import { hashUserId, log } from '../shared/log';
import { isAllowedRedirect, redirectMatches, withParams } from '../shared/redirects';
import { control } from '../shared/runtime-client';
import { putFlow } from '../shared/store';
import { newState, newUserId, verifyClientId, verifyIncrToken } from '../shared/tokens';
import { getAdapter, imScopes, langOf } from './context';
import { errorPage, qrPage } from './pages';

const SCOPE_RE = /^[a-z][a-z0-9_:.-]{1,100}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

export interface AuthStartResult {
  status: 'pending' | 'already_authorized' | string;
  sessionId?: string;
  authorizeUrl?: string;
  qrPngBase64?: string;
  expiresAt?: number;
}

async function appId(): Promise<string> {
  return envOpt(ENV.IM_APP_ID) ?? (await loadAppSecret()).appId;
}

async function toIm(adapter: RedirectAdapter, state: string, scopes: string[]): Promise<HttpResult> {
  const base = await baseUrl();
  return redirect(adapter.authorizeUrl({ appId: await appId(), callbackUrl: `${base}/callback`, state, scopes }));
}

export async function authorize(event: HttpEvent): Promise<HttpResult> {
  const q = query(event);
  const lang = langOf(event);
  const adapter = getAdapter();

  // ---- incremental-scope flow ----
  if (q.t !== undefined) {
    if (q.redirect_uri !== undefined) return errorPage(lang, 'err_invalid_request');
    if (adapter.mode !== 'redirect') return errorPage(lang, 'err_invalid_request');
    const v = verifyIncrToken(await loadKeys(), q.t);
    if (!v) return errorPage(lang, 'err_link_expired');
    const extra = (q.extra_scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (extra.length > 50 || !extra.every((s) => SCOPE_RE.test(s))) return errorPage(lang, 'err_invalid_request');
    const scopes = [...new Set([...imScopes(), ...extra])];
    const state = newState();
    await putFlow(state, { kind: 'incremental', userId: v.userId, scopes });
    log('INFO', 'authorize_incremental', { userIdHash: hashUserId(v.userId), extraScopes: extra.length });
    return toIm(adapter, state, scopes);
  }

  // ---- client flow: errors before redirect_uri is trusted are HTML, never a redirect ----
  if (q.response_type !== 'code') return errorPage(lang, 'err_invalid_request');
  const client = q.client_id ? verifyClientId(await loadKeys(), q.client_id) : null;
  if (!client) return errorPage(lang, 'err_invalid_client');
  const redirectUri = q.redirect_uri;
  if (!redirectUri || !client.redirectUris.some((r) => redirectMatches(redirectUri, r)) || !isAllowedRedirect(redirectUri)) {
    return errorPage(lang, 'err_invalid_redirect_uri');
  }

  const back = (error: string, description: string): HttpResult =>
    redirect(withParams(redirectUri, { error, error_description: description, state: q.state }));
  if (!q.code_challenge || !CHALLENGE_RE.test(q.code_challenge)) return back('invalid_request', 'code_challenge required');
  if (q.code_challenge_method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
  if (q.state !== undefined && q.state.length > 1024) return back('invalid_request', 'state too long');

  const state = newState();
  const common = { clientId: q.client_id, redirectUri, clientState: q.state, codeChallenge: q.code_challenge };

  if (adapter.mode === 'redirect') {
    const scopes = imScopes();
    await putFlow(state, { kind: 'redirect', ...common, scopes });
    return toIm(adapter, state, scopes);
  }

  // ---- wecom: start a QR session in the user's microVM ----
  const userId = newUserId();
  let start: AuthStartResult;
  try {
    start = await control<AuthStartResult>('im/auth.start', {}, userId);
  } catch (e) {
    log('ERROR', 'qr_start_failed', { userIdHash: hashUserId(userId), error: e instanceof Error ? e.message : 'unknown' });
    return errorPage(lang, 'err_upstream', 502);
  }
  if (start.status !== 'pending' || !start.authorizeUrl) {
    log('ERROR', 'qr_start_unexpected', { status: start.status });
    return errorPage(lang, 'err_upstream', 502);
  }
  await putFlow(state, { kind: 'qr', ...common, userId, scopes: [], containerSessionId: start.sessionId });
  log('INFO', 'qr_started', { userIdHash: hashUserId(userId) });
  return qrPage(lang, { flow: state, authorizeUrl: start.authorizeUrl, qrPngBase64: start.qrPngBase64 });
}

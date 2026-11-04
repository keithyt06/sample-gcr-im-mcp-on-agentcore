// GET /callback (redirect IMs): exchange the IM code, resolve the userId, store the
// IM credential, then hand an authorization code back to the client (technical design §4.4).
import { ImUpstreamError, type RedirectAdapter } from '../shared/adapters';
import { AppNotConfiguredError, loadAppSecret } from '../shared/app-secret';
import { baseUrl } from '../shared/base-url';
import { query, redirect, type HttpEvent, type HttpResult } from '../shared/http';
import { hashUserId, log, metric } from '../shared/log';
import { withParams } from '../shared/redirects';
import { consumeFlow, getUser, putCode, resolveIdentity } from '../shared/store';
import { newAuthCode } from '../shared/tokens';
import { putCredential, type StoredCredential } from '../shared/user-secrets';
import { langOf } from './context';
import { errorPage, successPage } from './pages';

const STORE_ATTEMPTS = 3;

export interface CallbackDeps {
  sleep: (ms: number) => Promise<void>;
}
const defaultDeps: CallbackDeps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export async function callback(event: HttpEvent, adapter: RedirectAdapter, deps: CallbackDeps = defaultDeps): Promise<HttpResult> {
  const q = query(event);
  const lang = langOf(event);
  if (!q.state || !/^[0-9a-f]{32}$/.test(q.state)) return errorPage(lang, 'err_link_expired');
  const flow = await consumeFlow(q.state);
  if (!flow) return errorPage(lang, 'err_link_expired');

  if (!q.code) {
    // The user declined at the IM consent screen.
    if (flow.kind === 'redirect' && flow.redirectUri) {
      return redirect(withParams(flow.redirectUri, { error: 'access_denied', state: flow.clientState }));
    }
    return errorPage(lang, 'err_access_denied');
  }

  let result;
  try {
    const app = await loadAppSecret();
    result = await adapter.exchangeCode({ code: q.code, callbackUrl: `${await baseUrl()}/callback`, app });
  } catch (e) {
    if (e instanceof AppNotConfiguredError) return errorPage(lang, 'err_app_not_configured', 500);
    if (e instanceof ImUpstreamError) {
      log('WARN', 'im_exchange_failed', { api: e.api, detail: e.detail });
      return errorPage(lang, 'err_upstream', 502);
    }
    throw e;
  }
  const { tokens, identity } = result;

  const { userId, created } = await resolveIdentity(adapter.im, identity.imUid);
  if (flow.kind === 'incremental' && flow.userId !== userId) {
    log('WARN', 'identity_mismatch', { expectedHash: hashUserId(flow.userId ?? ''), actualHash: hashUserId(userId) });
    return errorPage(lang, 'err_identity_mismatch', 403);
  }
  const user = created ? null : await getUser(userId);
  if (user?.disabled) {
    log('WARN', 'callback_user_disabled', { userIdHash: hashUserId(userId) });
    return errorPage(lang, 'err_access_revoked', 403);
  }

  const cred: StoredCredential = { ...tokens, im: adapter.im, imUid: identity.imUid };
  let stored = false;
  for (let i = 0; i < STORE_ATTEMPTS && !stored; i++) {
    try {
      await putCredential(userId, cred);
      stored = true;
    } catch (e) {
      log('WARN', 'token_store_retry', { userIdHash: hashUserId(userId), attempt: i + 1, error: e instanceof Error ? e.name : 'unknown' });
      if (i < STORE_ATTEMPTS - 1) await deps.sleep(200 * 2 ** i);
    }
  }
  if (!stored) {
    log('ERROR', 'token_store_failed', { userIdHash: hashUserId(userId) });
    metric('TokenStoreFailed');
    return errorPage(lang, 'err_store_failed', 500);
  }
  log('INFO', 'callback_ok', { userIdHash: hashUserId(userId), kind: flow.kind, newUser: created });

  if (flow.kind === 'redirect' && flow.redirectUri && flow.clientId && flow.codeChallenge) {
    const code = newAuthCode();
    await putCode(code, { userId, clientId: flow.clientId, redirectUri: flow.redirectUri, codeChallenge: flow.codeChallenge });
    return redirect(withParams(flow.redirectUri, { code, state: flow.clientState }));
  }
  return successPage(lang, identity.displayName ?? `${userId.slice(0, 8)}...`);
}

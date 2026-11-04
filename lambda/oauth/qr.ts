// GET /authorize/status (wecom QR flow), technical design §4.4. The QR session runs in
// the user's microVM; this endpoint polls it via the `im/auth.status` control RPC.
import { json, query, type HttpEvent, type HttpResult } from '../shared/http';
import { hashUserId, log } from '../shared/log';
import { withParams } from '../shared/redirects';
import { control } from '../shared/runtime-client';
import { deleteFlow, disableUser, getFlow, getIdent, putCode, putUser, setIdent } from '../shared/store';
import { newAuthCode } from '../shared/tokens';
import { deleteCredential, describeCredential } from '../shared/user-secrets';

/** Tag the container sets on `<prefix>/<userId>` with the WeCom user id (read without decrypting). */
export const WECOM_USER_TAG = 'WecomUserId';

export interface AuthStatusResult {
  status: 'pending' | 'authorized' | 'already_authorized' | 'expired' | 'failed' | 'unknown' | string;
  sessionId?: string;
  wecomIdentity?: { userId?: string; userName?: string; botId?: string };
  reason?: string;
}

/**
 * Converges repeated authorizations of the same WeCom person onto the newest slot:
 * the old slot U0 is disabled (replacedBy U1) and its credential is scheduled for deletion.
 */
async function resolveSlot(userId: string, wecomUserId: string | undefined): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (!wecomUserId) {
    log('WARN', 'qr_identity_unknown', { userIdHash: hashUserId(userId) });
    await putUser(userId, { im: 'wecom', createdAt: now, lastLoginAt: now });
    return;
  }
  const prev = await getIdent('wecom', wecomUserId);
  await putUser(userId, { im: 'wecom', imUid: wecomUserId, createdAt: now, lastLoginAt: now });
  if (prev === userId) return;
  await setIdent('wecom', wecomUserId, userId);
  if (prev) {
    await disableUser(prev, userId);
    try {
      await deleteCredential(prev, 7);
    } catch (e) {
      log('WARN', 'qr_old_slot_delete_failed', { userIdHash: hashUserId(prev), error: e instanceof Error ? e.name : 'unknown' });
    }
    log('INFO', 'identity_slot_replaced', { oldHash: hashUserId(prev), newHash: hashUserId(userId) });
  } else {
    log('INFO', 'identity_slot_registered', { userIdHash: hashUserId(userId) });
  }
}

export async function authorizeStatus(event: HttpEvent): Promise<HttpResult> {
  const flowId = query(event).flow;
  if (!flowId || !/^[0-9a-f]{32}$/.test(flowId)) return json(400, { error: 'invalid_request' });
  const flow = await getFlow(flowId);
  if (!flow || flow.kind !== 'qr' || !flow.userId || !flow.redirectUri || !flow.clientId || !flow.codeChallenge) {
    return json(200, { status: 'expired' });
  }
  const userId = flow.userId;

  let st: AuthStatusResult;
  try {
    st = await control<AuthStatusResult>('im/auth.status', { sessionId: flow.containerSessionId }, userId);
  } catch (e) {
    log('WARN', 'qr_status_rpc_failed', { userIdHash: hashUserId(userId), error: e instanceof Error ? e.message : 'unknown' });
    st = { status: 'unknown' };
  }

  let authorized = st.status === 'authorized' || st.status === 'already_authorized';
  let wecomUserId = st.wecomIdentity?.userId;
  if (!authorized || !wecomUserId) {
    // Another microVM may have answered: the credential landing in SM is the source of
    // truth (each flow has a fresh random userId, so the secret can't predate the flow).
    try {
      const info = await describeCredential(userId);
      if (info.exists) {
        if (!authorized) log('INFO', 'qr_confirmed_via_secret', { userIdHash: hashUserId(userId), containerStatus: st.status });
        authorized = true;
        wecomUserId ??= info.tags[WECOM_USER_TAG];
      }
    } catch (e) {
      log('WARN', 'qr_describe_failed', { userIdHash: hashUserId(userId), error: e instanceof Error ? e.name : 'unknown' });
    }
  }
  if (!authorized) {
    const status = ['pending', 'expired', 'failed'].includes(st.status) ? st.status : 'pending';
    return json(200, { status, ...(st.reason ? { reason: st.reason } : {}) });
  }

  await resolveSlot(userId, wecomUserId);
  await deleteFlow(flowId);
  const code = newAuthCode();
  await putCode(code, { userId, clientId: flow.clientId, redirectUri: flow.redirectUri, codeChallenge: flow.codeChallenge });
  log('INFO', 'qr_authorized', { userIdHash: hashUserId(userId) });
  return json(200, { status: 'authorized', redirect: withParams(flow.redirectUri, { code, state: flow.clientState }) });
}

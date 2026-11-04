// MCP proxy Lambda: verifies the MCP bearer, attaches the user's IM credential, and
// forwards the JSON-RPC request to AgentCore Runtime with SigV4 (technical design §4.5).
import { ENV, H } from '../../shared/contract';
import { baseUrl } from '../shared/base-url';
import { env } from '../shared/env';
import {
  BackendUnavailableError,
  bodyBuffer,
  header,
  json,
  method,
  sse,
  type HttpEvent,
  type HttpResult,
} from '../shared/http';
import { loadKeys } from '../shared/keys';
import { hashUserId, log } from '../shared/log';
import { invokeRuntime } from '../shared/runtime-client';
import { mintIncrToken, runtimeSessionId, verifyAccessToken, type Keys } from '../shared/tokens';
import { getCredential, type StoredCredential } from '../shared/user-secrets';

const MAX_BODY = 1024 * 1024;
const USABLE_MARGIN_SEC = 120;
const CRED_TTL_MS = 60_000;
const CRED_MAX = 500;

/** Positive-only cache: a fresh authorization is visible on the very next call. */
const credCache = new Map<string, { cred: StoredCredential; until: number }>();

export function resetCredentialCache(): void {
  credCache.clear();
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const usable = (c: StoredCredential | null): c is StoredCredential => !!c && c.expiresAt - nowSec() > USABLE_MARGIN_SEC;

async function credentialFor(userId: string): Promise<StoredCredential | null> {
  const hit = credCache.get(userId);
  if (hit && Date.now() < hit.until && usable(hit.cred)) return hit.cred;
  credCache.delete(userId);
  const cred = await getCredential(userId);
  if (!usable(cred)) return null;
  if (credCache.size >= CRED_MAX) {
    const oldest = credCache.keys().next().value;
    if (oldest !== undefined) credCache.delete(oldest);
  }
  credCache.set(userId, { cred, until: Date.now() + CRED_TTL_MS });
  return cred;
}

const rpcError = (status: number, code: number, message: string, id: unknown = null): HttpResult =>
  json(status, { jsonrpc: '2.0', id, error: { code, message } });

const unavailable = (): HttpResult => json(503, { error: 'backend_unavailable' }, { 'Retry-After': '2' });

function bearer(event: HttpEvent): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header(event, 'authorization') ?? '');
  return m?.[1];
}

async function handle(event: HttpEvent): Promise<HttpResult> {
  const m = method(event);
  const base = await baseUrl();
  const keys: Keys = await loadKeys();

  const resourceMetadata = `${base}/.well-known/oauth-protected-resource/mcp`;
  const tok = bearer(event);
  if (!tok) {
    return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata}"` });
  }
  const v = verifyAccessToken(keys, tok);
  if (!v) {
    log('WARN', 'mcp_token_invalid');
    return json(
      401,
      { error: 'invalid_token' },
      { 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${resourceMetadata}"` },
    );
  }
  const userId = v.userId;
  const sessionId = runtimeSessionId(keys, userId);

  if (m === 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST, DELETE' });
  if (m === 'DELETE') return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  if (m !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST, DELETE' });

  const raw = bodyBuffer(event);
  if (raw.length > MAX_BODY) return rpcError(413, -32600, 'request too large');
  let msg: unknown;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch {
    return rpcError(400, -32700, 'parse error');
  }
  if (Array.isArray(msg)) return rpcError(400, -32600, 'batch requests are not supported');
  if (!msg || typeof msg !== 'object') return rpcError(400, -32600, 'invalid request');
  const { method: rpcMethod, id } = msg as { method?: unknown; id?: unknown };
  if (typeof rpcMethod !== 'string') {
    // A JSON-RPC response or malformed message; responses (no method) are acknowledged.
    if (id === undefined || 'result' in (msg as object) || 'error' in (msg as object)) return { statusCode: 202, body: '' };
    return rpcError(400, -32600, 'invalid request', id);
  }
  if (rpcMethod.startsWith('im/')) return rpcError(400, -32601, 'method not found', id ?? null);
  if (id === undefined || id === null) return { statusCode: 202, headers: { 'Cache-Control': 'no-store' }, body: '' };

  const needsToken = env(ENV.NEEDS_USER_TOKEN) === 'true';
  const headers: Partial<Record<(typeof H)[keyof typeof H], string>> = {
    [H.requestId]: event.requestContext.requestId ?? '',
    [H.caller]: 'mcp',
  };
  if (needsToken) {
    const authorizeUrl = `${base}/authorize?t=${encodeURIComponent(mintIncrToken(keys, userId))}`;
    headers[H.authorizeUrl] = authorizeUrl;
    const cred = await credentialFor(userId);
    if (cred) headers[H.userToken] = cred.accessToken;
    else if (rpcMethod === 'tools/call') {
      log('INFO', 'im_not_authorized', { userIdHash: hashUserId(userId) });
      const envelope = {
        ok: false,
        error: {
          code: 'im_not_authorized',
          message: 'The IM account for this user is not connected or the authorization has expired.',
          user_action: 'Open authorize_url in a browser to connect your IM account, then retry.',
          authorize_url: authorizeUrl,
        },
      };
      return sse(
        200,
        { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true } },
        { 'Mcp-Session-Id': sessionId },
      );
    }
  }

  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await invokeRuntime({ method: rpcMethod, userId, keys, headers, rawBody: raw });
  } catch (e) {
    const name = e instanceof Error ? e.name : 'unknown';
    log('ERROR', 'runtime_fetch_failed', { userIdHash: hashUserId(userId), error: name, durationMs: Date.now() - t0 });
    if (name === 'TimeoutError' || name === 'AbortError') return json(504, { error: 'upstream_timeout' });
    return json(502, { error: 'upstream_error' });
  }
  const text = await resp.text();
  const durationMs = Date.now() - t0;
  if (resp.status === 429) {
    log('WARN', 'runtime_throttled', { userIdHash: hashUserId(userId), durationMs });
    return json(429, { error: 'too_many_requests' }, { 'Retry-After': '2' });
  }
  if (resp.status >= 400) {
    log('ERROR', 'runtime_error', { userIdHash: hashUserId(userId), status: resp.status, bodyPrefix: text.slice(0, 200), durationMs });
    return json(502, { error: 'upstream_error' });
  }
  log('INFO', 'mcp_ok', { userIdHash: hashUserId(userId), rpcMethod, status: resp.status, durationMs });
  return {
    statusCode: resp.status,
    headers: {
      'Content-Type': resp.headers.get('content-type') ?? 'application/json',
      'Mcp-Session-Id': sessionId,
      'Cache-Control': 'no-store',
    },
    body: text,
  };
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  try {
    return await handle(event);
  } catch (e) {
    if (e instanceof BackendUnavailableError) {
      log('ERROR', 'backend_unavailable', { what: e.message });
      return unavailable();
    }
    throw e;
  }
}

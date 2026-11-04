// RFC 7591 dynamic client registration. Public clients only; the client_id is a
// stateless signed blob binding the registered redirect_uris (technical design §4.2).
import { bodyBuffer, json, type HttpEvent, type HttpResult } from '../shared/http';
import { loadKeys } from '../shared/keys';
import { log } from '../shared/log';
import { isAllowedRedirect } from '../shared/redirects';
import { signClientId } from '../shared/tokens';

const MAX_BODY = 8 * 1024;

const bad = (error: 'invalid_redirect_uri' | 'invalid_client_metadata', description: string): HttpResult =>
  json(400, { error, error_description: description });

export async function register(event: HttpEvent): Promise<HttpResult> {
  const buf = bodyBuffer(event);
  if (buf.length > MAX_BODY) return bad('invalid_client_metadata', 'body too large');
  let body: unknown;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch {
    return bad('invalid_client_metadata', 'body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid_client_metadata', 'body must be a JSON object');
  const { redirect_uris: uris, client_name: name } = body as { redirect_uris?: unknown; client_name?: unknown };
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((u): u is string => typeof u === 'string')) {
    return bad('invalid_client_metadata', 'redirect_uris must be 1-5 strings');
  }
  for (const u of uris) {
    if (u.length > 2000 || !isAllowedRedirect(u)) {
      log('WARN', 'dcr_rejected', { reason: 'redirect_not_allowed' });
      return bad('invalid_redirect_uri', 'redirect_uri is not allowed');
    }
  }
  const clientName = typeof name === 'string' && name.length <= 200 ? name : undefined;
  const now = Math.floor(Date.now() / 1000);
  const clientId = signClientId(await loadKeys(), uris, now);
  log('INFO', 'dcr_registered', { redirectCount: uris.length });
  return json(201, {
    client_id: clientId,
    client_id_issued_at: now,
    ...(clientName ? { client_name: clientName } : {}),
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

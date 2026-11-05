// RFC 8414 authorization server metadata and RFC 9728 protected resource metadata.
import { baseUrl } from '../shared/base-url';
import { json, type HttpResult } from '../shared/http';

// Amazon Quick reads scopes only from these documents (never from the 401 challenge) and falls back to its own
// default scopes when they are missing, which can break registration. `offline_access` signals that a refresh
// token is issued. Layout matches the WeCom reference sample, which is reported to complete DCR with Quick.
export const SCOPES = ['mcp', 'offline_access'];

export async function authServerMetadata(): Promise<HttpResult> {
  const base = await baseUrl();
  return json(200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: SCOPES,
  });
}

export async function protectedResourceMetadata(): Promise<HttpResult> {
  const base = await baseUrl();
  return json(200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPES,
  });
}

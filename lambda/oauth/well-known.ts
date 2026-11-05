// RFC 8414 authorization server metadata and RFC 9728 protected resource metadata.
import { baseUrl } from '../shared/base-url';
import { json, type HttpResult } from '../shared/http';

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
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp'],
  });
}

export async function protectedResourceMetadata(): Promise<HttpResult> {
  const base = await baseUrl();
  return json(200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  });
}

// OAuth 2.1 authorization server Lambda router (API Gateway HTTP API, payload 2.0).
import { AppNotConfiguredError } from '../shared/app-secret';
import { BackendUnavailableError, json, method, type HttpEvent, type HttpResult } from '../shared/http';
import { log } from '../shared/log';
import { authorize } from './authorize';
import { callback } from './callback';
import { getAdapter, langOf } from './context';
import { errorPage } from './pages';
import { authorizeStatus } from './qr';
import { register } from './register';
import { token } from './token';
import { authServerMetadata, protectedResourceMetadata } from './well-known';

const notFound = (): HttpResult => json(404, { error: 'not_found' });
const notAllowed = (): HttpResult => json(405, { error: 'method_not_allowed' });

async function route(event: HttpEvent): Promise<HttpResult> {
  const path = event.rawPath.replace(/\/+$/, '') || '/';
  const m = method(event);
  const get = m === 'GET';

  if (path === '/.well-known/oauth-authorization-server') return get ? authServerMetadata() : notAllowed();
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    return get ? protectedResourceMetadata() : notAllowed();
  }
  if (path === '/register') return m === 'POST' ? register(event) : notAllowed();
  if (path === '/token') return m === 'POST' ? token(event) : notAllowed();
  if (path === '/authorize') return get ? authorize(event) : notAllowed();
  if (path === '/authorize/status') {
    if (getAdapter().mode !== 'qr') return notFound();
    return get ? authorizeStatus(event) : notAllowed();
  }
  if (path === '/callback') {
    const a = getAdapter();
    if (a.mode !== 'redirect') return notFound();
    return get ? callback(event, a) : notAllowed();
  }
  return notFound();
}

const isHtmlRoute = (event: HttpEvent): boolean => /^\/(authorize|callback)\/?$/.test(event.rawPath);

export async function handler(event: HttpEvent): Promise<HttpResult> {
  try {
    return await route(event);
  } catch (e) {
    if (e instanceof BackendUnavailableError) {
      log('ERROR', 'backend_unavailable', { what: e.message });
      if (isHtmlRoute(event)) return errorPage(langOf(event), 'err_server', 503);
      return json(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '2' });
    }
    if (e instanceof AppNotConfiguredError) {
      log('ERROR', 'im_app_not_configured');
      if (isHtmlRoute(event)) return errorPage(langOf(event), 'err_app_not_configured', 500);
      return json(500, { error: 'server_error', error_description: 'im_app_not_configured' });
    }
    log('ERROR', 'oauth_unhandled', { error: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown', path: event.rawPath });
    if (isHtmlRoute(event)) return errorPage(langOf(event), 'err_server', 500);
    return json(500, { error: 'server_error' });
  }
}

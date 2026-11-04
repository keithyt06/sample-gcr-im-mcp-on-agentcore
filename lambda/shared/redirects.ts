// OAuth client redirect_uri allowlist (technical design §4.4).
// (a) loopback http(s)://127.0.0.1 | localhost | [::1], any port (RFC 8252 §7.3);
// (b) https with a host in QUICK_REDIRECT_HOSTS (set by CDK per partition) or EXTRA_REDIRECT_HOSTS.
// `*.x.y` matches strict subdomains of x.y only. No userinfo, no fragment, no custom schemes.
import { ENV } from '../../shared/contract';
import { envList } from './env';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parse(uri: string): URL | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2000) return null;
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

export function isLoopback(u: URL): boolean {
  return LOOPBACK.has(u.hostname.toLowerCase());
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h.length > base.length + 1 && h.endsWith(`.${base}`);
  }
  return h === p;
}

export function allowedHosts(): string[] {
  return [...envList(ENV.QUICK_REDIRECT_HOSTS), ...envList(ENV.EXTRA_REDIRECT_HOSTS)];
}

export function isAllowedRedirect(uri: string, hosts: string[] = allowedHosts()): boolean {
  const u = parse(uri);
  if (!u) return false;
  if (u.username || u.password || u.hash || uri.includes('#')) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (isLoopback(u)) return true;
  if (u.protocol !== 'https:') return false;
  return hosts.some((p) => hostMatches(u.hostname, p));
}

/** Compares a presented redirect_uri to a registered one; loopback ignores the port. */
export function redirectMatches(presented: string, registered: string): boolean {
  if (presented === registered) return true;
  const a = parse(presented);
  const b = parse(registered);
  if (!a || !b || !isLoopback(a) || !isLoopback(b)) return false;
  return (
    a.protocol === b.protocol &&
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}

/** Appends query params to a client redirect_uri. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

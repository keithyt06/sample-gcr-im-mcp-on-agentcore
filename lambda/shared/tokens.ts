// Pure token helpers (technical design §4.2). No I/O. All verification is
// constant-time and returns null on any malformed input; nothing here throws on
// attacker-controlled data.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Keys {
  token: Buffer;
  incr: Buffer;
  dcr: Buffer;
  session: Buffer;
}

export const ACCESS_TTL_SEC = 3600;
export const INCR_TTL_SEC = 600;
export const CODE_TTL_SEC = 120;
export const REFRESH_TTL_SEC = 90 * 24 * 3600;
export const FLOW_TTL_SEC = 600;

const USER_ID_RE = /^[0-9a-f]{32}$/;

const nowSec = (): number => Math.floor(Date.now() / 1000);

export function deriveKeys(root: string): Keys {
  const k = (label: string): Buffer => createHmac('sha256', root).update(label).digest();
  return { token: k('mcp-token-v1'), incr: k('mcp-incr-v1'), dcr: k('dcr-client-v1'), session: k('runtime-session-v1') };
}

export function newUserId(): string {
  return randomBytes(16).toString('hex');
}

/** 32 hex chars; used for OAuth flow `state`. */
export function newState(): string {
  return randomBytes(16).toString('hex');
}

export function newAuthCode(): string {
  return randomBytes(32).toString('base64url');
}

export function newRefreshToken(): string {
  return `r1.${randomBytes(32).toString('base64url')}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Constant-time string compare (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function mintSigned(key: Buffer, userId: string, ttlSec: number, now: number): string {
  const exp = now + ttlSec;
  const payload = `${userId}:${exp}`;
  const sig = createHmac('sha256', key).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function verifySigned(key: Buffer, tok: string, now: number): { userId: string } | null {
  if (typeof tok !== 'string' || tok.length === 0 || tok.length > 512 || !/^[A-Za-z0-9_-]+$/.test(tok)) return null;
  const parts = Buffer.from(tok, 'base64url').toString('utf8').split(':');
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts as [string, string, string];
  if (!USER_ID_RE.test(userId) || !/^\d{1,12}$/.test(expStr) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = createHmac('sha256', key).update(`${userId}:${expStr}`).digest('hex');
  if (!safeEqual(sig, expected)) return null;
  if (now >= Number(expStr)) return null;
  return { userId };
}

export function mintAccessToken(k: Keys, userId: string, ttlSec = ACCESS_TTL_SEC, now = nowSec()): string {
  return mintSigned(k.token, userId, ttlSec, now);
}

export function verifyAccessToken(k: Keys, tok: string, now = nowSec()): { userId: string } | null {
  return verifySigned(k.token, tok, now);
}

export function mintIncrToken(k: Keys, userId: string, now = nowSec()): string {
  return mintSigned(k.incr, userId, INCR_TTL_SEC, now);
}

export function verifyIncrToken(k: Keys, tok: string, now = nowSec()): { userId: string } | null {
  return verifySigned(k.incr, tok, now);
}

export function signClientId(k: Keys, redirectUris: string[], now = nowSec()): string {
  const payload = Buffer.from(
    JSON.stringify({ r: redirectUris, n: randomBytes(4).toString('hex'), iat: now }),
  ).toString('base64url');
  const sig = createHmac('sha256', k.dcr).update(payload).digest('base64url');
  return `c1.${payload}.${sig}`;
}

export function verifyClientId(k: Keys, clientId: string): { redirectUris: string[] } | null {
  if (typeof clientId !== 'string' || clientId.length > 16384) return null;
  const parts = clientId.split('.');
  if (parts.length !== 3 || parts[0] !== 'c1') return null;
  const [, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', k.dcr).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const r = (parsed as { r?: unknown }).r;
    if (!Array.isArray(r) || r.length === 0 || !r.every((u): u is string => typeof u === 'string')) return null;
    return { redirectUris: r };
  } catch {
    return null;
  }
}

/** 'u-' + 64 hex = 66 chars; satisfies the AgentCore session id minimum length (33). */
export function runtimeSessionId(k: Keys, userId: string): string {
  return `u-${createHmac('sha256', k.session).update(userId).digest('hex')}`;
}

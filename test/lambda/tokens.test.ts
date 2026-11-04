import { describe, expect, it } from 'vitest';
import {
  deriveKeys,
  mintAccessToken,
  mintIncrToken,
  newAuthCode,
  newRefreshToken,
  newState,
  newUserId,
  pkceS256,
  runtimeSessionId,
  safeEqual,
  signClientId,
  verifyAccessToken,
  verifyClientId,
  verifyIncrToken,
} from '../../lambda/shared/tokens';
import { USER_A, USER_B } from './helpers';

const k = deriveKeys('root-1');
const k2 = deriveKeys('root-2');
const NOW = 1_800_000_000;

const decode = (t: string) => Buffer.from(t, 'base64url').toString('utf8');
const encode = (s: string) => Buffer.from(s).toString('base64url');

describe('tokens', () => {
  it('derives four distinct domain-separated keys', () => {
    const all = [k.token, k.incr, k.dcr, k.session].map((b) => b.toString('hex'));
    expect(new Set(all).size).toBe(4);
    expect(deriveKeys('root-1').token.equals(k.token)).toBe(true);
  });

  it('access token round-trips and has the documented shape', () => {
    const t = mintAccessToken(k, USER_A, 3600, NOW);
    expect(decode(t)).toMatch(new RegExp(`^${USER_A}:${NOW + 3600}:[0-9a-f]{64}$`));
    expect(verifyAccessToken(k, t, NOW)).toEqual({ userId: USER_A });
    expect(verifyAccessToken(k, t, NOW + 3599)).toEqual({ userId: USER_A });
  });

  it('access token expires', () => {
    const t = mintAccessToken(k, USER_A, 3600, NOW);
    expect(verifyAccessToken(k, t, NOW + 3600)).toBeNull();
  });

  it('default TTL is 1 h and default now is the clock', () => {
    const t = mintAccessToken(k, USER_A);
    expect(verifyAccessToken(k, t)).toEqual({ userId: USER_A });
    const exp = Number(decode(t).split(':')[1]);
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(3590);
  });

  it('rejects tampering of each segment', () => {
    const [u, e, s] = decode(mintAccessToken(k, USER_A, 3600, NOW)).split(':') as [string, string, string];
    expect(verifyAccessToken(k, encode(`${USER_B}:${e}:${s}`), NOW)).toBeNull();
    expect(verifyAccessToken(k, encode(`${u}:${Number(e) + 100}:${s}`), NOW)).toBeNull();
    const flipped = (s[0] === 'a' ? 'b' : 'a') + s.slice(1);
    expect(verifyAccessToken(k, encode(`${u}:${e}:${flipped}`), NOW)).toBeNull();
  });

  it('rejects a token signed by another root key', () => {
    expect(verifyAccessToken(k2, mintAccessToken(k, USER_A, 3600, NOW), NOW)).toBeNull();
  });

  it('cross-domain misuse: access and incr tokens are not interchangeable', () => {
    const a = mintAccessToken(k, USER_A, 600, NOW);
    const i = mintIncrToken(k, USER_A, NOW);
    expect(verifyIncrToken(k, a, NOW)).toBeNull();
    expect(verifyAccessToken(k, i, NOW)).toBeNull();
    expect(verifyIncrToken(k, i, NOW)).toEqual({ userId: USER_A });
    expect(verifyIncrToken(k, i, NOW + 600)).toBeNull();
    expect(verifyIncrToken(k, mintIncrToken(k, USER_A))).toEqual({ userId: USER_A });
  });

  it.each([
    '',
    'not base64 !!',
    encode('a:b'),
    encode('a:b:c:d'),
    encode(`notahexuserid:${NOW}:${'0'.repeat(64)}`),
    encode(`${USER_A}:abc:${'0'.repeat(64)}`),
    encode(`${USER_A}:${NOW}:short`),
    'x'.repeat(600),
  ])('malformed input never throws (%#)', (bad) => {
    expect(verifyAccessToken(k, bad, NOW)).toBeNull();
    expect(verifyIncrToken(k, bad, NOW)).toBeNull();
    expect(verifyClientId(k, bad)).toBeNull();
  });

  it('non-string input is invalid', () => {
    expect(verifyAccessToken(k, undefined as unknown as string)).toBeNull();
    expect(verifyClientId(k, 42 as unknown as string)).toBeNull();
  });

  it('client_id binds the redirect URIs', () => {
    const uris = ['http://127.0.0.1:33418/callback', 'https://quicksight.aws.amazon.com/cb'];
    const c = signClientId(k, uris, NOW);
    expect(c.startsWith('c1.')).toBe(true);
    expect(verifyClientId(k, c)).toEqual({ redirectUris: uris });
    expect(verifyClientId(k2, c)).toBeNull();
    expect(verifyClientId(k, signClientId(k, ['http://localhost/cb']))).toEqual({ redirectUris: ['http://localhost/cb'] });
  });

  it('client_id payload tamper (swapping redirect_uris) fails', () => {
    const c = signClientId(k, ['http://127.0.0.1/cb'], NOW);
    const [, , sig] = c.split('.');
    const forged = encode(JSON.stringify({ r: ['https://evil.example/cb'], n: '00', iat: NOW }));
    expect(verifyClientId(k, `c1.${forged}.${sig}`)).toBeNull();
    expect(verifyClientId(k, c.replace(/^c1/, 'c2'))).toBeNull();
  });

  it('client_id with a validly signed but bad payload is rejected', () => {
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const sign = (p: string) => `c1.${p}.${createHmac('sha256', k.dcr).update(p).digest('base64url')}`;
    expect(verifyClientId(k, sign(encode('not json')))).toBeNull();
    expect(verifyClientId(k, sign(encode('null')))).toBeNull();
    expect(verifyClientId(k, sign(encode(JSON.stringify({ r: [] }))))).toBeNull();
    expect(verifyClientId(k, sign(encode(JSON.stringify({ r: [1] }))))).toBeNull();
  });

  it('runtime session id is stable, per-user, 66 chars', () => {
    const a = runtimeSessionId(k, USER_A);
    expect(a).toMatch(/^u-[0-9a-f]{64}$/);
    expect(a).toHaveLength(66);
    expect(runtimeSessionId(k, USER_A)).toBe(a);
    expect(runtimeSessionId(k, USER_B)).not.toBe(a);
    expect(runtimeSessionId(k2, USER_A)).not.toBe(a);
  });

  it('random ids have the documented shapes', () => {
    expect(newUserId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newState()).toMatch(/^[0-9a-f]{32}$/);
    expect(newAuthCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newRefreshToken()).toMatch(/^r1\.[A-Za-z0-9_-]{43}$/);
  });

  it('pkce and safeEqual', () => {
    // RFC 7636 appendix B
    expect(pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});

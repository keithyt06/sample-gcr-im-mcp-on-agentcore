// Scheduled IM token refresh for redirect IMs (port of the Lark sample's refreshUser),
// technical design §6.3. Invoked by an events.Rule every 30 minutes.
import { ENV } from '../../shared/contract';
import { getLambdaAdapter, type AdapterDeps, type ImApp, type RedirectAdapter } from '../shared/adapters';
import { loadAppSecret } from '../shared/app-secret';
import { env, envIm } from '../shared/env';
import { hashUserId, log, metric } from '../shared/log';
import { deleteCredential, getRaw, listCredentialNames, putRaw, type StoredCredential } from '../shared/user-secrets';

const CONCURRENCY = 5;
const STORE_ATTEMPTS = 5;

export interface RefreshDeps {
  adapter?: AdapterDeps;
  sleep: (ms: number) => Promise<void>;
}
const defaultDeps: RefreshDeps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export interface RefreshSummary {
  refreshed: number;
  failed: number;
  revoked: number;
  skipped: number;
  total: number;
}

type Outcome = 'refreshed' | 'failed' | 'revoked' | 'skipped';

function parse(raw: string | undefined): StoredCredential | null {
  try {
    const o = JSON.parse(raw ?? '') as Partial<StoredCredential>;
    return typeof o.refreshToken === 'string' && typeof o.expiresAt === 'number' && typeof o.issuedAt === 'number'
      ? (o as StoredCredential)
      : null;
  } catch {
    return null;
  }
}

async function refreshOne(name: string, adapter: RedirectAdapter, app: () => Promise<ImApp>, deps: RefreshDeps): Promise<Outcome> {
  const userIdHash = hashUserId(name.slice(name.lastIndexOf('/') + 1));
  let raw: string | undefined;
  try {
    raw = await getRaw(name);
  } catch (e) {
    log('WARN', 'refresh_read_failed', { userIdHash, error: e instanceof Error ? e.name : 'unknown' });
    return 'skipped';
  }
  const cred = parse(raw);
  if (!cred || !raw) {
    log('WARN', 'refresh_unparseable', { userIdHash });
    return 'skipped';
  }
  const now = Math.floor(Date.now() / 1000);
  if (cred.expiresAt - now > (cred.expiresAt - cred.issuedAt) / 2) return 'skipped';

  // Preflight: prove the secret is writable before consuming the single-use refresh token.
  try {
    await putRaw(name, raw);
  } catch (e) {
    log('WARN', 'refresh_preflight_failed', { userIdHash, error: e instanceof Error ? e.name : 'unknown' });
    return 'skipped';
  }

  const r = await adapter.refresh({ refreshToken: cred.refreshToken as string, app: await app() });
  if (!r.ok) {
    if (r.revoked) {
      log('INFO', 'refresh_revoked', { userIdHash, reason: r.reason });
      metric('RefreshRevoked');
      try {
        await deleteCredential(name, 7);
      } catch (e) {
        log('WARN', 'refresh_delete_failed', { userIdHash, error: e instanceof Error ? e.name : 'unknown' });
      }
      return 'revoked';
    }
    log('WARN', 'refresh_failed', { userIdHash, reason: r.reason });
    metric('RefreshFailed');
    return 'failed';
  }

  const next: StoredCredential = { ...cred, ...r.tokens, refreshToken: r.tokens.refreshToken ?? cred.refreshToken };
  const value = JSON.stringify(next);
  for (let i = 0; i < STORE_ATTEMPTS; i++) {
    try {
      await putRaw(name, value);
      return 'refreshed';
    } catch (e) {
      if (i === STORE_ATTEMPTS - 1) {
        log('CRITICAL', 'store_token_lost', { userIdHash, error: e instanceof Error ? e.name : 'unknown', refreshTokenConsumed: true });
        metric('TokenLost');
        return 'failed';
      }
      await deps.sleep(Math.min(1000 * 2 ** i, 16_000) + Math.random() * 500);
    }
  }
  /* c8 ignore next */
  return 'failed';
}

export async function runRefresh(deps: RefreshDeps = defaultDeps): Promise<RefreshSummary> {
  const im = envIm();
  env(ENV.USER_SECRET_PREFIX);
  const adapter = getLambdaAdapter(im, deps.adapter);
  const summary: RefreshSummary = { refreshed: 0, failed: 0, revoked: 0, skipped: 0, total: 0 };
  if (adapter.mode !== 'redirect') {
    log('INFO', 'refresh_cycle', { ...summary, note: 'qr IM has no refresh' });
    return summary;
  }
  const names = await listCredentialNames();
  summary.total = names.length;
  let appPromise: Promise<ImApp> | undefined;
  const app = (): Promise<ImApp> => (appPromise ??= loadAppSecret());

  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const outcomes = await Promise.all(
      names.slice(i, i + CONCURRENCY).map((n) =>
        refreshOne(n, adapter, app, deps).catch((e: unknown): Outcome => {
          log('ERROR', 'refresh_user_error', { error: e instanceof Error ? e.name : 'unknown' });
          metric('RefreshFailed');
          return 'failed';
        }),
      ),
    );
    for (const o of outcomes) summary[o]++;
  }
  log('INFO', 'refresh_cycle', { ...summary });
  return summary;
}

export async function handler(): Promise<RefreshSummary> {
  return runRefresh();
}

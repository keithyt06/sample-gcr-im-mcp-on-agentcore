// Loads `<slug>/im-app` ({appId, appSecret, configured}). The CDK-created
// placeholder has configured=false until the operator runs `npm run secret:set-im-app`.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ENV } from '../../shared/contract';
import type { ImApp } from './adapters/types';
import { env, envOpt } from './env';
import { BackendUnavailableError } from './http';

export class AppNotConfiguredError extends Error {
  constructor() {
    super('IM app secret is not configured; run npm run secret:set-im-app');
    this.name = 'AppNotConfiguredError';
  }
}

const TTL_MS = 5 * 60 * 1000;
const sm = new SecretsManagerClient({});
let cached: { app: ImApp; until: number } | undefined;

export function parseAppSecret(raw: string | undefined, fallbackAppId?: string): ImApp {
  let o: unknown;
  try {
    o = JSON.parse(raw ?? '');
  } catch {
    throw new AppNotConfiguredError();
  }
  if (!o || typeof o !== 'object') throw new AppNotConfiguredError();
  const { configured, appId, appSecret } = o as { configured?: unknown; appId?: unknown; appSecret?: unknown };
  if (configured !== true || typeof appSecret !== 'string' || !appSecret) throw new AppNotConfiguredError();
  const id = typeof appId === 'string' && appId ? appId : fallbackAppId;
  if (!id) throw new AppNotConfiguredError();
  return { appId: id, appSecret };
}

export async function loadAppSecret(): Promise<ImApp> {
  if (cached && Date.now() < cached.until) return cached.app;
  let raw: string | undefined;
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: env(ENV.IM_APP_SECRET_ID) }));
    raw = r.SecretString;
  } catch (e) {
    throw new BackendUnavailableError('im-app', e);
  }
  const app = parseAppSecret(raw, envOpt(ENV.IM_APP_ID));
  cached = { app, until: Date.now() + TTL_MS };
  return app;
}

export function resetAppSecretCache(): void {
  cached = undefined;
}

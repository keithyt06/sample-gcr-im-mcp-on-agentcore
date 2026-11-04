// Root key load from Secrets Manager with a 5-minute cache (technical design §4.2).
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ENV } from '../../shared/contract';
import { env } from './env';
import { BackendUnavailableError } from './http';
import { deriveKeys, type Keys } from './tokens';

const TTL_MS = 5 * 60 * 1000;
const sm = new SecretsManagerClient({});
let cached: { keys: Keys; until: number } | undefined;

export async function loadKeys(): Promise<Keys> {
  if (cached && Date.now() < cached.until) return cached.keys;
  let root: string | undefined;
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: env(ENV.ROOT_KEY_SECRET_ID) }));
    root = r.SecretString;
  } catch (e) {
    throw new BackendUnavailableError('root-key', e);
  }
  if (!root) throw new BackendUnavailableError('root-key (empty)');
  const keys = deriveKeys(root);
  cached = { keys, until: Date.now() + TTL_MS };
  return keys;
}

/** Test hook. */
export function resetKeyCache(): void {
  cached = undefined;
}

// Secrets Manager access for the container: the IM app secret (feishu/lark) and WeCom per-user blobs.
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  TagResourceCommand,
} from '@aws-sdk/client-secrets-manager';
import { log } from './metrics';

export interface ImAppSecret {
  appId?: string;
  appSecret?: string;
  configured?: boolean;
}

export interface SecretsApi {
  getImApp(secretId: string): Promise<ImAppSecret>;
  /** Parsed JSON of the secret, or null when it does not exist. */
  getUserSecret(name: string): Promise<Record<string, unknown> | null>;
  /** PutSecretValue; creates the secret (CMK-encrypted) when it does not exist yet. */
  putUserSecret(name: string, value: Record<string, unknown>): Promise<void>;
  /** Best effort: failures are logged, never thrown (the credential must not be lost over a tag). */
  tagUserSecret(name: string, tags: Record<string, string>): Promise<void>;
}

export function createSecrets(o: { region?: string; kmsKeyId?: string; client?: SecretsManagerClient } = {}): SecretsApi {
  let client = o.client;
  const sm = () => (client ??= new SecretsManagerClient({ region: o.region ?? process.env.AWS_REGION }));
  return {
    async getImApp(secretId) {
      const r = await sm().send(new GetSecretValueCommand({ SecretId: secretId }));
      try {
        return JSON.parse(r.SecretString ?? '{}') as ImAppSecret;
      } catch {
        return {};
      }
    },
    async getUserSecret(name) {
      try {
        const r = await sm().send(new GetSecretValueCommand({ SecretId: name }));
        return JSON.parse(r.SecretString ?? 'null') as Record<string, unknown> | null;
      } catch (e) {
        if ((e as Error).name === 'ResourceNotFoundException') return null;
        throw e;
      }
    },
    async putUserSecret(name, value) {
      const SecretString = JSON.stringify(value);
      try {
        await sm().send(new PutSecretValueCommand({ SecretId: name, SecretString }));
      } catch (e) {
        if ((e as Error).name !== 'ResourceNotFoundException') throw e;
        await sm().send(new CreateSecretCommand({ Name: name, SecretString, KmsKeyId: o.kmsKeyId }));
      }
    },
    async tagUserSecret(name, tags) {
      try {
        await sm().send(new TagResourceCommand({ SecretId: name, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }));
      } catch (e) {
        log('WARN', 'secret_tag_failed', { error: (e as Error).name });
      }
    },
  };
}

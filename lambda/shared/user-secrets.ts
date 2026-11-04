// Per-user IM credentials in Secrets Manager: `<USER_SECRET_PREFIX>/<userId>` on the users CMK.
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { ENV, type Im } from '../../shared/contract';
import type { ImTokenSet } from './adapters/types';
import { env, envOpt } from './env';
import { BackendUnavailableError } from './http';

/** Redirect-IM user secret JSON = ImTokenSet + {im, imUid}. */
export interface StoredCredential extends ImTokenSet {
  im: Im;
  imUid: string;
}

const sm = new SecretsManagerClient({});

export const secretName = (userId: string): string => `${env(ENV.USER_SECRET_PREFIX)}/${userId}`;

const errName = (e: unknown): string => (e && typeof e === 'object' && 'name' in e ? String(e.name) : '');
const errMsg = (e: unknown): string => (e && typeof e === 'object' && 'message' in e ? String(e.message) : '');

export const isNotFound = (e: unknown): boolean => errName(e) === 'ResourceNotFoundException';

/** SM reports "scheduled/marked for deletion" as InvalidRequestException; wording varies. */
export function isPendingDeletion(e: unknown): boolean {
  if (errName(e) !== 'InvalidRequestException') return false;
  const m = errMsg(e).toLowerCase();
  return m.includes('deletion') || m.includes('deleted');
}

function parseCredential(raw: string | undefined): StoredCredential | null {
  try {
    const o: unknown = JSON.parse(raw ?? '');
    if (!o || typeof o !== 'object') return null;
    const c = o as Partial<StoredCredential>;
    if (typeof c.accessToken !== 'string' || typeof c.expiresAt !== 'number') return null;
    return c as StoredCredential;
  } catch {
    return null;
  }
}

/** null = no usable credential (absent, pending deletion, unparseable). Throttle etc. → BackendUnavailableError. */
export async function getCredential(userId: string): Promise<StoredCredential | null> {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: secretName(userId) }));
    return parseCredential(r.SecretString);
  } catch (e) {
    if (isNotFound(e) || isPendingDeletion(e)) return null;
    throw new BackendUnavailableError('user-secret', e);
  }
}

/** Raw read for refresh preflight. */
export async function getRaw(name: string): Promise<string | undefined> {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  return r.SecretString;
}

export async function putRaw(name: string, value: string): Promise<void> {
  await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
}

/** Create (on the CMK) → else Put → else Restore + Put when pending deletion. */
export async function putCredential(userId: string, cred: StoredCredential): Promise<void> {
  const name = secretName(userId);
  const value = JSON.stringify(cred);
  try {
    const kms = envOpt(ENV.USER_SECRET_KMS_KEY_ARN);
    await sm.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: value,
        ...(kms ? { KmsKeyId: kms } : {}),
        Tags: [{ Key: 'project', Value: 'gcr-im-mcp-on-agentcore' }],
      }),
    );
    return;
  } catch (e) {
    if (errName(e) !== 'ResourceExistsException' && !isPendingDeletion(e)) throw e;
    if (isPendingDeletion(e)) await sm.send(new RestoreSecretCommand({ SecretId: name }));
  }
  try {
    await putRaw(name, value);
  } catch (e) {
    if (!isPendingDeletion(e)) throw e;
    await sm.send(new RestoreSecretCommand({ SecretId: name }));
    await putRaw(name, value);
  }
}

export interface CredentialInfo {
  exists: boolean;
  tags: Record<string, string>;
}

/** Metadata only (no decrypt). exists=false when absent or pending deletion; other errors propagate. */
export async function describeCredential(userId: string): Promise<CredentialInfo> {
  try {
    const r = await sm.send(new DescribeSecretCommand({ SecretId: secretName(userId) }));
    const tags: Record<string, string> = {};
    for (const t of r.Tags ?? []) if (t.Key && t.Value !== undefined) tags[t.Key] = t.Value;
    return { exists: !r.DeletedDate, tags };
  } catch (e) {
    if (isNotFound(e)) return { exists: false, tags: {} };
    throw e;
  }
}

export async function deleteCredential(nameOrUserId: string, recoveryWindowDays = 7): Promise<void> {
  const name = nameOrUserId.includes('/') ? nameOrUserId : secretName(nameOrUserId);
  await sm.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: recoveryWindowDays }));
}

/**
 * All user secret names. The SM `name` filter is a prefix match, so we also require
 * exactly one path segment after `<prefix>/` (another deployment's nested names never match).
 */
export async function listCredentialNames(): Promise<string[]> {
  const prefix = `${env(ENV.USER_SECRET_PREFIX)}/`;
  const names: string[] = [];
  let next: string | undefined;
  do {
    const r = await sm.send(new ListSecretsCommand({ Filters: [{ Key: 'name', Values: [prefix] }], NextToken: next }));
    for (const s of r.SecretList ?? []) {
      if (s.Name && s.Name.startsWith(prefix) && !s.Name.slice(prefix.length).includes('/') && s.Name.length > prefix.length) {
        names.push(s.Name);
      }
    }
    next = r.NextToken;
  } while (next);
  return names;
}

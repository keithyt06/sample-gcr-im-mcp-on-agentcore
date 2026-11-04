// Per-user WeCom credential materialization. Ported from wecom-mcp-on-agentcore docker/lib/credentials.js (MIT-0),
// split into prepare/dispose.
//
// wecom-cli has no token env var we may use (WECOM_CLI_ACCESS_TOKEN disables silent refresh), so the
// identity is a config dir holding `credentials.enc` + `.encryption_key`. The dir lives under $HOME/.wc,
// OUTSIDE the CLI 1.3 sandbox (cwd + system tmp) so tool calls can never read or overwrite it.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashUserId, log } from '../metrics';
import type { SecretsApi } from '../secrets';

export const CRED_FILE = 'credentials.enc';
export const KEY_FILE = '.encryption_key';

export interface WecomBlob {
  credentials_enc: string; // base64
  encryption_key: string; // base64
}

export interface WecomIdentity {
  userId: string;
  userName: string | null;
  botId: string | null;
}

export function configRoot(): string {
  return join(process.env.HOME || '/home/node', '.wc');
}

export function isBlob(v: unknown): v is WecomBlob {
  const o = v as Partial<WecomBlob> | null;
  return !!o && typeof o.credentials_enc === 'string' && typeof o.encryption_key === 'string' && !!o.credentials_enc && !!o.encryption_key;
}

export class WecomStore {
  constructor(
    private readonly secrets: SecretsApi,
    private readonly prefix: string,
  ) {}

  name(userId: string): string {
    return `${this.prefix}/${userId}`;
  }

  async load(userId: string): Promise<WecomBlob | null> {
    const v = await this.secrets.getUserSecret(this.name(userId));
    return isBlob(v) ? { credentials_enc: v.credentials_enc, encryption_key: v.encryption_key } : null;
  }

  async save(userId: string, blob: WecomBlob, who?: WecomIdentity | null): Promise<void> {
    const name = this.name(userId);
    await this.secrets.putUserSecret(name, { ...blob, im: 'wecom', updatedAt: new Date().toISOString(), wecom_identity: who ?? null });
    if (who?.userId && /^[\w.:/=+@-]{1,256}$/.test(who.userId)) await this.secrets.tagUserSecret(name, { WecomUserId: who.userId });
  }
}

export async function newConfigDir(label = 'u-'): Promise<string> {
  await mkdir(configRoot(), { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(configRoot(), label));
  await chmod(dir, 0o700);
  return dir;
}

/** Write the blob into a fresh 0700 dir; returns the dir and the credentials file mtime (ns). */
export async function materialize(blob: WecomBlob): Promise<{ dir: string; mtimeNs: bigint }> {
  const dir = await newConfigDir();
  await Promise.all([
    writeFile(join(dir, CRED_FILE), Buffer.from(blob.credentials_enc, 'base64'), { mode: 0o600 }),
    writeFile(join(dir, KEY_FILE), Buffer.from(blob.encryption_key, 'base64'), { mode: 0o600 }),
  ]);
  // mtimeNs only exists on BigIntStats; without { bigint: true } the comparison silently never fires.
  const st = await stat(join(dir, CRED_FILE), { bigint: true });
  return { dir, mtimeNs: st.mtimeNs };
}

export async function readBlob(dir: string): Promise<WecomBlob | null> {
  try {
    const [c, k] = await Promise.all([readFile(join(dir, CRED_FILE)), readFile(join(dir, KEY_FILE))]);
    return { credentials_enc: c.toString('base64'), encryption_key: k.toString('base64') };
  } catch {
    return null;
  }
}

/** Blob if the CLI rewrote credentials.enc (token refresh), else null. */
export async function collectIfChanged(dir: string, mtimeNs: bigint): Promise<WecomBlob | null> {
  try {
    const st = await stat(join(dir, CRED_FILE), { bigint: true });
    if (st.mtimeNs === mtimeNs) return null;
  } catch {
    return null;
  }
  return readBlob(dir);
}

export async function writeBackAndClean(store: WecomStore, userId: string, dir: string, mtimeNs: bigint): Promise<void> {
  try {
    const updated = await collectIfChanged(dir, mtimeNs);
    if (updated) await store.save(userId, updated);
  } catch (e) {
    // A refreshed token that is not stored forces the user to re-authorize: make it loud.
    log('CRITICAL', 'credential_writeback_failed', { userHash: hashUserId(userId), error: String((e as Error).message ?? e) });
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

// DynamoDB single-table store (technical design §4.3). Key = `pk` (S), TTL = `ttl` (N, epoch s).
// Items: flow#<state>, code#<sha256>, refresh#<sha256>, rfam#<family>, ident#<im>#<imUid>, user#<userId>.
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { ENV, type Im } from '../../shared/contract';
import { env } from './env';
import { CODE_TTL_SEC, FLOW_TTL_SEC, newUserId, REFRESH_TTL_SEC, sha256Hex } from './tokens';

export type FlowKind = 'redirect' | 'incremental' | 'qr';

export interface Flow {
  kind: FlowKind;
  clientId?: string;
  redirectUri?: string;
  clientState?: string;
  codeChallenge?: string;
  userId?: string;
  scopes: string[];
  containerSessionId?: string;
}

export interface CodeRecord {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  exp: number;
}

export interface RefreshRecord {
  userId: string;
  clientId: string;
  exp: number;
  family: string;
}

export interface UserRecord {
  im: Im;
  imUid?: string;
  createdAt: number;
  lastLoginAt: number;
  disabled?: boolean;
  replacedBy?: string;
  /** WeCom operator approval. Absent = approved (existing users and redirect IMs are unaffected). */
  approval?: 'pending' | 'approved';
  approvedAt?: number;
}

/** Status precedence: revoked (disabled) > replaced > pending_approval > active. */
export function userStatus(u: UserRecord | null): 'revoked' | 'replaced' | 'pending_approval' | 'active' {
  if (u?.disabled && !u.replacedBy) return 'revoked';
  if (u?.replacedBy) return 'replaced';
  if (u?.approval === 'pending') return 'pending_approval';
  return 'active';
}

type Item = Record<string, AttributeValue>;

const ddb = new DynamoDBClient({});
const table = (): string => env(ENV.TABLE_NAME);
const nowSec = (): number => Math.floor(Date.now() / 1000);

// ---- minimal (un)marshalling for the attribute shapes we use ----

function toAttr(v: unknown): AttributeValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map((x) => toAttr(x)).filter((x): x is AttributeValue => !!x) };
  throw new Error(`unsupported attribute type: ${typeof v}`);
}

function marshal(pk: string, o: object, ttl?: number): Item {
  const item: Item = { pk: { S: pk } };
  for (const [k, v] of Object.entries(o)) {
    const a = toAttr(v);
    if (a) item[k] = a;
  }
  if (ttl !== undefined) item.ttl = { N: String(ttl) };
  return item;
}

function fromAttr(a: AttributeValue): unknown {
  if (a.S !== undefined) return a.S;
  if (a.N !== undefined) return Number(a.N);
  if (a.BOOL !== undefined) return a.BOOL;
  if (a.L !== undefined) return a.L.map(fromAttr);
  return undefined;
}

function unmarshal<T>(item: Item | undefined): (T & { ttl?: number }) | null {
  if (!item) return null;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (k !== 'pk') o[k] = fromAttr(v);
  return o as T & { ttl?: number };
}

async function put(pk: string, o: object, ttl?: number, condition?: string, expectVersion?: number): Promise<void> {
  const versioned = expectVersion !== undefined
    ? { ConditionExpression: 'v = :v', ExpressionAttributeValues: { ':v': { N: String(expectVersion) } } }
    : {};
  await ddb.send(
    new PutItemCommand({ TableName: table(), Item: marshal(pk, o, ttl), ...(condition ? { ConditionExpression: condition } : {}), ...versioned }),
  );
}

async function get<T>(pk: string): Promise<(T & { ttl?: number }) | null> {
  const r = await ddb.send(new GetItemCommand({ TableName: table(), Key: { pk: { S: pk } }, ConsistentRead: true }));
  return unmarshal<T>(r.Item);
}

/** Atomic single-use read: DeleteItem + ALL_OLD. Expired (TTL lazily deleted) → null. */
async function consume<T>(pk: string): Promise<T | null> {
  const r = await ddb.send(new DeleteItemCommand({ TableName: table(), Key: { pk: { S: pk } }, ReturnValues: 'ALL_OLD' }));
  const o = unmarshal<T>(r.Attributes);
  if (!o) return null;
  if (o.ttl !== undefined && o.ttl <= nowSec()) return null;
  return o;
}

async function del(pk: string): Promise<void> {
  await ddb.send(new DeleteItemCommand({ TableName: table(), Key: { pk: { S: pk } } }));
}

// ---- flows ----

export const putFlow = (state: string, f: Flow): Promise<void> => put(`flow#${state}`, f, nowSec() + FLOW_TTL_SEC);
export const consumeFlow = (state: string): Promise<Flow | null> => consume<Flow>(`flow#${state}`);
export const deleteFlow = (state: string): Promise<void> => del(`flow#${state}`);
export async function getFlow(state: string): Promise<Flow | null> {
  const f = await get<Flow>(`flow#${state}`);
  if (!f || (f.ttl !== undefined && f.ttl <= nowSec())) return null;
  return f;
}

// ---- authorization codes (stored by hash) ----

export function putCode(code: string, rec: Omit<CodeRecord, 'exp'>): Promise<void> {
  const exp = nowSec() + CODE_TTL_SEC;
  return put(`code#${sha256Hex(code)}`, { ...rec, exp }, exp);
}

export async function consumeCode(code: string): Promise<CodeRecord | null> {
  const r = await consume<CodeRecord>(`code#${sha256Hex(code)}`);
  return r && r.exp > nowSec() ? r : null;
}

// ---- refresh tokens: rotation with family revocation ----
// Each grant chain has a family id. Rotation marks the presented token used (kept until
// its exp as a tombstone) and issues a new token in the same family. Presenting a used
// token again (replay) deletes the family, which invalidates every token derived from it.

/**
 * Stores a rotated/new refresh token. When extending an existing family the update is
 * conditional on the family still existing, so a concurrent replay revocation can't be
 * undone by the upsert. Returns false if the family is gone (caller → invalid_grant).
 */
export async function putRefresh(rt: string, rec: Omit<RefreshRecord, 'exp'>, isNewFamily: boolean): Promise<boolean> {
  const exp = nowSec() + REFRESH_TTL_SEC;
  if (isNewFamily) await put(`rfam#${rec.family}`, { userId: rec.userId }, exp);
  else {
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: table(),
        Key: { pk: { S: `rfam#${rec.family}` } },
        UpdateExpression: 'SET #t = :t',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ExpressionAttributeValues: { ':t': { N: String(exp) } },
      }));
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return false;
      throw e;
    }
  }
  await put(`refresh#${sha256Hex(rt)}`, { ...rec, exp }, exp);
  return true;
}

export type ConsumeRefreshResult = { ok: true; rec: RefreshRecord } | { ok: false; reason: 'unknown' | 'expired' | 'replay' | 'revoked' };

export async function consumeRefresh(rt: string): Promise<ConsumeRefreshResult> {
  const pk = `refresh#${sha256Hex(rt)}`;
  let rec: RefreshRecord | null;
  try {
    const r = await ddb.send(new UpdateItemCommand({
      TableName: table(),
      Key: { pk: { S: pk } },
      UpdateExpression: 'SET usedAt = :now',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(usedAt)',
      ExpressionAttributeValues: { ':now': { N: String(nowSec()) } },
      ReturnValues: 'ALL_NEW',
    }));
    rec = unmarshal<RefreshRecord>(r.Attributes);
  } catch (e) {
    if (!(e instanceof ConditionalCheckFailedException)) throw e;
    const old = await get<RefreshRecord & { usedAt?: number }>(pk);
    if (!old) return { ok: false, reason: 'unknown' };
    await del(`rfam#${old.family}`);
    return { ok: false, reason: 'replay' };
  }
  if (!rec) return { ok: false, reason: 'unknown' };
  if (rec.exp <= nowSec()) return { ok: false, reason: 'expired' };
  const fam = await get<{ userId: string }>(`rfam#${rec.family}`);
  if (!fam || (fam.ttl !== undefined && fam.ttl <= nowSec())) return { ok: false, reason: 'revoked' };
  return { ok: true, rec };
}

// ---- identities and users ----

const identPk = (im: Im, imUid: string): string => `ident#${im}#${imUid}`;

export async function getIdent(im: Im, imUid: string): Promise<string | null> {
  const r = await get<{ userId: string }>(identPk(im, imUid));
  return r?.userId ?? null;
}

/** Points an identity at userId (overwrites). */
export async function setIdent(im: Im, imUid: string, userId: string): Promise<void> {
  const now = nowSec();
  await put(identPk(im, imUid), { userId, createdAt: now, updatedAt: now });
}

/**
 * Returns the userId for an IM identity, creating `ident#` + `user#` if absent.
 * Race-safe: a conditional-put loser re-reads the winner's mapping.
 */
export async function resolveIdentity(im: Im, imUid: string): Promise<{ userId: string; created: boolean }> {
  const existing = await getIdent(im, imUid);
  if (existing) return { userId: existing, created: false };
  const userId = newUserId();
  const now = nowSec();
  try {
    await put(identPk(im, imUid), { userId, createdAt: now, updatedAt: now }, undefined, 'attribute_not_exists(pk)');
  } catch (e) {
    if (!(e instanceof ConditionalCheckFailedException)) throw e;
    const winner = await getIdent(im, imUid);
    if (winner) return { userId: winner, created: false };
    throw e;
  }
  await putUser(userId, { im, imUid, createdAt: now, lastLoginAt: now });
  return { userId, created: true };
}

export const getUser = (userId: string): Promise<UserRecord | null> => get<UserRecord>(`user#${userId}`);
export const putUser = (userId: string, u: UserRecord): Promise<void> => put(`user#${userId}`, u);

export async function touchUser(userId: string): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: table(),
    Key: { pk: { S: `user#${userId}` } },
    UpdateExpression: 'SET lastLoginAt = :now',
    ExpressionAttributeValues: { ':now': { N: String(nowSec()) } },
  }));
}

export async function disableUser(userId: string, replacedBy?: string): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: table(),
    Key: { pk: { S: `user#${userId}` } },
    UpdateExpression: replacedBy ? 'SET disabled = :t, replacedBy = :r' : 'SET disabled = :t',
    ExpressionAttributeValues: { ':t': { BOOL: true }, ...(replacedBy ? { ':r': { S: replacedBy } } : {}) },
  }));
}

// ---- pending WeCom QR sessions (H-1: bound microVM amplification) ----
// One item `qrpending` holds `entries: ["<exp>:<state>:<ipHash>", ...]` plus a version
// counter. Acquire/release are optimistic read-modify-writes (condition on the version),
// and expired entries are pruned on every write, so the pool self-heals without a sweeper.

const QR_PK = 'qrpending';
const QR_ATTEMPTS = 4;

export type QrAcquire = { ok: true } | { ok: false; reason: 'global' | 'source' | 'contention' };

async function qrUpdate(mutate: (live: string[]) => string[] | QrAcquire): Promise<QrAcquire> {
  for (let i = 0; i < QR_ATTEMPTS; i++) {
    const cur = await get<{ entries?: string[]; v?: number }>(QR_PK);
    const now = nowSec();
    const live = (cur?.entries ?? []).filter((e) => Number(e.split(':')[0]) > now);
    const next = mutate(live);
    if (!Array.isArray(next)) return next;
    const v = cur?.v ?? 0;
    try {
      await put(QR_PK, { entries: next, v: v + 1 }, undefined, cur ? undefined : 'attribute_not_exists(pk)', cur ? v : undefined);
      return { ok: true };
    } catch (e) {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
    }
  }
  return { ok: false, reason: 'contention' };
}

/** Reserves a pending-QR slot for `state` until `exp` (epoch s). */
export function acquireQrSlot(state: string, sourceHash: string, exp: number, maxGlobal: number, maxPerSource: number): Promise<QrAcquire> {
  return qrUpdate((live) => {
    if (live.length >= maxGlobal) return { ok: false, reason: 'global' };
    if (live.filter((e) => e.endsWith(`:${sourceHash}`)).length >= maxPerSource) return { ok: false, reason: 'source' };
    return [...live, `${exp}:${state}:${sourceHash}`];
  });
}

/** Best-effort release; an unreleased slot expires on its own. */
export async function releaseQrSlot(state: string): Promise<void> {
  await qrUpdate((live) => live.filter((e) => e.split(':')[1] !== state));
}

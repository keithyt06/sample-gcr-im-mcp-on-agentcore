import { ConditionalCheckFailedException, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../../lambda/shared/store';
import { sha256Hex } from '../../lambda/shared/tokens';
import { ddbMock, installFakes, setEnv, table, USER_A } from './helpers';

beforeEach(() => {
  installFakes();
  setEnv('feishu');
  vi.useRealTimers();
});

describe('store', () => {
  it('flow put/get/consume is single-use, with TTL', async () => {
    await store.putFlow('f'.repeat(32), { kind: 'redirect', scopes: ['a', 'b'], clientId: 'c', redirectUri: 'http://127.0.0.1/cb' });
    const item = table.get(`flow#${'f'.repeat(32)}`)!;
    expect(Number(item.ttl!.N) - Date.now() / 1000).toBeGreaterThan(590);
    expect(await store.getFlow('f'.repeat(32))).toMatchObject({ kind: 'redirect', scopes: ['a', 'b'] });
    expect(await store.consumeFlow('f'.repeat(32))).toMatchObject({ clientId: 'c' });
    expect(await store.consumeFlow('f'.repeat(32))).toBeNull();
    expect(await store.getFlow('f'.repeat(32))).toBeNull();
  });

  it('expired flow is treated as absent (TTL deletion is lazy)', async () => {
    await store.putFlow('e'.repeat(32), { kind: 'qr', scopes: [] });
    table.get(`flow#${'e'.repeat(32)}`)!.ttl = { N: '1' };
    expect(await store.getFlow('e'.repeat(32))).toBeNull();
    expect(await store.consumeFlow('e'.repeat(32))).toBeNull();
  });

  it('deleteFlow removes the item', async () => {
    await store.putFlow('d'.repeat(32), { kind: 'qr', scopes: [] });
    await store.deleteFlow('d'.repeat(32));
    expect(table.size).toBe(0);
  });

  it('codes are stored by sha256 and single-use', async () => {
    await store.putCode('the-code', { userId: USER_A, clientId: 'c1', redirectUri: 'r', codeChallenge: 'x' });
    expect(table.has(`code#${sha256Hex('the-code')}`)).toBe(true);
    expect([...table.keys()].some((k) => k.includes('the-code'))).toBe(false);
    expect(await store.consumeCode('the-code')).toMatchObject({ userId: USER_A, clientId: 'c1' });
    expect(await store.consumeCode('the-code')).toBeNull();
  });

  it('expired code is invalid', async () => {
    await store.putCode('old', { userId: USER_A, clientId: 'c1', redirectUri: 'r', codeChallenge: 'x' });
    const item = table.get(`code#${sha256Hex('old')}`)!;
    item.exp = { N: String(Math.floor(Date.now() / 1000) - 1) };
    expect(await store.consumeCode('old')).toBeNull();
  });

  it('refresh rotation and replay revokes the family', async () => {
    await store.putRefresh('r1.a', { userId: USER_A, clientId: 'c', family: 'fam' }, true);
    const first = await store.consumeRefresh('r1.a');
    expect(first).toMatchObject({ ok: true, rec: { userId: USER_A, family: 'fam' } });
    await store.putRefresh('r1.b', { userId: USER_A, clientId: 'c', family: 'fam' }, false);
    expect(await store.consumeRefresh('r1.a')).toEqual({ ok: false, reason: 'replay' });
    // family gone → the rotated token is dead too
    expect(await store.consumeRefresh('r1.b')).toEqual({ ok: false, reason: 'revoked' });
    expect(await store.consumeRefresh('r1.never')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('expired refresh token', async () => {
    await store.putRefresh('r1.x', { userId: USER_A, clientId: 'c', family: 'f2' }, true);
    table.get(`refresh#${sha256Hex('r1.x')}`)!.exp = { N: '5' };
    expect(await store.consumeRefresh('r1.x')).toEqual({ ok: false, reason: 'expired' });
  });

  it('identity resolution creates once and reuses', async () => {
    const a = await store.resolveIdentity('feishu', 'ou_1');
    expect(a.created).toBe(true);
    expect(a.userId).toMatch(/^[0-9a-f]{32}$/);
    expect(await store.getUser(a.userId)).toMatchObject({ im: 'feishu', imUid: 'ou_1' });
    const b = await store.resolveIdentity('feishu', 'ou_1');
    expect(b).toEqual({ userId: a.userId, created: false });
    // brand separation
    expect((await store.resolveIdentity('lark', 'ou_1')).userId).not.toBe(a.userId);
  });

  it('identity creation race: the loser re-reads the winner', async () => {
    let first = true;
    ddbMock.on(GetItemCommand).callsFake((i: { Key: { pk: { S: string } } }) => {
      if (first) {
        first = false;
        return {};
      }
      return { Item: table.get(i.Key.pk.S) };
    });
    table.set('ident#feishu#ou_race', { pk: { S: 'ident#feishu#ou_race' }, userId: { S: USER_A } });
    ddbMock.on(PutItemCommand).rejectsOnce(new ConditionalCheckFailedException({ message: 'c', $metadata: {} }));
    expect(await store.resolveIdentity('feishu', 'ou_race')).toEqual({ userId: USER_A, created: false });
  });

  it('identity race with nothing to re-read rethrows', async () => {
    ddbMock.on(PutItemCommand).rejects(new ConditionalCheckFailedException({ message: 'c', $metadata: {} }));
    await expect(store.resolveIdentity('feishu', 'ou_x')).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('other put errors propagate', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('boom'));
    await expect(store.resolveIdentity('feishu', 'ou_y')).rejects.toThrow('boom');
  });

  it('setIdent / touchUser / disableUser', async () => {
    await store.setIdent('wecom', 'wo_1', USER_A);
    expect(await store.getIdent('wecom', 'wo_1')).toBe(USER_A);
    await store.putUser(USER_A, { im: 'wecom', createdAt: 1, lastLoginAt: 1 });
    await store.touchUser(USER_A);
    expect((await store.getUser(USER_A))!.lastLoginAt).toBeGreaterThan(1);
    await store.disableUser(USER_A);
    expect(await store.getUser(USER_A)).toMatchObject({ disabled: true });
    await store.disableUser(USER_A, 'b'.repeat(32));
    expect(await store.getUser(USER_A)).toMatchObject({ disabled: true, replacedBy: 'b'.repeat(32) });
  });

  it('unsupported attribute types are a programming error', async () => {
    await expect(store.putUser(USER_A, { im: 'feishu', createdAt: 1, lastLoginAt: 1, x: {} } as unknown as store.UserRecord)).rejects.toThrow(
      'unsupported attribute type',
    );
  });
});

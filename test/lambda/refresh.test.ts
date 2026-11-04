import { DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handler, runRefresh } from '../../lambda/refresh/index';
import { configureApp, emfLines, fakeFetch, installFakes, jsonResp, PREFIX, secrets, setEnv, smMock } from './helpers';

let out: MockInstance<typeof console.log>;
const now = () => Math.floor(Date.now() / 1000);
const sleep = vi.fn(async () => undefined);

function cred(name: string, issuedAgo: number, ttl = 7200): void {
  const issuedAt = now() - issuedAgo;
  secrets.set(`${PREFIX}/${name}`, {
    value: JSON.stringify({ accessToken: `at-${name}`, refreshToken: `rt-${name}`, issuedAt, expiresAt: issuedAt + ttl, im: 'feishu', imUid: name }),
    tags: {},
  });
}
const stored = (name: string) => JSON.parse(secrets.get(`${PREFIX}/${name}`)!.value!) as Record<string, unknown>;

function feishu(refresh: (rt: string) => Response) {
  return fakeFetch([
    ['app_access_token', () => jsonResp(200, { code: 0, app_access_token: 'app' })],
    ['refresh_access_token', (c) => refresh(JSON.parse(c.body).refresh_token as string)],
  ]);
}

beforeEach(() => {
  installFakes();
  setEnv('feishu');
  configureApp();
  sleep.mockClear();
  out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => out.mockRestore());

const summaryLog = () => out.mock.calls.map((c) => JSON.parse(String(c[0]))).find((l) => l.event === 'refresh_cycle');

describe('refresh', () => {
  it('half-life skip, refresh, revoked delete; pagination over 3 pages', async () => {
    cred('fresh', 60); // far from half-life
    cred('due1', 4000);
    cred('due2', 5000);
    cred('gone', 7000);
    cred('due3', 3700);
    secrets.set(`${PREFIX}/nested/x`, { value: '{}', tags: {} });
    const f = feishu((rt) =>
      rt === 'rt-gone' ? jsonResp(200, { code: 20064, msg: 'expired' }) : jsonResp(200, { code: 0, data: { access_token: `new-${rt}`, refresh_token: `nrt-${rt}`, expires_in: 7200 } }),
    );
    const s = await runRefresh({ adapter: { fetch: f }, sleep });
    expect(s).toEqual({ refreshed: 3, failed: 0, revoked: 1, skipped: 1, total: 5 });
    expect(stored('due1')).toMatchObject({ accessToken: 'new-rt-due1', refreshToken: 'nrt-rt-due1', im: 'feishu', imUid: 'due1' });
    expect(stored('fresh').accessToken).toBe('at-fresh');
    expect(secrets.get(`${PREFIX}/gone`)!.deleted).toBe(true);
    expect(smMock.commandCalls(DeleteSecretCommand)[0]!.args[0].input).toMatchObject({ RecoveryWindowInDays: 7 });
    expect(emfLines(out)).toEqual(['RefreshRevoked']);
    expect(summaryLog()).toMatchObject({ refreshed: 3, revoked: 1, skipped: 1, total: 5 });
    // app token fetched once
    expect(f.calls.filter((c) => c.url.includes('app_access_token'))).toHaveLength(1);
    // no tokens in logs
    const logs = out.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).not.toContain('rt-due1');
    expect(logs).not.toContain('new-rt');
  });

  it('keeps the old refresh token when upstream omits one', async () => {
    cred('keep', 5000);
    const f = feishu(() => jsonResp(200, { code: 0, data: { access_token: 'n', expires_in: 7200 } }));
    await runRefresh({ adapter: { fetch: f }, sleep });
    expect(stored('keep').refreshToken).toBe('rt-keep');
  });

  it('transient failure → RefreshFailed EMF, secret untouched', async () => {
    cred('flaky', 5000);
    const f = feishu(() => jsonResp(200, { code: 99991400, msg: 'busy' }));
    const s = await runRefresh({ adapter: { fetch: f }, sleep });
    expect(s.failed).toBe(1);
    expect(emfLines(out)).toEqual(['RefreshFailed']);
    expect(stored('flaky').accessToken).toBe('at-flaky');
  });

  it('store retry exhausted → CRITICAL store_token_lost + TokenLost EMF', async () => {
    cred('lost', 5000);
    let puts = 0;
    smMock.on(PutSecretValueCommand).callsFake((i: { SecretId: string; SecretString: string }) => {
      puts++;
      if (puts === 1) {
        secrets.get(i.SecretId)!.value = i.SecretString; // preflight succeeds
        return {};
      }
      throw new Error('sm down');
    });
    const f = feishu(() => jsonResp(200, { code: 0, data: { access_token: 'n', refresh_token: 'r', expires_in: 7200 } }));
    const s = await runRefresh({ adapter: { fetch: f }, sleep });
    expect(s.failed).toBe(1);
    expect(puts).toBe(6);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(emfLines(out)).toEqual(['TokenLost']);
    expect(out.mock.calls.map((c) => JSON.parse(String(c[0]))).find((l) => l.event === 'store_token_lost')).toMatchObject({ level: 'CRITICAL' });
  });

  it('store succeeds on a later attempt', async () => {
    cred('retry', 5000);
    let puts = 0;
    smMock.on(PutSecretValueCommand).callsFake((i: { SecretId: string; SecretString: string }) => {
      puts++;
      if (puts === 2) throw new Error('blip');
      secrets.get(i.SecretId)!.value = i.SecretString;
      return {};
    });
    const f = feishu(() => jsonResp(200, { code: 0, data: { access_token: 'n2', refresh_token: 'r', expires_in: 7200 } }));
    expect((await runRefresh({ adapter: { fetch: f }, sleep })).refreshed).toBe(1);
    expect(stored('retry').accessToken).toBe('n2');
  });

  it('preflight failure skips without consuming the refresh token', async () => {
    cred('ro', 5000);
    smMock.on(PutSecretValueCommand).rejects(new Error('denied'));
    const f = feishu(() => jsonResp(200, { code: 0, data: {} }));
    const s = await runRefresh({ adapter: { fetch: f }, sleep });
    expect(s.skipped).toBe(1);
    expect(f.calls.filter((c) => c.url.includes('refresh_access_token'))).toHaveLength(0);
  });

  it('unreadable / unparseable secrets are skipped; revoked delete failure tolerated', async () => {
    secrets.set(`${PREFIX}/junk`, { value: 'not json', tags: {} });
    secrets.set(`${PREFIX}/pending`, { value: '{}', tags: {}, deleted: true });
    cred('gone', 7000);
    smMock.on(DeleteSecretCommand).rejects(new Error('nope'));
    const f = feishu(() => jsonResp(200, { code: 20016 }));
    const s = await runRefresh({ adapter: { fetch: f }, sleep });
    expect(s).toMatchObject({ skipped: 2, revoked: 1, total: 3 });
  });

  it('an unexpected per-user error counts as failed (app secret missing)', async () => {
    secrets.delete('team-a/im-app');
    cred('u', 5000);
    const s = await runRefresh({ adapter: { fetch: feishu(() => jsonResp(200, {})) }, sleep });
    expect(s.failed).toBe(1);
    expect(emfLines(out)).toEqual(['RefreshFailed']);
  });

  it('dingtalk: 429 / app credential rejected keep the user secret (M-4)', async () => {
    setEnv('dingtalk');
    configureApp('dingclientid0001');
    cred('a1', 5000);
    cred('a2', 5000);
    let f = fakeFetch([['userAccessToken', () => jsonResp(429, { code: 'Throttling' })]]);
    expect(await runRefresh({ adapter: { fetch: f }, sleep })).toMatchObject({ failed: 2, revoked: 0 });
    f = fakeFetch([['userAccessToken', () => jsonResp(401, { code: 'InvalidAuthentication' })]]);
    expect(await runRefresh({ adapter: { fetch: f }, sleep })).toMatchObject({ failed: 2, revoked: 0 });
    expect(secrets.get(`${PREFIX}/a1`)!.deleted).toBeFalsy();
    expect(smMock.commandCalls(DeleteSecretCommand)).toHaveLength(0);
    const logs = out.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(logs.filter((l) => l.event === 'im_app_credential_rejected' && l.level === 'ERROR')).toHaveLength(2);
    expect(emfLines(out)).toEqual(['RefreshFailed', 'RefreshFailed', 'RefreshFailed', 'RefreshFailed']);
  });

  it('dingtalk: explicit invalid grant → revoked', async () => {
    setEnv('dingtalk');
    configureApp('dingclientid0001');
    cred('dt', 5000);
    const f = fakeFetch([['userAccessToken', () => jsonResp(400, { code: 'invalidGrant' })]]);
    expect((await runRefresh({ adapter: { fetch: f }, sleep })).revoked).toBe(1);
  });

  it('wecom is a no-op; handler entry runs with no secrets', async () => {
    setEnv('wecom');
    expect(await runRefresh({ sleep })).toEqual({ refreshed: 0, failed: 0, revoked: 0, skipped: 0, total: 0 });
    setEnv('feishu');
    expect(await handler()).toMatchObject({ total: 0 });
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });
});

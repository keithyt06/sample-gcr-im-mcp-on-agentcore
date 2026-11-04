import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { H } from '../../shared/contract';
import { stripIdentityContext, extractCliError } from '../../container/src/wecom/identity';
import { startHarness, type Harness } from './helpers';

const USER = { [H.userId]: 'user-w' };
const SECRET = 'slug/users/user-w';
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('wecom adapter via server', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('wecom');
  });
  afterAll(() => h.close());
  beforeEach(() => {
    h.secrets.users.set(SECRET, { credentials_enc: b64('CRED-0'), encryption_key: b64('KEY-0') });
    h.secrets.puts = [];
  });

  it('argv: method path + --json; config dir outside cwd and system tmp; files materialized 0600', async () => {
    h.control({ scenario: 'ok' });
    const r = await h.call('wecom_todo_list', { limit: 5 }, USER);
    expect(r.result.isError).toBeFalsy();
    const c = h.calls().at(-1)!;
    expect(c.bin).toBe('wecom-cli');
    expect(c.argv).toEqual(['todo', 'list', '--json', '{"limit":5}']);
    expect(c.env.WECOM_CLI_CONFIG_DIR!.startsWith(join(h.home, '.wc') + '/')).toBe(true);
    expect(c.env.WECOM_CLI_LOG_DIR).toBe(join(c.env.WECOM_CLI_CONFIG_DIR!, 'logs'));
    expect(c.cwd.startsWith(`${h.tmp}/wcw-`)).toBe(true);
    expect(c.env.WECOM_CLI_ACCESS_TOKEN).toBeUndefined();
    expect(c.env.WECOM_CLI_TMP_DIR).toBeUndefined();
    expect(Object.keys(c.env).filter((k) => k.startsWith('AWS_'))).toEqual([]);
    expect(JSON.parse(r.result.content[0].text).cred).toBe('CRED-0');
  });

  it('extra_identity_context is stripped from data and returned as _meta', async () => {
    h.control({ scenario: 'ok' });
    const r = await h.call('wecom_todo_list', {}, USER);
    expect(r.result.content[0].text).not.toContain('extra_identity_context');
    expect(r.result._meta.wecom_identity).toMatchObject({ bot_id: 'bot_1', authorized_user_id: 'wo_alice', authorized_user_name: 'Alice' });
  });

  it('dirs are removed after the call; no write-back when credentials.enc is unchanged', async () => {
    h.control({ scenario: 'ok' });
    await h.call('wecom_todo_list', {}, USER);
    const c = h.calls().at(-1)!;
    expect(existsSync(c.env.WECOM_CLI_CONFIG_DIR!)).toBe(false);
    expect(existsSync(c.cwd)).toBe(false);
    expect(readdirSync(join(h.home, '.wc'))).toEqual([]);
    expect(h.secrets.puts).toEqual([]);
  });

  it('write-back when the CLI refreshed credentials.enc (mtime changed)', async () => {
    h.control({ scenario: 'refresh' });
    await h.call('wecom_todo_list', {}, USER);
    expect(h.secrets.puts).toEqual([SECRET]);
    const saved = h.secrets.users.get(SECRET)!;
    expect(Buffer.from(String(saved.credentials_enc), 'base64').toString()).toMatch(/^REFRESHED-/);
    expect(Buffer.from(String(saved.encryption_key), 'base64').toString()).toBe('KEY-0');
  });

  it('write-back failure is logged CRITICAL, never thrown', async () => {
    h.control({ scenario: 'refresh' });
    h.secrets.failPut = true;
    const spy = vi.spyOn(process.stderr, 'write');
    try {
      const r = await h.call('wecom_todo_list', {}, USER);
      expect(r.result.isError).toBeFalsy();
      expect(spy.mock.calls.some(([l]) => String(l).includes('"CRITICAL"') && String(l).includes('credential_writeback_failed'))).toBe(true);
    } finally {
      spy.mockRestore();
      h.secrets.failPut = false;
    }
  });

  it('per-user lock serializes concurrent calls for the same user, not across users', async () => {
    h.control({ scenario: 'slow', sleepMs: 300 });
    h.secrets.users.set('slug/users/user-x', { credentials_enc: b64('CRED-X'), encryption_key: b64('KEY-X') });
    const t0 = Date.now();
    const [a, b, x] = await Promise.all([h.call('wecom_todo_list', {}, USER), h.call('wecom_todo_list', {}, USER), h.call('wecom_todo_list', {}, { [H.userId]: 'user-x' })]);
    const elapsed = Date.now() - t0;
    for (const r of [a, b, x]) expect(r.result.isError).toBeFalsy();
    expect(JSON.parse(x.result.content[0].text).cred).toBe('CRED-X');
    expect(elapsed).toBeGreaterThanOrEqual(600); // the two user-w calls ran back to back
    expect(elapsed).toBeLessThan(1200); // user-x ran in parallel with them
  });

  it('no blob → im_not_authorized (reconnect), CLI not called', async () => {
    h.secrets.users.delete(SECRET);
    const before = h.calls().length;
    const r = await h.call('wecom_todo_list', {}, USER);
    expect(r.envelope.error.code).toBe('im_not_authorized');
    expect(r.envelope.error.user_action).toMatch(/reconnect/i);
    expect(h.calls().length).toBe(before);
  });

  it('850003 → im_grant_expired + EMF ImGrantExpired on stdout', async () => {
    h.control({ scenario: '850003' });
    const spy = vi.spyOn(process.stdout, 'write');
    try {
      const r = await h.call('wecom_todo_list', {}, USER);
      expect(r.envelope.error).toMatchObject({ code: 'im_grant_expired', im_code: 850003 });
      expect(r.envelope.error.user_action).toMatch(/renew/i);
      const emf = spy.mock.calls.map(([l]) => String(l)).find((l) => l.includes('"ImGrantExpired"'));
      expect(emf).toBeTruthy();
      const j = JSON.parse(emf!);
      expect(j._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: 'ImMcp/test', Metrics: [{ Name: 'ImGrantExpired', Unit: 'Count' }] });
      expect(j.ImGrantExpired).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('850003 wrapped in an outer CLI code is still recognised', async () => {
    h.control({ scenario: 'wrapped' });
    expect((await h.call('wecom_todo_list', {}, USER)).envelope.error.code).toBe('im_grant_expired');
  });

  it('850005 is retried (1.5 s, 4 s) and succeeds when the platform recovers', async () => {
    h.control({ scenario: '850005', fails: 1 });
    writeFileSync(join(h.home, 'fake-counter'), '0');
    const r = await h.call('wecom_todo_list', {}, USER);
    expect(r.result.isError).toBeFalsy();
    expect(JSON.parse(r.result.content[0].text).after_retries).toBe(1);
  });

  it('850005 after retries → im_rate_limited', async () => {
    h.control({ scenario: '850005', fails: 99 });
    writeFileSync(join(h.home, 'fake-counter'), '0');
    const r = await h.call('wecom_todo_list', {}, USER);
    expect(r.envelope.error).toMatchObject({ code: 'im_rate_limited', im_code: 850005 });
  }, 15_000);

  it.each([
    ['853006', 'im_policy_blocked'],
    ['851003', 'im_object_permission'],
    ['other', 'cli_failed'],
  ])('%s → %s', async (scenario, code) => {
    h.control({ scenario });
    expect((await h.call('wecom_todo_list', {}, USER)).envelope.error.code).toBe(code);
  });

  it('unavailable (file-path) methods are refused before running', async () => {
    const before = h.calls().length;
    const r = await h.call('wecom_invoke', { tool_name: 'wecom_media_upload', args: {} }, USER);
    expect(r.envelope.error.code).toBe('invalid_argument');
    expect(r.result.isError).toBe(false);
    expect(h.calls().length).toBe(before);
  });
});

describe('wecom identity helpers', () => {
  it('stripIdentityContext leaves payloads without context alone', () => {
    expect(stripIdentityContext({ a: 1 })).toEqual({ data: { a: 1 }, identity: null });
    expect(stripIdentityContext([1])).toEqual({ data: [1], identity: null });
  });
  it('extractCliError reads the last JSON object after log lines and falls back to [code=]', () => {
    expect(extractCliError('INFO x\n{"error":{"type":"T","code":850005,"message":"m"}}')).toEqual({ type: 'T', code: 850005, message: 'm' });
    expect(extractCliError('oops [code=853006] "message": "bad"')?.code).toBe(853006);
    expect(extractCliError('all good')).toBeNull();
  });
});

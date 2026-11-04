import { existsSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeishuAdapter, stripCliNotice } from '../../container/src/adapters/feishu';
import { ToolError } from '../../container/src/errors';
import { MemorySecrets, startHarness, tokenHeaders, type Harness } from './helpers';

const AUTH = 'https://mcp.example.com/authorize?t=incr';

describe('feishu adapter via server', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('feishu');
  });
  afterAll(() => h.close());

  it('passes the user token via env, brand, default-as=user; builds flags', async () => {
    h.control({ scenario: 'ok' });
    const r = await h.call('feishu_im_messages_send', { chat_id: 'oc_1', text: 'hi', attachment: ['f1', 'f2'] }, tokenHeaders('user-a', 'tok-a'));
    expect(r.result.isError).toBeFalsy();
    const c = h.calls().at(-1)!;
    expect(c.bin).toBe('lark-cli');
    expect(c.argv.slice(0, 2)).toEqual(['im', '+messages-send']);
    expect(c.argv).toEqual(expect.arrayContaining(['--chat-id', 'oc_1', '--text', 'hi']));
    expect(c.argv.filter((a) => a === '--attachment').length).toBe(2);
    expect(c.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe('tok-a');
    expect(c.env.LARKSUITE_CLI_APP_ID).toBe('cli_test');
    expect(c.env.LARKSUITE_CLI_APP_SECRET).toBe('s3cret');
    expect(c.env.LARKSUITE_CLI_BRAND).toBe('feishu');
    expect(c.env.LARKSUITE_CLI_DEFAULT_AS).toBe('user');
    expect(c.cwd).toContain(`${h.tmp}/lark-`);
  });

  it('env isolation: no AWS_* or other server env reaches the CLI', async () => {
    h.control({ scenario: 'ok' });
    await h.call('feishu_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a'));
    const env = h.calls().at(-1)!.env;
    expect(Object.keys(env).filter((k) => k.startsWith('AWS_'))).toEqual([]);
    expect(env.SECRET_PROBE).toBeUndefined();
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.NO_COLOR).toBe('1');
  });

  it('per-call work dir is removed after the call', async () => {
    h.control({ scenario: 'ok' });
    await h.call('feishu_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a'));
    const cwd = h.calls().at(-1)!.cwd;
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(h.tmp)).toEqual([]);
  });

  it('strips _notice.update without touching big integers', async () => {
    h.control({ scenario: 'ok' });
    const r = await h.call('feishu_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a'));
    const text = r.result.content[0].text as string;
    expect(text).toContain('7304827392019283746');
    expect(text).not.toContain('_notice');
  });

  it('two users alternate and each gets their own token', async () => {
    h.control({ scenario: 'ok' });
    for (const [u, t] of [['ua', 'ta'], ['ub', 'tb'], ['ua', 'ta'], ['ub', 'tb']]) {
      await h.call('feishu_calendar_agenda', {}, tokenHeaders(u!, t!));
      expect(h.calls().at(-1)!.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe(t);
    }
  });

  it('missing_scope with authorize_url (= header URL + extra_scope)', async () => {
    h.control({ scenario: 'missing_scope' });
    const r = await h.call('feishu_im_messages_send', { chat_id: 'oc_1', text: 'x' }, tokenHeaders('user-a', 'tok-a', AUTH));
    expect(r.result.isError).toBe(true);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: 'missing_scope', required_scopes: ['im:message.send_as_user'], im_code: 99991679 } });
    expect(r.envelope.error.authorize_url).toBe(`${AUTH}&extra_scope=${encodeURIComponent('im:message.send_as_user')}`);
    expect(r.envelope.error.user_action).toBeTruthy();
  });

  it('missing_scope falls back to the catalog scopes', async () => {
    h.control({ scenario: 'missing_scope_noinfo' });
    const r = await h.call('feishu_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a', AUTH));
    expect(r.envelope.error.code).toBe('missing_scope');
    expect(r.envelope.error.required_scopes).toEqual(['calendar:calendar.event:read']);
  });

  it('auth error (99991668, after a log line) → im_reauth_required', async () => {
    h.control({ scenario: 'auth' });
    const r = await h.call('feishu_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a'));
    expect(r.envelope.error.code).toBe('im_reauth_required');
  });

  it('validation errors are passed through as self-correctable', async () => {
    h.control({ scenario: 'validation' });
    const r = await h.call('feishu_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a'));
    expect(r.result.isError).toBe(false);
    expect(r.envelope.error.type).toBe('validation');
  });

  it('plain crash → cli_failed', async () => {
    h.control({ scenario: 'crash' });
    const r = await h.call('feishu_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a'));
    expect(r.envelope.error.code).toBe('cli_failed');
    expect(r.result.isError).toBe(true);
  });

  it('output_too_large', async () => {
    h.control({ scenario: 'big' });
    const r = await h.call('feishu_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a'));
    expect(r.envelope.error.code).toBe('output_too_large');
  });

  it('no user token → im_not_authorized', async () => {
    const r = await h.call('feishu_calendar_agenda', {}, { [Object.keys(tokenHeaders('', ''))[0]!]: 'user-a' });
    expect(r.envelope.error.code).toBe('im_not_authorized');
  });

  it('im-app secret not configured → im_app_not_configured', async () => {
    const secrets = new MemorySecrets();
    secrets.imApp = { configured: false };
    const h2 = await startHarness('lark', { secrets });
    try {
      const r = await h2.call('lark_calendar_agenda', {}, tokenHeaders('user-a', 'tok-a'));
      expect(r.envelope.error.code).toBe('im_app_not_configured');
      expect(h2.calls()).toEqual([]);
    } finally {
      await h2.close();
    }
  });

  it('comma-joined string for an array flag → invalid_argument (self-correctable)', async () => {
    const r = await h.call('feishu_base_record_search', { base_token: 'b', table_id: 't', keyword: 'k', search_field: 'a,b' }, tokenHeaders('user-a', 'tok-a'));
    expect(r.result.isError).toBe(false);
    expect(r.envelope.error.code).toBe('invalid_argument');
  });
});

describe('feishu adapter unit', () => {
  it('timeout → timeout envelope', async () => {
    const h = await startHarness('feishu');
    try {
      h.control({ scenario: 'slow', sleepMs: 5000 });
      // A tiny request budget: deadline is enforced via the executor's min(24 s, deadline - now).
      const { callTool } = await import('../../container/src/mcp');
      const { loadCatalog } = await import('../../container/src/catalog');
      const { createSemaphore } = await import('../../container/src/semaphore');
      const secrets = new MemorySecrets();
      const adapter = createFeishuAdapter('feishu', { secrets, appId: 'cli_test', appSecretId: 'x' });
      const m = { im: 'feishu' as const, catalog: loadCatalog(`${process.cwd()}/container/tools`, 'feishu'), adapter, withSemaphore: createSemaphore(2, 2) };
      const r = await callTool(m, 'feishu_calendar_agenda', {}, { userId: 'u', userToken: 't', requestId: 'r', signal: new AbortController().signal, deadline: Date.now() + 400 });
      expect(JSON.parse(r.content[0]!.text).error.code).toBe('timeout');
    } finally {
      await h.close();
    }
  });

  it('app secret is cached (one SM read for many calls) and init never throws', async () => {
    const secrets = new MemorySecrets();
    secrets.getImApp = async () => {
      secrets.imAppCalls++;
      throw new Error('no network');
    };
    const a = createFeishuAdapter('feishu', { secrets, appSecretId: 'x' });
    await expect(a.init()).resolves.toBeUndefined();
    await expect(a.prepare({ userId: 'u', userToken: 't', requestId: '', signal: new AbortController().signal, deadline: 0 })).rejects.toBeInstanceOf(ToolError);
    const ok = new MemorySecrets();
    const b = createFeishuAdapter('feishu', { secrets: ok, appSecretId: 'x' });
    for (let i = 0; i < 3; i++) await (await b.prepare({ userId: 'u', userToken: 't', requestId: '', signal: new AbortController().signal, deadline: 0 })).dispose();
    expect(ok.imAppCalls).toBe(1);
  });

  it('stripCliNotice keeps other notice keys and leaves non-notice output alone', () => {
    expect(stripCliNotice('{"a":1,"_notice":{"update":"x","k":2}}')).toBe('{"a":1,"_notice":{"k":2}}');
    expect(stripCliNotice('{"_notice":{"update":"x"},"a":1}')).toBe('{"a":1}');
    expect(stripCliNotice('{"a":"_notice"}')).toBe('{"a":"_notice"}');
  });
});

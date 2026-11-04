import { existsSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionInfo } from '../../container/src/adapters/dingtalk';
import { startHarness, tokenHeaders, type Harness } from './helpers';

const AUTH = 'https://mcp.example.com/authorize?t=incr';

describe('dingtalk adapter via server', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('dingtalk');
  });
  afterAll(() => h.close());

  it('argv: --token <user token> first, then path, -y -f json, flags', async () => {
    h.control({ scenario: 'ok' });
    const r = await h.call('dingtalk_chat_message_send', { conversation_id: 'cid1', content: 'hello', at_all: true }, tokenHeaders('user-a', 'tok-a'));
    expect(r.result.isError).toBeFalsy();
    const c = h.calls().at(-1)!;
    expect(c.bin).toBe('dws');
    expect(c.argv.slice(0, 8)).toEqual(['--token', 'tok-a', 'chat', 'message', 'send', '-y', '-f', 'json']);
    expect(c.argv).toEqual(expect.arrayContaining(['--conversation-id', 'cid1', '--content', 'hello', '--at-all']));
  });

  it('per-call empty config + keychain dirs, update check off, agent code set; dirs removed after', async () => {
    h.control({ scenario: 'ok' });
    await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders('user-a', 'tok-a'));
    const c = h.calls().at(-1)!;
    expect(c.env.DWS_CONFIG_DIR).toMatch(new RegExp(`^${h.tmp}/dws-[^/]+/config$`));
    expect(c.env.DWS_KEYCHAIN_DIR).toMatch(/\/keychain$/);
    expect(c.cwd).toMatch(/\/work$/);
    expect(c.env.DWS_NO_UPDATE_CHECK).toBe('1');
    expect(c.env.DINGTALK_DWS_AGENTCODE).toBe('test-agent');
    expect(c.env.HOME).toBe(h.home);
    expect(Object.keys(c.env).filter((k) => k.startsWith('AWS_'))).toEqual([]);
    expect(existsSync(c.env.DWS_CONFIG_DIR!)).toBe(false);
    expect(readdirSync(h.tmp)).toEqual([]);
  });

  it('two users alternating each send their own --token', async () => {
    h.control({ scenario: 'ok' });
    for (let i = 0; i < 6; i++) {
      const [u, t] = i % 2 ? ['ub', 'tok-b'] : ['ua', 'tok-a'];
      const r = await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders(u, t));
      expect(JSON.parse(r.result.content[0].text).token).toBe(t);
    }
  });

  it('exit 4 PAT JSON → missing_scope with authorize_url', async () => {
    h.control({ scenario: 'pat' });
    const r = await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders('user-a', 'tok-a', AUTH));
    expect(r.envelope.error).toMatchObject({ code: 'missing_scope', required_scopes: ['Contact.User.Read'], im_code: 'PAT_SCOPE_AUTH_REQUIRED' });
    expect(r.envelope.error.authorize_url).toBe(`${AUTH}&extra_scope=Contact.User.Read`);
  });

  it('category permission → missing_scope', async () => {
    h.control({ scenario: 'permission' });
    const r = await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders('user-a', 'tok-a', AUTH));
    expect(r.envelope.error.code).toBe('missing_scope');
    expect(r.envelope.error.required_scopes).toEqual(['a.b', 'c.d']);
  });

  it('exit 2 → im_reauth_required', async () => {
    h.control({ scenario: 'auth' });
    expect((await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders('user-a', 'tok-a'))).envelope.error.code).toBe('im_reauth_required');
  });

  it('exit 1 + TOKEN_VERIFIED_FAILED (observed with dws 1.0.67) → im_reauth_required', async () => {
    h.control({ scenario: 'token_rejected' });
    expect((await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders('user-a', 'tok-a'))).envelope.error.code).toBe('im_reauth_required');
  });

  it('cli_not_enabled → im_admin_action_required', async () => {
    h.control({ scenario: 'admin' });
    expect((await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders('user-a', 'tok-a'))).envelope.error.code).toBe('im_admin_action_required');
  });

  it('other API errors → cli_failed with im_code', async () => {
    h.control({ scenario: 'api' });
    const r = await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders('user-a', 'tok-a'));
    expect(r.envelope.error).toMatchObject({ code: 'cli_failed', im_code: 'E123' });
  });

  it('missing required argument → invalid_argument, CLI not called', async () => {
    const before = h.calls().length;
    const r = await h.call('dingtalk_contact_user_get', {}, tokenHeaders('user-a', 'tok-a'));
    expect(r.envelope.error.code).toBe('invalid_argument');
    expect(r.result.isError).toBe(false);
    expect(h.calls().length).toBe(before);
  });

  it('no user token → im_not_authorized', async () => {
    expect((await h.call('dingtalk_contact_user_get_self', {})).envelope.error.code).toBe('im_not_authorized');
  });
});

describe('dws permissionInfo', () => {
  it('recognises the three shapes and ignores others', () => {
    expect(permissionInfo({ error: 'permission_required', missing_scopes: ['x'] })?.scopes).toEqual(['x']);
    expect(permissionInfo({ error: { reason: 'missing_scope', missing_scopes: ['y'] } })?.scopes).toEqual(['y']);
    expect(permissionInfo({ success: false, code: 'PAT_NO_PERMISSION', data: {} })?.code).toBe('PAT_NO_PERMISSION');
    expect(permissionInfo({ error: { category: 'api' } })).toBeUndefined();
    expect(permissionInfo('nope')).toBeUndefined();
  });
});

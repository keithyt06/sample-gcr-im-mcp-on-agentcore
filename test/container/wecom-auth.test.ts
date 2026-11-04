import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { H } from '../../shared/contract';
import { startHarness, type Harness } from './helpers';

const CONTROL = { [H.userId]: 'user-q', [H.caller]: 'control' };
const SECRET = 'slug/users/user-q';

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ping = async (h: Harness) => ((await (await fetch(`${h.srv.url}/ping`)).json()) as { status: string }).status;

describe('wecom QR auth flow (control RPC)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness('wecom');
  });
  afterEach(() => h.close());

  it('requires Caller: control', async () => {
    expect((await h.rpc('im/auth.start', {}, { [H.userId]: 'user-q' })).body.error.code).toBe(-32601);
  });

  it('start → pending with URL + QR, HealthyBusy; exit 0 → blob saved + tagged, authorized', async () => {
    h.control({ auth: 'success', authDelayMs: 800 });
    expect(await ping(h)).toBe('Healthy');
    const start = (await h.rpc('im/auth.start', {}, CONTROL)).body.result;
    expect(start).toMatchObject({ status: 'pending', authorizeUrl: 'https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=abc123' });
    expect(typeof start.sessionId).toBe('string');
    expect(Buffer.from(start.qrPngBase64, 'base64').length).toBe(200);
    expect(start.expiresAt).toBeGreaterThan(Date.now());
    expect(await ping(h)).toBe('HealthyBusy');

    const init = h.calls().find((c) => c.argv[0] === 'auth')!;
    expect(init.argv).toEqual(['auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', 'qr.png']);
    expect(init.env.WECOM_CLI_CONFIG_DIR!.startsWith(join(h.home, '.wc', 'auth-'))).toBe(true);
    expect(init.cwd.startsWith(`${h.tmp}/wca-`)).toBe(true);

    // same user while pending → same session reused
    const again = (await h.rpc('im/auth.start', {}, CONTROL)).body.result;
    expect(again.sessionId).toBe(start.sessionId);
    expect(again.reused).toBe(true);

    const st = await waitFor(
      async () => (await h.rpc('im/auth.status', { sessionId: start.sessionId }, CONTROL)).body.result,
      (v) => v.status !== 'pending',
    );
    expect(st).toMatchObject({ status: 'authorized', sessionId: start.sessionId, wecomIdentity: { userId: 'wo_alice', userName: 'Alice', botId: 'bot_1' } });
    const saved = h.secrets.users.get(SECRET)!;
    expect(Buffer.from(String(saved.credentials_enc), 'base64').toString()).toMatch(/^CRED-/);
    expect(Buffer.from(String(saved.encryption_key), 'base64').toString()).toMatch(/^KEY-/);
    expect(h.secrets.tags.get(SECRET)).toEqual({ WecomUserId: 'wo_alice' });
    expect(await ping(h)).toBe('Healthy');
    // dirs cleaned up
    expect(existsSync(init.env.WECOM_CLI_CONFIG_DIR!)).toBe(false);
    expect(readdirSync(h.tmp)).toEqual([]);
    // status without sessionId also finds it (retained terminal session)
    expect((await h.rpc('im/auth.status', {}, CONTROL)).body.result.status).toBe('authorized');
    // another user cannot read this session
    expect((await h.rpc('im/auth.status', { sessionId: start.sessionId }, { ...CONTROL, [H.userId]: 'other' })).body.result).toEqual({ status: 'unknown' });
    // existing blob → already_authorized
    expect((await h.rpc('im/auth.start', {}, CONTROL)).body.result).toEqual({ status: 'already_authorized' });
  });

  it('893202 → expired', async () => {
    h.control({ auth: 'timeout', authDelayMs: 100 });
    const start = (await h.rpc('im/auth.start', {}, CONTROL)).body.result;
    const st = await waitFor(
      async () => (await h.rpc('im/auth.status', { sessionId: start.sessionId }, CONTROL)).body.result,
      (v) => v.status !== 'pending',
    );
    expect(st.status).toBe('expired');
    expect(h.secrets.users.has(SECRET)).toBe(false);
  });

  it('other failure → failed with reason', async () => {
    h.control({ auth: 'fail', authDelayMs: 100 });
    const start = (await h.rpc('im/auth.start', {}, CONTROL)).body.result;
    const st = await waitFor(
      async () => (await h.rpc('im/auth.status', { sessionId: start.sessionId }, CONTROL)).body.result,
      (v) => v.status !== 'pending',
    );
    expect(st.status).toBe('failed');
    expect(st.reason).toContain('893210');
  });

  it('unknown session → unknown', async () => {
    expect((await h.rpc('im/auth.status', { sessionId: 'nope' }, CONTROL)).body.result).toEqual({ status: 'unknown' });
  });
});

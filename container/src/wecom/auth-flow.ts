// In-container WeCom QR authorization (`wecom-cli auth init`). Ported from wecom-mcp-on-agentcore
// docker/lib/auth.js (MIT-0).
//
// `auth init` blocks while it polls the QR scan (CLI-internal timeout 300 s), longer than API Gateway
// (29 s) allows, so it runs here in the long-lived Runtime microVM. The Lambda drives it with the
// control RPCs im/auth.start and im/auth.status. Credentials are saved the moment the CLI exits 0
// (push, not pull), so a lost status poll never loses a credential.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { baseEnv, runCli, tmpRoot } from '../cli-runner';
import { log } from '../metrics';
import { readBlob, newConfigDir, type WecomIdentity, type WecomStore } from './credentials';
import { ANSI_RE, extractCliError, stripIdentityContext } from './identity';

export const POLL_TIMEOUT_MS = 300_000; // matches the CLI's own timeout_secs=300
const GRACE_MS = 20_000;
const TERMINAL_RETAIN_MS = 120_000;
const QR_TIMEOUT_CODE = 893202;
const QR_FILE = 'qr.png'; // --output-qrcode only accepts a path relative to cwd
const IDENTITY_PROBE_KEYWORD = '__im_mcp_identity_probe__'; // deliberately matches nobody: identity rides on the envelope
const URL_RE = /https:\/\/work\.weixin\.qq\.com\/ai\/qc\/gen\?\S+/;

type State = 'starting' | 'pending' | 'authorized' | 'expired' | 'failed';

interface Session {
  userId: string;
  child: ChildProcess;
  cfgDir: string;
  cwd: string;
  out: string;
  url: string | null;
  qrPng: string | null;
  startedAt: number;
  state: State;
  exitCode: number | null;
  reason: string | null;
  identity: WecomIdentity | null;
  terminalAt: number | null;
  settled: Promise<void>;
}

export interface AuthFlowOptions {
  bin: string;
  store: WecomStore;
  urlWaitMs?: number;
  now?: () => number;
}

export class WecomAuthFlow {
  private readonly sessions = new Map<string, Session>();
  private readonly byUser = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly o: AuthFlowOptions) {
    this.now = o.now ?? Date.now;
  }

  hasPending(): boolean {
    for (const s of this.sessions.values()) if (isPending(s)) return true;
    return false;
  }

  async start(userId: string): Promise<Record<string, unknown>> {
    if (await this.o.store.load(userId)) return { status: 'already_authorized' };
    const existingId = this.byUser.get(userId);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing && isPending(existing) && this.now() - existing.startedAt < POLL_TIMEOUT_MS) {
      return { ...this.view(existing, existingId!), reused: true };
    }

    const cfgDir = await newConfigDir('auth-');
    const cwd = await mkdtemp(join(tmpRoot(), 'wca-'));
    const child = spawn(this.o.bin, ['auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', QR_FILE], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...baseEnv(), WECOM_CLI_CONFIG_DIR: cfgDir, WECOM_CLI_LOG_DIR: join(cfgDir, 'logs'), WECOM_CLI_LOG_LEVEL: 'info' },
    });
    const sessionId = randomBytes(16).toString('hex');
    const s: Session = {
      userId,
      child,
      cfgDir,
      cwd,
      out: '',
      url: null,
      qrPng: null,
      startedAt: this.now(),
      state: 'starting',
      exitCode: null,
      reason: null,
      identity: null,
      terminalAt: null,
      settled: Promise.resolve(),
    };
    this.sessions.set(sessionId, s);
    this.byUser.set(userId, sessionId);
    child.stdout!.on('data', (b: Buffer) => (s.out += b.toString()));
    child.stderr!.on('data', (b: Buffer) => (s.out += b.toString()));
    s.settled = new Promise<void>((resolve) => {
      let done = false;
      const finish = async (code: number | null) => {
        if (done) return;
        done = true;
        s.exitCode = code ?? -1;
        try {
          await this.onExit(s, sessionId, code);
        } finally {
          s.terminalAt = this.now();
          if (this.byUser.get(s.userId) === sessionId) this.byUser.delete(s.userId);
          s.out = '';
          await Promise.all([rm(s.cfgDir, { recursive: true, force: true }), rm(s.cwd, { recursive: true, force: true })]).catch(() => undefined);
          resolve();
        }
      };
      child.on('error', (e) => {
        s.reason = `spawn_failed: ${e.message}`;
        void finish(-1);
      });
      child.on('exit', (code) => void finish(code));
    });

    const url = await this.waitForUrl(s);
    if (!url) {
      await this.abort(sessionId);
      throw new Error('auth_start_failed: no authorization URL from wecom-cli within the wait window');
    }
    s.url = url;
    s.qrPng = await readQrPng(join(cwd, QR_FILE));
    if (s.state === 'starting') s.state = 'pending';
    return this.view(s, sessionId);
  }

  async status(userId: string, sessionId?: string): Promise<Record<string, unknown>> {
    this.gc();
    let sid = sessionId;
    if (!sid) {
      sid = this.byUser.get(userId);
      if (!sid) for (const [id, s] of this.sessions) if (s.userId === userId) sid = id;
    }
    const s = sid ? this.sessions.get(sid) : undefined;
    if (!s || s.userId !== userId) return { status: 'unknown' };
    if (isPending(s) && this.now() - s.startedAt > POLL_TIMEOUT_MS + GRACE_MS) {
      await this.abort(sid!);
      return { status: 'expired', sessionId: sid, reason: 'wall_clock_timeout' };
    }
    return this.view(s, sid!);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.abort(id)));
    this.sessions.clear();
    this.byUser.clear();
  }

  private async onExit(s: Session, sessionId: string, code: number | null): Promise<void> {
    try {
      if (code === 0) {
        const blob = await readBlob(s.cfgDir);
        if (!blob) {
          s.state = 'failed';
          s.reason = 'credentials_missing_after_success';
          return;
        }
        s.identity = await this.readIdentity(s.cfgDir);
        await this.o.store.save(s.userId, blob, s.identity);
        s.state = 'authorized';
        log('INFO', 'wecom_auth_completed', { userId: s.userId, sessionId, botId: s.identity?.botId ?? null });
      } else {
        const e = extractCliError(s.out);
        s.reason ??= e ? `${e.type}(${e.code}): ${e.message}` : tail(s.out);
        s.state = e?.code === QR_TIMEOUT_CODE ? 'expired' : 'failed';
        log('INFO', `wecom_auth_${s.state}`, { userId: s.userId, sessionId, code: e?.code ?? null });
      }
    } catch (err) {
      s.state = 'failed';
      s.reason = `writeback_failed: ${String((err as Error).message ?? err)}`;
      log('CRITICAL', 'wecom_auth_writeback_failed', { userId: s.userId, sessionId, error: s.reason });
    }
  }

  /** Read the stable WeCom identity of the human who scanned (must run before the dir is removed). */
  private async readIdentity(cfgDir: string): Promise<WecomIdentity | null> {
    const cwd = await mkdtemp(join(tmpRoot(), 'wcp-'));
    try {
      const run = await runCli(this.o.bin, ['contact', 'users', 'search', '--json', JSON.stringify({ keywords: [IDENTITY_PROBE_KEYWORD] })], {
        env: { ...baseEnv(), WECOM_CLI_CONFIG_DIR: cfgDir, WECOM_CLI_LOG_DIR: join(cfgDir, 'logs'), WECOM_CLI_LOG_LEVEL: 'warn' },
        cwd,
        timeoutMs: 15_000,
        maxBuffer: 1024 * 1024,
      });
      const { identity } = stripIdentityContext(JSON.parse(run.stdout));
      if (identity?.authorized_user_id) return { userId: identity.authorized_user_id, userName: identity.authorized_user_name, botId: identity.bot_id };
      log('WARN', 'wecom_identity_probe_empty', { exitCode: run.exitCode });
    } catch (e) {
      log('WARN', 'wecom_identity_probe_failed', { error: String((e as Error).message ?? e) });
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
    return null;
  }

  private view(s: Session, sessionId: string): Record<string, unknown> {
    if (isPending(s)) {
      return { status: 'pending', sessionId, authorizeUrl: s.url, qrPngBase64: s.qrPng, expiresAt: s.startedAt + POLL_TIMEOUT_MS };
    }
    if (s.state === 'authorized') return { status: 'authorized', sessionId, wecomIdentity: s.identity };
    return { status: s.state, sessionId, reason: s.reason };
  }

  private waitForUrl(s: Session): Promise<string | null> {
    const deadline = this.now() + (this.o.urlWaitMs ?? 20_000);
    return new Promise((resolve) => {
      const tick = () => {
        const m = URL_RE.exec(s.out.replace(ANSI_RE, ''));
        if (m) return resolve(m[0]);
        if (s.exitCode !== null || this.now() > deadline) return resolve(null);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  private async abort(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.exitCode === null) {
      try {
        s.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      await s.settled.catch(() => undefined);
    }
    if (this.byUser.get(s.userId) === sessionId) this.byUser.delete(s.userId);
  }

  private gc(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) if (s.terminalAt && now - s.terminalAt > TERMINAL_RETAIN_MS) this.sessions.delete(id);
  }
}

function isPending(s: Session): boolean {
  return s.state === 'starting' || s.state === 'pending';
}

function tail(text: string): string {
  return text.replace(ANSI_RE, '').trim().split('\n').slice(-2).join(' | ').slice(0, 300);
}

/** The CLI writes the PNG and prints the URL in no guaranteed order: poll briefly; null is acceptable. */
async function readQrPng(path: string): Promise<string | null> {
  for (let i = 0; i < 12; i++) {
    try {
      const b = await readFile(path);
      if (b.length > 100) return b.toString('base64');
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

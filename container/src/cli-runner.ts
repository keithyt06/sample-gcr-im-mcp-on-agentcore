// execFile wrapper: timeout, output cap, abort, child tracking. Never rejects.
import { execFile, type ChildProcess } from 'node:child_process';
import type { CliRun } from './adapters/types';

export const activeChildren = new Set<ChildProcess>();

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export function runCli(bin: string, argv: string[], o: RunOptions): Promise<CliRun> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: 'aborted', timedOut: false, overflow: false, aborted: true });
      return;
    }
    const child = execFile(
      bin,
      argv,
      { env: o.env, cwd: o.cwd, timeout: Math.max(1, o.timeoutMs), maxBuffer: o.maxBuffer, signal: o.signal, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        activeChildren.delete(child);
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown }) | null;
        const overflow = e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const aborted = e?.name === 'AbortError' || o.signal?.aborted === true;
        const timedOut = !!e && !overflow && !aborted && (e.killed === true || e.signal === 'SIGTERM');
        const exitCode = e ? (typeof e.code === 'number' ? e.code : null) : 0;
        let errText = stderr ?? '';
        // Never append e.message: it is "Command failed: <bin> <argv...>" and argv carries user tokens (review M-1).
        if (e && exitCode === null && !overflow && !aborted && !timedOut) {
          errText = `${errText}${errText ? '\n' : ''}${bin} terminated (${e.signal ?? (typeof e.code === 'string' ? e.code : 'unknown')})`;
        }
        // Successful stdout is the tool result and passes through; anything from a failed run is redacted.
        const out = stdout ?? '';
        resolve({ exitCode, stdout: exitCode === 0 ? out : redact(out, argv), stderr: redact(errText, argv), timedOut, overflow, aborted });
      },
    );
    activeChildren.add(child);
  });
}

/**
 * The only env a CLI child ever starts from (§5.3): PATH, HOME, LANG, NO_COLOR.
 * The container's AWS credentials and other process env are never passed through.
 */
export function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/home/node', LANG: 'C.UTF-8', NO_COLOR: '1' };
}

/** System temp dir for per-call work dirs (overridable in tests). */
export function tmpRoot(): string {
  return process.env.IM_MCP_TMP_DIR || '/tmp';
}

const SECRET_FLAGS = new Set(['--token', '--access-token', '--secret', '--client-secret', '--app-secret']);

/** Values that must never appear in output returned to the client: the argument after a secret flag. */
export function secretArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (SECRET_FLAGS.has(argv[i]!) && argv[i + 1]) out.push(argv[i + 1]!);
  for (const a of argv) {
    const m = /^--(?:token|access-token|secret|client-secret|app-secret)=(.+)$/.exec(a);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Replace every secret argv value (and `--token <x>` / Bearer patterns) with [REDACTED]. */
export function redact(text: string, argv: string[] = []): string {
  let out = text;
  for (const v of secretArgs(argv)) if (v.length >= 4) out = out.split(v).join('[REDACTED]');
  return out
    .replace(/(--(?:token|access-token|secret|client-secret|app-secret)[ =])\S+/g, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[REDACTED]');
}

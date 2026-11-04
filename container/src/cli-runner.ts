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
        if (e && exitCode === null && !overflow && !aborted && !timedOut) errText = `${errText}${errText ? '\n' : ''}${e.message}`;
        resolve({ exitCode, stdout: stdout ?? '', stderr: errText, timedOut, overflow, aborted });
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

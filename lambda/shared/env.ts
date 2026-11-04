// Typed environment reader. Values are read at call time (not module load) so
// tests can set process.env per case, and so a missing variable fails the
// request that needs it with a clear message instead of crashing cold start.
import { ENV, IMS, type EnvName, type Im } from '../../shared/contract';

export class MissingEnvError extends Error {
  constructor(name: string) {
    super(`missing required environment variable ${name}`);
    this.name = 'MissingEnvError';
  }
}

/** Required variable. Throws MissingEnvError when unset or empty. */
export function env(name: EnvName): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new MissingEnvError(name);
  return v;
}

/** Optional variable; empty string counts as unset. */
export function envOpt(name: EnvName): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

/** Comma-separated list; trims entries and drops empties. */
export function envList(name: EnvName): string[] {
  return (envOpt(name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function envIm(): Im {
  const v = env(ENV.IM);
  if (!(IMS as readonly string[]).includes(v)) throw new MissingEnvError(`${ENV.IM} (invalid value)`);
  return v as Im;
}

export function isRedirectIm(im: Im): im is 'feishu' | 'lark' | 'dingtalk' {
  return im !== 'wecom';
}

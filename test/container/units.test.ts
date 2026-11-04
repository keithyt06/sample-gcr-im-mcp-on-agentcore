import { describe, expect, it } from 'vitest';
import { redact, runCli, secretArgs } from '../../container/src/cli-runner';
import { envelope } from '../../container/src/errors';
import { hashUserId } from '../../container/src/metrics';
import { isGone } from '../../container/src/secrets';

describe('redaction (review M-1)', () => {
  it('redacts the value after secret flags and Bearer tokens', () => {
    expect(secretArgs(['--token', 'abc123', 'x', '--client-secret=zzz999'])).toEqual(['abc123', 'zzz999']);
    expect(redact('Command failed: dws --token abc123 contact', ['--token', 'abc123'])).toBe('Command failed: dws --token [REDACTED] contact');
    expect(redact('echo abc123 again', ['--token', 'abc123'])).toBe('echo [REDACTED] again');
    expect(redact('Authorization: Bearer eyJhbGciOi.abc')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('envelope messages are redacted', () => {
    const r = envelope('cli_failed', 'dws --token secrettoken1 failed');
    expect(r.content[0]!.text).not.toContain('secrettoken1');
  });

  it('runCli never reports execFile e.message (which embeds argv) on signal death', async () => {
    const run = await runCli('sh', ['-c', 'kill -9 $$', '--token', 'tok-abcdef'], { env: { PATH: process.env.PATH }, cwd: '/tmp', timeoutMs: 5000, maxBuffer: 1024 });
    expect(run.exitCode).toBeNull();
    expect(run.stderr).toContain('SIGKILL');
    expect(run.stderr).not.toContain('tok-abcdef');
    expect(run.stderr).not.toContain('Command failed');
  });
});

describe('isGone (review L-3)', () => {
  it('treats not-found and pending-deletion as no credential', () => {
    expect(isGone(Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }))).toBe(true);
    expect(isGone(Object.assign(new Error("You can't perform this operation on the secret because it was marked for deletion."), { name: 'InvalidRequestException' }))).toBe(true);
    expect(isGone(Object.assign(new Error('other'), { name: 'InvalidRequestException' }))).toBe(false);
    expect(isGone(Object.assign(new Error('throttle'), { name: 'ThrottlingException' }))).toBe(false);
  });
});

describe('hashUserId (review L-4)', () => {
  it('matches the lambda format (16 hex of sha256)', () => {
    expect(hashUserId('user-a')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashUserId('user-a')).not.toContain('user-a');
  });
});

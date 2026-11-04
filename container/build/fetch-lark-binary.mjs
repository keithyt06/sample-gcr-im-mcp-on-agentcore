#!/usr/bin/env node
// Download the lark-cli native binary from the npm binary mirror and verify it against the
// package's own checksums.txt. Replaces the upstream postinstall (which needs curl and tries
// GitHub first). Same on-disk layout as upstream install.js: <pkg>/bin/lark-cli.
//
// Env: LARK_BINARY_BASE (default https://registry.npmmirror.com/-/binary/lark-cli),
//      LARK_PKG_DIR (default: $(npm root -g)/@larksuite/cli), LARK_PLATFORM (default linux-arm64).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = (process.env.LARK_BINARY_BASE || 'https://registry.npmmirror.com/-/binary/lark-cli').replace(/\/+$/, '');
const pkgDir =
  process.env.LARK_PKG_DIR || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@larksuite', 'cli');
const platform = process.env.LARK_PLATFORM || 'linux-arm64';
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const archive = `lark-cli-${version}-${platform}.tar.gz`;
const url = `${base}/v${version}/${archive}`;

function expectedSha() {
  for (const line of readFileSync(join(pkgDir, 'checksums.txt'), 'utf8').split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === archive && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  throw new Error(`no checksum for ${archive} in checksums.txt`);
}

async function download() {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      console.error(`download attempt ${attempt} failed: ${e.message}`);
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
  throw lastErr;
}

const want = expectedSha();
console.log(`fetching ${url}`);
const buf = await download();
const got = createHash('sha256').update(buf).digest('hex');
if (got !== want) throw new Error(`checksum mismatch for ${archive}: expected ${want}, got ${got}`);
const tmp = mkdtempSync(join(tmpdir(), 'lark-cli-'));
try {
  writeFileSync(join(tmp, archive), buf);
  execFileSync('tar', ['-xzf', join(tmp, archive), '-C', tmp]);
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  copyFileSync(join(tmp, 'lark-cli'), join(pkgDir, 'bin', 'lark-cli'));
  chmodSync(join(pkgDir, 'bin', 'lark-cli'), 0o755);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`lark-cli ${version} (${platform}) installed, sha256 ${got}`);

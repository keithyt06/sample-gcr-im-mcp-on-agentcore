// D11 regression: with the REAL dws binary, two users alternating through the real adapter must each
// send their own Bearer token. Runs only with DWS_REAL=1 (dws 1.0.67 on PATH, or DWS_BIN=<path>).
//   DWS_REAL=1 DWS_BIN=.cache/cli/dingtalk/node_modules/dingtalk-workspace-cli/vendor/dws npx vitest run test/container/dws-isolation.test.ts
// MUST pass before any dws version bump.
//
// Mock endpoint: dws reads DINGTALK_<PRODUCT>_MCP_URL (internal/app/runner.go productEndpointOverride)
// and allows plain http only with DWS_ALLOW_HTTP_ENDPOINTS=1 (internal/transport/client.go).
// Product: contact (`contact user get-self` -> tools/call get_current_user_profile).
// Asserted headers: `Authorization: Bearer <token>` and `x-user-access-token: <token>` (client.go:884).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, tokenHeaders, type Harness } from './helpers';

const RUN = process.env.DWS_REAL === '1';

describe.skipIf(!RUN)('dws isolation (real dws)', () => {
  let h: Harness;
  let mock: http.Server;
  let binDir: string;
  const seen: { auth?: string; x?: string; method?: string }[] = [];

  beforeAll(async () => {
    mock = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        let msg: { id?: number; method?: string } = {};
        try {
          msg = JSON.parse(b);
        } catch {
          /* ignore */
        }
        seen.push({ auth: req.headers.authorization, x: req.headers['x-user-access-token'] as string, method: msg.method });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (msg.id === undefined) return res.end();
        if (msg.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } }));
        if (msg.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ echoedAuth: req.headers.authorization }) }] } }));
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    const port = (mock.address() as AddressInfo).port;
    // Put the real binary first on PATH as `dws`.
    binDir = mkdtempSync(join(tmpdir(), 'dws-real-'));
    const real = process.env.DWS_BIN ? resolve(process.env.DWS_BIN) : execFileSync('sh', ['-c', 'command -v dws'], { encoding: 'utf8' }).trim();
    symlinkSync(real, join(binDir, 'dws'));
    mkdirSync(join(binDir, 'empty'));
    expect(execFileSync(join(binDir, 'dws'), ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(binDir, 'empty'), DWS_NO_UPDATE_CHECK: '1' } })).toMatch(/v1\.0\.67/);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    h = await startHarness('dingtalk', {
      adapterDeps: { dwsExtraEnv: { DINGTALK_CONTACT_MCP_URL: `http://127.0.0.1:${port}/contact`, DWS_ALLOW_HTTP_ENDPOINTS: '1' } },
    });
    // startHarness prepends the fakes dir; put the real binary back in front.
    process.env.PATH = `${binDir}:${process.env.PATH}`;
  });

  afterAll(async () => {
    await h?.close();
    mock?.close();
    rmSync(binDir, { recursive: true, force: true });
  });

  it('users A and B alternate 10 calls each; every request carries its own token', async () => {
    for (let i = 0; i < 20; i++) {
      const [u, t] = i % 2 === 0 ? ['user-a', 'token-A-0123456789'] : ['user-b', 'token-B-9876543210'];
      const before = seen.length;
      const r = await h.call('dingtalk_contact_user_get_self', {}, tokenHeaders(u, t));
      expect(r.result.isError, JSON.stringify(r.result)).toBeFalsy();
      const reqs = seen.slice(before);
      expect(reqs.length).toBeGreaterThan(0);
      for (const q of reqs) {
        expect(q.auth).toBe(`Bearer ${t}`);
        expect(q.x).toBe(t);
      }
      expect(JSON.parse(r.result.content[0].text).echoedAuth).toBe(`Bearer ${t}`);
    }
    expect(seen.filter((q) => q.method === 'tools/call').length).toBe(20);
  }, 120_000);
});

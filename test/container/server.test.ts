import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { H } from '../../shared/contract';
import { CLI } from '../../shared/versions';
import { startHarness, tokenHeaders, TOOLS_DIR, type Harness } from './helpers';

const tier1 = (fam: string) => (JSON.parse(readFileSync(join(TOOLS_DIR, fam, 'tier1.json'), 'utf8')) as string[]).length;

describe('server (feishu)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('feishu');
  });
  afterAll(() => h.close());

  it('GET /ping is healthy with no IM app secret loaded (R2)', async () => {
    h.secrets.imApp = { configured: false };
    const r = await fetch(`${h.srv.url}/ping`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { status: string; time_of_last_update: number };
    expect(j.status).toBe('Healthy');
    expect(typeof j.time_of_last_update).toBe('number');
    const j2 = (await (await fetch(`${h.srv.url}/ping`)).json()) as { time_of_last_update: number };
    expect(j2.time_of_last_update).toBe(j.time_of_last_update);
    h.secrets.imApp = { appId: 'cli_test', appSecret: 's3cret', configured: true };
  });

  it('404 for other paths and GET /mcp', async () => {
    expect((await fetch(`${h.srv.url}/mcp`)).status).toBe(404);
    expect((await fetch(`${h.srv.url}/nope`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('413 for bodies over 1 MB', async () => {
    const r = await fetch(`${h.srv.url}/mcp`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 10) }).catch(() => undefined);
    if (r) expect(r.status).toBe(413);
  });

  it('notifications get 202 with no body', async () => {
    const r = await h.rpc('notifications/initialized', {}, {}, null);
    expect(r.status).toBe(202);
    expect(r.raw).toBe('');
  });

  it('parse errors / non-object bodies are JSON-RPC errors in one SSE frame', async () => {
    const r = await fetch(`${h.srv.url}/mcp`, { method: 'POST', body: '{bad' });
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(await r.text()).toContain('-32700');
    const r2 = await fetch(`${h.srv.url}/mcp`, { method: 'POST', body: '[1]' });
    expect(await r2.text()).toContain('-32600');
  });

  it('initialize negotiates protocol version and reports the CLI', async () => {
    const r = await h.rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(r.raw.startsWith('event: message\ndata: ')).toBe(true);
    expect(r.body.result.protocolVersion).toBe('2025-06-18');
    expect(r.body.result.serverInfo).toMatchObject({ name: 'gcr-im-mcp-on-agentcore', cli: { name: CLI.lark.pkg, version: CLI.lark.version } });
    expect(r.body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect((await h.rpc('initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion).toBe('2025-03-26');
  });

  it('tools/list = tier1 + discover + invoke, prefixed, with annotations', async () => {
    const r = await h.rpc('tools/list');
    const tools = r.body.result.tools as { name: string; annotations: Record<string, boolean>; inputSchema: any }[];
    expect(tools.length).toBe(tier1('lark') + 2);
    expect(tools.every((t) => t.name.startsWith('feishu_'))).toBe(true);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['feishu_discover', 'feishu_invoke', 'feishu_im_messages_send']));
    const send = tools.find((t) => t.name === 'feishu_im_messages_send')!;
    expect(send.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const read = tools.find((t) => t.name === 'feishu_calendar_agenda')!;
    expect(read.annotations.readOnlyHint).toBe(true);
  });

  it('ping and unknown methods', async () => {
    expect((await h.rpc('ping')).body.result).toEqual({});
    expect((await h.rpc('resources/list')).body.error.code).toBe(-32601);
  });

  it('control RPCs are refused for non-wecom IMs and without Caller: control', async () => {
    expect((await h.rpc('im/auth.start', {}, { [H.caller]: 'control' })).body.error.code).toBe(-32601);
    expect((await h.rpc('im/auth.start', {})).body.error.code).toBe(-32601);
  });

  it('discover and invoke', async () => {
    const d = await h.call('feishu_discover', { query: 'wiki space', limit: 3 });
    const found = JSON.parse(d.result.content[0].text).tools;
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(3);
    expect(found[0].name.startsWith('feishu_')).toBe(true);
    h.control({ scenario: 'ok' });
    const target = found.find((t: any) => t.risk !== 'high-risk-write') ?? found[0];
    const inv = await h.call('feishu_invoke', { tool_name: target.name, args: {} }, tokenHeaders('user-a', 'tok-a'));
    if (target.risk === 'high-risk-write') expect(inv.envelope.error.code).toBe('user_approval_required');
    else expect(inv.result.isError).toBeFalsy();
    // invoke also accepts unprefixed names
    const inv2 = await h.call('feishu_invoke', { tool_name: 'calendar_agenda', args: {} }, tokenHeaders('user-a', 'tok-a'));
    expect(inv2.result.isError).toBeFalsy();
  });

  it('unknown tools are self-correctable (isError:false); non-tier-1 direct calls are unknown', async () => {
    const r = await h.call('feishu_nope', {});
    expect(r.result.isError).toBe(false);
    expect(r.envelope.error.code).toBe('unknown_tool');
    const r2 = await h.call('feishu_wiki_space_list', {});
    expect(r2.envelope.error.code).toBe('unknown_tool');
  });

  it('confirm gate for high-risk writes, then --yes is passed', async () => {
    const r = await h.call('feishu_invoke', { tool_name: 'drive_delete', args: { file_token: 'f1', type: 'file' } }, tokenHeaders('user-a', 'tok-a'));
    expect(r.result.isError).toBe(false);
    expect(r.envelope.error.code).toBe('user_approval_required');
    const before = h.calls().length;
    const ok = await h.call('feishu_invoke', { tool_name: 'drive_delete', args: { file_token: 'f1', type: 'file', _confirm: true } }, tokenHeaders('user-a', 'tok-a'));
    expect(ok.result.isError).toBeFalsy();
    const last = h.calls().slice(before).at(-1)!;
    expect(last.argv).toEqual(['drive', '+delete', '--file-token', 'f1', '--type', 'file', '--yes']);
  });

  it('server_busy when the queue is full', async () => {
    const h2 = await startHarness('feishu', { maxConcurrent: 1, maxQueue: 0 });
    try {
      h2.control({ scenario: 'slow', sleepMs: 800 });
      const hdr = tokenHeaders('user-a', 'tok-a');
      const [a, b] = await Promise.all([h2.call('feishu_calendar_agenda', {}, hdr), new Promise((r) => setTimeout(r, 150)).then(() => h2.call('feishu_calendar_agenda', {}, hdr))]);
      expect(a.result.isError).toBeFalsy();
      expect(b.envelope.error.code).toBe('server_busy');
      expect(b.result.isError).toBe(true);
    } finally {
      await h2.close();
    }
  });
});

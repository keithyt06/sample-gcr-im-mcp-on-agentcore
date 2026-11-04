import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI } from '../../shared/versions';
import { discover, listTools, loadCatalog, resolveTool } from '../../container/src/catalog';
import type { Catalog, Family } from '../../container/src/adapters/types';
import { ROOT, TOOLS_DIR } from './helpers';

const FAMILIES: Family[] = ['lark', 'dingtalk', 'wecom'];

describe.each(FAMILIES)('catalog %s', (fam) => {
  const catalog = JSON.parse(readFileSync(join(TOOLS_DIR, fam, 'catalog.json'), 'utf8')) as Catalog;
  const tier1 = JSON.parse(readFileSync(join(TOOLS_DIR, fam, 'tier1.json'), 'utf8')) as string[];
  const byName = new Map(catalog.tools.map((t) => [t.name, t]));

  it('cliVersion matches shared/versions.ts', () => {
    expect(catalog.family).toBe(fam);
    expect(catalog.cliVersion).toBe(CLI[fam].version);
  });

  it('every tier-1 name resolves and is runnable', () => {
    expect(tier1.length).toBeGreaterThan(0);
    for (const n of tier1) {
      expect(byName.has(n), n).toBe(true);
      expect(byName.get(n)!.unavailable, n).toBeUndefined();
    }
    expect(new Set(tier1).size).toBe(tier1.length);
  });

  it('no available tool can spawn local processes or daemons (review H-2)', () => {
    const danger = new Set(['agent-cmd', 'agent-workdir', 'daemon', 'alwayson', 'yolo']);
    for (const t of catalog.tools) {
      if (t.unavailable) continue;
      expect((t.cli.flags ?? []).filter((f) => danger.has(f.name)), t.name).toEqual([]);
      expect(t.name, t.name).not.toMatch(/^dingtalk_tag_connect|^dingtalk_tag_manage_login$|^mail_watch$/);
    }
  });

  it('no available tool takes a local file path (review M-6)', () => {
    const fileFlags = new Set(['file', 'file-path', 'output', 'output-dir', 'output-path', 'local-dir', 'local-folder', 'body-file', 'content-file', 'records-file', 'media-files', 'dir']);
    for (const t of catalog.tools) {
      if (t.unavailable) continue;
      expect((t.cli.flags ?? []).filter((f) => fileFlags.has(f.name)).map((f) => f.name), t.name).toEqual([]);
    }
  });

  it('destructive names always require confirmation (review M-5)', () => {
    for (const t of catalog.tools) {
      if (/(^|_)(delete|remove|recall|transfer_owner|revoke|clear|disband|kick)(_|$)/.test(t.name)) expect(t.risk, t.name).toBe('high-risk-write');
    }
  });

  it('tool names are unique, unprefixed and fit MCP limits', () => {
    expect(byName.size).toBe(catalog.tools.length);
    for (const t of catalog.tools) {
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect(`dingtalk_${t.name}`.length).toBeLessThanOrEqual(64);
      expect(['read', 'write', 'high-risk-write']).toContain(t.risk);
      expect(t.inputSchema.type).toBe('object');
    }
  });
});

describe('catalog loading', () => {
  it('feishu and lark share the lark family with their own prefix', () => {
    const f = loadCatalog(TOOLS_DIR, 'feishu');
    const l = loadCatalog(TOOLS_DIR, 'lark');
    expect(f.catalog.family).toBe('lark');
    expect(listTools(f)[0]!.name.startsWith('feishu_')).toBe(true);
    expect(listTools(l)[0]!.name.startsWith('lark_')).toBe(true);
  });

  it('resolves with or without the prefix', () => {
    const c = loadCatalog(TOOLS_DIR, 'dingtalk');
    expect(resolveTool(c, 'dingtalk_chat_message_send')?.name).toBe('chat_message_send');
    expect(resolveTool(c, 'chat_message_send')?.name).toBe('chat_message_send');
    expect(resolveTool(c, 'nope')).toBeUndefined();
  });

  it('discover excludes tier-1, ranks exact names first, honours category and limit', () => {
    const c = loadCatalog(TOOLS_DIR, 'feishu');
    const exact = discover(c, { query: 'feishu_wiki_space_list' });
    const nonTier1 = c.catalog.tools.find((t) => !c.tier1Names.has(t.name))!;
    expect(discover(c, { query: nonTier1.name })[0]!.name).toBe(`feishu_${nonTier1.name}`);
    expect(exact.length).toBeLessThanOrEqual(10);
    const all = discover(c, { query: 'message', limit: 20 });
    expect(all.length).toBe(20);
    for (const r of all) expect(c.tier1Names.has(String(r.name).slice('feishu_'.length))).toBe(false);
    const cat = discover(c, { category: 'wiki', limit: 5 });
    expect(cat.length).toBe(5);
    for (const r of cat) expect(r.category).toBe('wiki');
    expect(discover(c, { query: 'x', limit: 99 }).length).toBeLessThanOrEqual(20);
  });

  it('config/scopes/feishu.json = offline_access + union of tier-1 scopes (sorted)', () => {
    const c = loadCatalog(TOOLS_DIR, 'feishu');
    const want = new Set(['offline_access']);
    for (const t of c.tier1) for (const s of t.scopes ?? []) want.add(s);
    const j = JSON.parse(readFileSync(join(ROOT, 'config/scopes/feishu.json'), 'utf8'));
    expect(j.scopes.tenant).toEqual([]);
    expect(j.scopes.user).toEqual([...want].sort());
  });

  it('wecom file-path methods are unavailable and never tier-1', () => {
    const c = loadCatalog(TOOLS_DIR, 'wecom');
    for (const n of ['media_upload', 'disk_files_upload', 'disk_files_download', 'doc_import', 'sheet_import', 'smartsheet_images_upload']) {
      expect(c.byName.get(n)?.unavailable, n).toBeTruthy();
      expect(c.tier1Names.has(n)).toBe(false);
    }
  });
});

describe('CLI integrity pins (review M-7)', () => {
  it('container/build/cli-integrity.json pins every package in shared/versions.ts', () => {
    const pins = JSON.parse(readFileSync(join(ROOT, 'container/build/cli-integrity.json'), 'utf8')) as Record<string, string>;
    const want = [`${CLI.lark.pkg}@${CLI.lark.version}`, `${CLI.dingtalk.pkg}@${CLI.dingtalk.version}`, `${CLI.wecom.pkg}@${CLI.wecom.version}`, `${CLI.wecom.platformPkg}@${CLI.wecom.version}`];
    for (const k of want) expect(pins[k], k).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });
});

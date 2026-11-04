// Generate container/tools/<family>/catalog.json from the pinned IM CLI (technical design §5.5, R3).
//
//   npm run gen:catalog -- --cli lark|dingtalk|wecom [--check]
//
// Platform note (review L-5): introspection uses the HOST-platform build of the pinned CLI, while the
// image ships linux-arm64. Help/schema output is embedded in the CLI source and is platform-independent
// in practice; the Ops image check should diff `<bin> --version` (and one `--help`) inside the image
// against catalog.cliVersion. Running this script inside an arm64 container works too (needs QEMU).
//
// Installs the pinned CLI (host platform build) into .cache/cli/<family>, introspects it, writes
// catalog.json, and validates that every tier1.json name resolves and is runnable. For lark it also
// writes config/scopes/feishu.json. Output is deterministic except `generatedAt`; --check compares
// against the committed file instead of writing.
//
// Sources ported: Lark sample docker/generate-tools{,-lib}.js (MIT-0); WeCom sample
// tools/{extract-schemas,to_mcp_schema}.py (MIT-0). DingTalk uses dws 1.0.67's machine contract
// (`dws schema --all -f json`) instead of the help-tree walk of quick-dingtalk-mcp.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CLI } from '../shared/versions';
import type { Catalog, CatalogTool, Family, FlagSpec, Risk } from '../container/src/adapters/types';

const pexec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_TOOL_NAME = 64 - 'dingtalk_'.length; // MCP clients commonly cap tool names at 64 chars

// ---------------------------------------------------------------- shared helpers

function installCli(fam: Family): string {
  const prefix = join(ROOT, '.cache/cli', fam);
  const c = CLI[fam];
  const pkgs = [`${c.pkg}@${c.version}`];
  const pkgJson = join(prefix, 'node_modules', c.pkg, 'package.json');
  const have = existsSync(pkgJson) ? (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string }).version : '';
  if (have !== c.version) {
    mkdirSync(prefix, { recursive: true });
    const args = ['i', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', ...pkgs];
    if (fam === 'lark') args.push('--ignore-scripts');
    execFileSync('npm', args, { stdio: 'inherit', env: { ...process.env, DWS_NO_SKILLS: '1' } });
  }
  if (fam === 'lark') {
    const pkgDir = join(prefix, 'node_modules', c.pkg);
    if (!existsSync(join(pkgDir, 'bin', 'lark-cli'))) {
      const plat = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
      execFileSync('node', [join(ROOT, 'container/build/fetch-lark-binary.mjs')], { stdio: 'inherit', env: { ...process.env, LARK_PKG_DIR: pkgDir, LARK_PLATFORM: plat } });
    }
    return join(pkgDir, 'bin', 'lark-cli');
  }
  if (fam === 'dingtalk') return join(prefix, 'node_modules', c.pkg, 'vendor', 'dws');
  return join(prefix, 'node_modules', '.bin', 'wecom-cli');
}

function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'gen-catalog-'));
  return { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', NO_COLOR: '1', DWS_NO_UPDATE_CHECK: '1', ...extra };
}

async function run(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  try {
    const { stdout } = await pexec(bin, args, { env, cwd, timeout: 30_000, maxBuffer: 200 * 1024 * 1024, encoding: 'utf8' });
    return stdout;
  } catch (e) {
    const o = e as { stdout?: string };
    return o.stdout ?? '';
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

const toKey = (flag: string) => flag.replace(/-/g, '_');

function schemaFromFlags(flags: (FlagSpec & { description?: string; enum?: string[] })[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of flags) {
    const p: Record<string, unknown> = {};
    if (f.type === 'bool') p.type = 'boolean';
    else if (f.type === 'int') p.type = 'number';
    else if (f.type === 'stringArray') p.type = 'array';
    else p.type = 'string';
    if (f.type === 'stringArray') p.items = { type: 'string', ...(f.enum ? { enum: f.enum } : {}) };
    else if (f.enum) p.enum = f.enum;
    if (f.description) p.description = f.description;
    properties[f.key] = p;
    if (f.required) required.push(f.key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

const stripFlagExtras = (f: FlagSpec & { description?: string; enum?: string[] }): FlagSpec => ({ name: f.name, key: f.key, type: f.type, required: f.required });

// ---------------------------------------------------------------- lark

// `--json` is hidden only in its boolean shorthand form (some commands take a JSON payload via --json <string>).
const LARK_HIDDEN = new Set(['yes', 'dry-run', 'jq', 'print-schema', 'flag-name', 'help']);
const NUMBER_TOKENS = new Set(['int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'float', 'float32', 'float64', 'count']);
const LARK_SKIP_SERVICES = new Set(['api', 'auth', 'config', 'doctor', 'help', 'profile', 'schema', 'update', 'event', 'skill', 'skills', 'completion']);

function larkFlagType(rest: string): FlagSpec['type'] {
  const token = rest.match(/^(.+?)\s{2,}/)?.[1];
  if (/\(default:? (false|true)\)/i.test(rest)) return 'bool';
  if (!token || token === 'true' || token === 'false' || /^--\S+=(true|false)$/.test(token)) return 'bool';
  if (NUMBER_TOKENS.has(token)) return 'int';
  if (token === 'stringArray' || token === 'stringSlice' || token === 'strings') return 'stringArray';
  return 'string';
}

export function parseLarkFlags(help: string): { flags: (FlagSpec & { description: string; enum?: string[] })[]; supportsYes: boolean } {
  const flags: (FlagSpec & { description: string; enum?: string[] })[] = [];
  let supportsYes = false;
  for (const line of help.split('\n')) {
    const m = line.match(/^\s+--(\S+)\s+(.+)/);
    if (!m) continue;
    const [, name, rest] = m as unknown as [string, string, string];
    if (name === 'yes') {
      supportsYes = true;
      continue;
    }
    if (LARK_HIDDEN.has(name)) continue;
    const type = larkFlagType(rest);
    if (name === 'json' && type === 'bool') continue;
    const enumM = rest.match(/\(enum:\s*([^)]+)\)/);
    const tok = rest.match(/^(.+?)\s{2,}/)?.[1];
    let desc = type === 'bool' || !tok ? rest : rest.slice(tok.length);
    desc = desc.replace(/\s*\(required\)/, '').replace(/\s*\(enum:[^)]+\)/, '').trim();
    flags.push({ name, key: toKey(name), type, required: rest.includes('(required)'), description: translateLarkDescription(desc), ...(enumM ? { enum: enumM[1]!.split(',').map((s) => s.trim()) } : {}) });
  }
  return { flags, supportsYes };
}

/** Remove CLI-only advice (@file/stdin, lark-cli commands, --flag refs) from agent-facing text. */
export function translateLarkDescription(desc: string): string {
  let out = desc;
  out = out.replace(/\s*\(supports (?:@file|- reads stdin)(?:[^()]|\([^()]*\))*\)/g, '');
  out = out.replace(/;?\s*supports @file[^.;)]*/gi, '');
  out = out.replace(/\s*\(@file or -(?:[^()]|\([^()]*\))*\)/g, '');
  out = out.replace(/,?\s*or @file\s*\/\s*-\s*for stdin/gi, '');
  out = out.replace(/\s+or @file/gi, '');
  out = out.replace(/,?\s*inline or via @file(?:\/-)?/gi, '');
  out = out.replace(/[;,]?\s*(?:use\s+)?@[a-z][a-z0-9-]*,?\s*or\s+-\s+for stdin/gi, '');
  out = out.replace(/[;—–-]?\s*run\s+`?--print-schema`?[^.;]*/gi, '');
  out = out.replace(/For basic flags use lark-cli[^.;]*[.;]?\s*/gi, '');
  out = out.replace(/for composite JSON flags use\s+--print-schema[^.;]*[.;]?\s*/gi, '');
  out = out.replace(/[^.;]*`lark-cli [^`]*`[^.;]*[.;]?/g, '');
  out = out.replace(/(^|[\s(`])--([a-z][a-z0-9-]*)/g, (_m, pre: string, flag: string) => `${pre}${toKey(flag)}`);
  return out.replace(/\s{2,}/g, ' ').trim();
}

function larkRisk(help: string, command: string): Risk {
  for (const line of help.split('\n')) {
    const m = line.match(/^\s*Risk:\s*(high-risk-write|write|read)\b/i);
    if (m) return m[1]!.toLowerCase() as Risk;
  }
  const lower = help.split(/\n(?=(?:When to use|Avoid when|Prerequisites|Tips|Examples):)/)[0]!.toLowerCase();
  if (lower.includes('destructive') || /delete|remove/.test(command)) return 'high-risk-write';
  if (/create|send|update|patch/.test(command)) return 'write';
  return 'read';
}

function parseSection(help: string, header: RegExp): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  let inSection = false;
  for (const line of help.split('\n')) {
    if (/^[A-Za-z].*:\s*$/.test(line)) {
      inSection = header.test(line);
      continue;
    }
    if (!inSection) continue;
    if (/^\s*$/.test(line)) {
      inSection = false;
      continue;
    }
    const m = line.match(/^\s{2,4}(\+?[a-z][a-z0-9_.-]*)\s+(.+)/);
    if (m) out.push({ name: m[1]!, description: m[2]!.trim() });
  }
  return out;
}

async function genLark(bin: string): Promise<{ tools: CatalogTool[]; version: string }> {
  const env = isolatedEnv({ LARKSUITE_CLI_APP_ID: 'build', LARKSUITE_CLI_APP_SECRET: 'build', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'build', LARKSUITE_CLI_BRAND: 'feishu', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' });
  const version = (await run(bin, ['--version'], env)).match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown';
  const scopeData = JSON.parse(readFileSync(join(ROOT, 'scripts/data/lark-shortcut-scopes.json'), 'utf8')) as {
    shortcuts: { service: string; command: string; scopes?: string[]; userCallable?: boolean }[];
  };
  const scopeMap = new Map(scopeData.shortcuts.map((s) => [`${s.service}:${s.command}`, s]));
  const noPlus = new Set(scopeData.shortcuts.filter((s) => !s.command.startsWith('+')).map((s) => `${s.service}:${s.command}`));
  const rootHelp = await run(bin, ['--help'], env);
  const services = parseSection(rootHelp, /^Lark domains:/).map((s) => s.name).filter((s) => !LARK_SKIP_SERVICES.has(s));
  const entries: { service: string; command: string; description: string }[] = [];
  for (const service of services) {
    const help = await run(bin, [service, '--help'], env);
    for (const c of parseSection(help, /^Available Commands:/)) {
      if (!c.name.startsWith('+') && !noPlus.has(`${service}:${c.name}`)) continue;
      if (scopeMap.get(`${service}:${c.name}`)?.userCallable === false) continue;
      entries.push({ service, command: c.name, description: c.description });
    }
  }
  const tools = await pool(entries, 8, async (e): Promise<CatalogTool> => {
    const help = await run(bin, [e.service, e.command, '--help'], env);
    const { flags, supportsYes } = parseLarkFlags(help);
    const scopes = scopeMap.get(`${e.service}:${e.command}`)?.scopes ?? [];
    return {
      name: `${e.service}_${e.command.replace(/^\+/, '').replace(/-/g, '_')}`,
      description: translateLarkDescription(e.description),
      inputSchema: schemaFromFlags(flags),
      risk: larkRisk(help, e.command),
      cli: { path: [e.service, e.command], argStyle: 'flags', flags: flags.map(stripFlagExtras), ...(supportsYes ? { supportsYes: true } : {}) },
      ...(scopes.length ? { scopes: [...scopes].sort() } : {}),
      category: e.service,
    };
  });
  return { tools, version };
}

// ---------------------------------------------------------------- dingtalk

/** Products that are local utilities / developer tooling, not user workspace capabilities. */
const DWS_SKIP_PRODUCTS = new Set(['aicard', 'audit', 'dev', 'devapp', 'event', 'html', 'markdown', 'mcp', 'pat']);
const DWS_HIDDEN = new Set(['yes', 'y', 'dry-run', 'help', 'format', 'f', 'jq', 'fields', 'profile', 'client-id', 'client-secret', 'mock', 'debug', 'verbose', 'timeout', 'token']);

interface DwsParam { type?: string; description?: string; required?: boolean; enum?: unknown[]; default?: unknown }
interface DwsTool { cli_path: string; cli_name: string; product_id: string; description?: string; agent_summary?: string; effect?: string; confirmation?: string; availability?: string; parameters?: Record<string, DwsParam> }

async function genDingtalk(bin: string): Promise<{ tools: CatalogTool[]; version: string }> {
  const env = isolatedEnv();
  const version = (await run(bin, ['--version'], env)).match(/v(\d+\.\d+\.\d+)/)?.[1] ?? 'unknown';
  const all = JSON.parse(await run(bin, ['schema', '--all', '-f', 'json'], env)) as { products: { id: string; tools: DwsTool[] }[] };
  const list: DwsTool[] = [];
  for (const p of all.products) {
    if (DWS_SKIP_PRODUCTS.has(p.id)) continue;
    for (const t of p.tools) if (t.availability === 'available') list.push(t);
  }
  const base = (t: DwsTool) => t.cli_path.replace(/\+/g, '').replace(/[ -]/g, '_');
  const atomicNames = new Set(list.filter((t) => !t.cli_path.includes('+')).map(base));
  const tools: CatalogTool[] = [];
  for (const t of list) {
    const isShortcut = t.cli_path.includes('+');
    let name = base(t);
    if (isShortcut && atomicNames.has(name)) name = name.replace(/^([a-z0-9]+)_/, '$1_shortcut_');
    if (name.length > MAX_TOOL_NAME) throw new Error(`dws tool name too long: ${name}`);
    const flags: (FlagSpec & { description?: string; enum?: string[] })[] = [];
    for (const [flag, p] of Object.entries(t.parameters ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (DWS_HIDDEN.has(flag)) continue;
      const type: FlagSpec['type'] = p.type === 'boolean' ? 'bool' : p.type === 'integer' || p.type === 'number' ? 'int' : p.type === 'array' ? 'stringArray' : 'string';
      flags.push({ name: flag, key: toKey(flag), type, required: p.required === true, description: p.description, ...(Array.isArray(p.enum) && p.enum.length ? { enum: p.enum.map(String) } : {}) });
    }
    const risk: Risk = t.effect === 'destructive' || t.confirmation === 'user_required' ? 'high-risk-write' : t.effect === 'read' ? 'read' : 'write';
    const desc = (t.description || t.agent_summary || t.cli_path).trim();
    tools.push({
      name,
      description: desc.length > 1500 ? `${desc.slice(0, 1500)}…` : desc,
      inputSchema: schemaFromFlags(flags),
      risk,
      cli: { path: t.cli_path.split(' '), argStyle: 'flags', flags: flags.map(stripFlagExtras), supportsYes: true },
      category: t.product_id,
    });
  }
  return { tools, version };
}

// ---------------------------------------------------------------- wecom

const WECOM_SERVICES = ['calendar', 'chat', 'contact', 'disk', 'doc', 'mail', 'media', 'message', 'meeting', 'sheet', 'smartpage', 'smartsheet', 'todo', 'slide'];
/** Methods that only work with a file inside the container (upload from / download to a local path). */
const FILE_REASON_WECOM = 'needs a local file inside the server (file upload/download); remote MCP clients cannot provide or receive files';
const WECOM_UNAVAILABLE_RE = /^media\.(upload|download)$|\.(files|images)\.upload$|\.import$|^disk\.files\.download$|^message\.files\.get$|^smartpage\.pages\.(append|overwrite)$|^slide\.pages\.export$/;
const WECOM_UNAVAILABLE_REASON = FILE_REASON_WECOM;

function wecomRisk(method: string): Risk {
  const verb = method.split('.').at(-1)!;
  if (/^(delete|cancel|remove|rollback|clear|deletewithslides|undo)$/.test(verb)) return 'high-risk-write';
  if (/^(get|list|search|query|find|calculate)$/.test(verb)) return 'read';
  return 'write';
}

const MAX_DEPTH = 12;
function inline(node: unknown, defs: Record<string, unknown>, depth = 0, seen: ReadonlySet<string> = new Set()): unknown {
  if (depth > MAX_DEPTH) return { type: 'object', description: 'Nested too deeply; pass the full JSON object.' };
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const n = node as Record<string, unknown>;
  const ref = n.$ref;
  if (typeof ref === 'string') {
    if (seen.has(ref)) return { type: 'object', ...(n.description ? { description: n.description } : {}) };
    const target = defs[ref];
    if (!target) return { type: n.type ?? 'object', ...(n.description ? { description: n.description } : {}) };
    const merged = inline(target, defs, depth + 1, new Set([...seen, ref])) as Record<string, unknown>;
    return n.description ? { ...merged, description: n.description } : merged;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k.startsWith('x-')) continue;
    if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, inline(pv, defs, depth + 1, seen)]));
    else if (k === 'items') out[k] = inline(v, defs, depth + 1, seen);
    else if ((k === 'anyOf' || k === 'oneOf' || k === 'allOf') && Array.isArray(v)) out[k] = v.map((x) => inline(x, defs, depth + 1, seen));
    else out[k] = v;
  }
  return out;
}

async function genWecom(bin: string): Promise<{ tools: CatalogTool[]; version: string }> {
  const env = isolatedEnv();
  const cwd = env.HOME as string;
  const version = (await run(bin, ['--version'], env, cwd)).match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown';
  const methods: string[] = [];
  for (const s of WECOM_SERVICES) {
    const d = JSON.parse(await run(bin, [s, '--schema'], env, cwd)) as { methods: { name: string }[] };
    methods.push(...d.methods.map((m) => m.name));
  }
  const tools = await pool(methods, 8, async (method): Promise<CatalogTool> => {
    const doc = JSON.parse(await run(bin, [...method.split('.'), '--schema'], env, cwd)) as { description?: string; request?: unknown; schemas?: Record<string, unknown> };
    let schema = inline(doc.request ?? {}, doc.schemas ?? {}) as Record<string, unknown>;
    if (schema?.type !== 'object') schema = { type: 'object', properties: {} };
    schema.properties ??= {};
    if ('required' in schema && !Array.isArray(schema.required)) delete schema.required;
    schema.additionalProperties = false;
    const unavailable = WECOM_UNAVAILABLE_RE.test(method) ? WECOM_UNAVAILABLE_REASON : undefined;
    return {
      name: method.replace(/\./g, '_'),
      description: (doc.description ?? method).trim(),
      inputSchema: schema,
      risk: wecomRisk(method),
      cli: { path: method.split('.'), argStyle: 'json' },
      category: method.split('.')[0]!,
      ...(unavailable ? { unavailable } : {}),
    };
  });
  return { tools, version };
}

// ---------------------------------------------------------------- policy (all families)

/** Flags that make the CLI spawn local processes / daemons or run unattended (review H-2). */
export const PROCESS_FLAGS = new Set(['agent-cmd', 'agent-workdir', 'daemon', 'alwayson', 'yolo']);
/** Commands that start a local agent bridge, a login flow, or a long-running listener (review H-2). */
const PROCESS_TOOL_RE = /^dingtalk_tag_connect(_|$)|^dingtalk_tag_manage_login$|^mail_watch$|^event_/;
const PROCESS_REASON = 'starts a local process, daemon or long-running listener; never exposed by this server';

/** Flags that read or write a file inside the server (review M-6; same rule as wecom file-path methods). */
export const FILE_FLAGS = new Set([
  'file', 'file-path', 'dir', 'source-path', 'project-path', 'icon-file', 'output', 'output-dir', 'output-path',
  'local-dir', 'local-folder', 'body-file', 'patch-file', 'template-content-file', 'set-template-content-file', 'records-file', 'groups-file',
  'config-file', 'content-file', 'contents-file', 'media-files', 'qr-file', 'form-cover-file', 'additional-files', 'export-output',
]);
const FILE_REASON = 'needs a local file inside the server (file upload/download); remote MCP clients cannot provide or receive files';

/** Names that are destructive regardless of the vendor's declared risk (review M-5). */
const DESTRUCTIVE_NAME_RE = /(^|_)(delete|remove|recall|transfer_owner|revoke|clear|disband|kick|quit|rollback|cancel)(_|$)/;

/**
 * Applied to every family after generation:
 * - risk = max(vendor risk, name heuristic)
 * - tools with process/daemon flags or names → unavailable
 * - tools with a REQUIRED local-file flag → unavailable; optional local-file flags are removed from the schema
 */
export function applyPolicy(t: CatalogTool): CatalogTool {
  const out: CatalogTool = { ...t };
  if (DESTRUCTIVE_NAME_RE.test(t.name)) out.risk = 'high-risk-write';
  const flags = t.cli.flags ?? [];
  if (PROCESS_TOOL_RE.test(t.name) || flags.some((f) => PROCESS_FLAGS.has(f.name))) {
    out.unavailable = PROCESS_REASON;
    return out;
  }
  const fileFlags = flags.filter((f) => FILE_FLAGS.has(f.name));
  if (fileFlags.length === 0) return out;
  if (fileFlags.some((f) => f.required) || /(^|_)(upload|download|import_file|push|pull|sync|export)(_|$)/.test(t.name)) {
    out.unavailable ??= FILE_REASON;
    return out;
  }
  const drop = new Set(fileFlags.map((f) => f.key));
  const props = { ...((t.inputSchema.properties as Record<string, unknown>) ?? {}) };
  for (const k of drop) delete props[k];
  out.inputSchema = { ...t.inputSchema, properties: props };
  out.cli = { ...t.cli, flags: flags.filter((f) => !drop.has(f.key)) };
  return out;
}

// ---------------------------------------------------------------- main

function stable(v: unknown): string {
  return `${JSON.stringify(v, null, 1)}\n`;
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--cli');
  const fam = process.argv[i + 1] as Family;
  const check = process.argv.includes('--check');
  if (i < 0 || !['lark', 'dingtalk', 'wecom'].includes(fam)) throw new Error('usage: gen-catalog --cli lark|dingtalk|wecom [--check]');
  const bin = installCli(fam);
  const gen = fam === 'lark' ? genLark : fam === 'dingtalk' ? genDingtalk : genWecom;
  const gen0 = await gen(bin);
  const version = gen0.version;
  const tools = gen0.tools.map(applyPolicy);
  if (version !== CLI[fam].version) throw new Error(`installed ${fam} CLI reports ${version}, expected ${CLI[fam].version}`);
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const dup = tools.find((t, k) => k > 0 && tools[k - 1]!.name === t.name);
  if (dup) throw new Error(`duplicate tool name ${dup.name}`);

  const dir = join(ROOT, 'container/tools', fam);
  const tier1 = JSON.parse(readFileSync(join(dir, 'tier1.json'), 'utf8')) as string[];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const bad = tier1.filter((n) => !byName.has(n) || byName.get(n)!.unavailable);
  if (bad.length) throw new Error(`tier1 names missing or unavailable in ${fam} ${version}: ${bad.join(', ')}`);

  const catalogPath = join(dir, 'catalog.json');
  const prevAt = existsSync(catalogPath) ? (JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog).generatedAt : undefined;
  const catalog: Catalog = { family: fam, cliVersion: version, generatedAt: check && prevAt ? prevAt : new Date().toISOString(), tools };
  const outputs: [string, string][] = [[catalogPath, stable(catalog)]];
  if (fam === 'lark') {
    const scopes = new Set<string>(['offline_access']);
    for (const n of tier1) for (const s of byName.get(n)!.scopes ?? []) scopes.add(s);
    outputs.push([join(ROOT, 'config/scopes/feishu.json'), `${JSON.stringify({ scopes: { tenant: [], user: [...scopes].sort() } }, null, 2)}\n`]);
  }
  let drift = false;
  for (const [p, body] of outputs) {
    if (check) {
      const same = existsSync(p) && readFileSync(p, 'utf8') === body;
      console.log(`${same ? 'OK   ' : 'DRIFT'} ${p.slice(ROOT.length + 1)}`);
      drift ||= !same;
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
      console.log(`wrote ${p.slice(ROOT.length + 1)}`);
    }
  }
  console.log(`${fam} ${version}: ${tools.length} tools (${tools.filter((t) => t.unavailable).length} unavailable), tier1 ${tier1.length}`);
  if (drift) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

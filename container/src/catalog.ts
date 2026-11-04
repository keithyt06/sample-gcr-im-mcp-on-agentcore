// Catalog + tier-1 loading, tool prefixing, annotations, discover search (technical design §5.3, §5.5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Im } from '../../shared/contract';
import type { Catalog, CatalogTool, Family, Risk } from './adapters/types';

export function familyOf(im: Im): Family {
  return im === 'feishu' || im === 'lark' ? 'lark' : im;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export interface LoadedCatalog {
  im: Im;
  prefix: string; // `${im}_`
  catalog: Catalog;
  tier1: CatalogTool[];
  byName: Map<string, CatalogTool>; // unprefixed name -> tool
  tier1Names: Set<string>;
}

export function loadCatalog(toolsDir: string, im: Im): LoadedCatalog {
  const fam = familyOf(im);
  const catalog = JSON.parse(readFileSync(join(toolsDir, fam, 'catalog.json'), 'utf8')) as Catalog;
  const tier1List = JSON.parse(readFileSync(join(toolsDir, fam, 'tier1.json'), 'utf8')) as string[];
  const byName = new Map(catalog.tools.map((t) => [t.name, t]));
  const tier1: CatalogTool[] = [];
  for (const n of tier1List) {
    const t = byName.get(n);
    if (!t) throw new Error(`tier1 tool ${n} not found in ${fam}/catalog.json`);
    if (t.unavailable) throw new Error(`tier1 tool ${n} is unavailable: ${t.unavailable}`);
    tier1.push(t);
  }
  return { im, prefix: `${im}_`, catalog, tier1, byName, tier1Names: new Set(tier1List) };
}

export function annotations(risk: Risk, title?: string): Record<string, unknown> {
  const base = title ? { title } : {};
  if (risk === 'high-risk-write') return { ...base, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  if (risk === 'write') return { ...base, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  return { ...base, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}

/** inputSchema as exposed to clients: high-risk tools get the `_confirm` gate property. */
export function exposedSchema(t: CatalogTool): Record<string, unknown> {
  if (t.risk !== 'high-risk-write') return t.inputSchema;
  const props = { ...((t.inputSchema.properties as Record<string, unknown>) ?? {}) };
  props._confirm = {
    type: 'boolean',
    description: 'Must be true to run this destructive operation. Ask the user first; never set it without explicit user approval.',
  };
  return { ...t.inputSchema, properties: props };
}

export function toMcpTool(c: LoadedCatalog, t: CatalogTool): McpTool {
  return {
    name: c.prefix + t.name,
    description: `[${t.risk}] ${t.description}`,
    inputSchema: exposedSchema(t),
    annotations: annotations(t.risk),
  };
}

export function metaTools(c: LoadedCatalog): McpTool[] {
  const cats = [...new Set(c.catalog.tools.map((t) => t.category))].sort();
  return [
    {
      name: `${c.prefix}discover`,
      description: `[read] Search the ${c.catalog.tools.length - c.tier1.length} ${c.im} tools that are not listed directly. Returns name, description, inputSchema and risk. Then call ${c.prefix}invoke.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, e.g. "wiki space create"' },
          category: { type: 'string', description: `Optional category filter: ${cats.join(', ')}` },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        },
      },
      annotations: annotations('read'),
    },
    {
      name: `${c.prefix}invoke`,
      description: `[read|write] Invoke a tool found with ${c.prefix}discover. Pass its exact name and arguments.`,
      inputSchema: {
        type: 'object',
        required: ['tool_name', 'args'],
        properties: {
          tool_name: { type: 'string', description: `Tool name from ${c.prefix}discover` },
          args: { type: 'object', description: 'Tool arguments matching its inputSchema' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
  ];
}

export function listTools(c: LoadedCatalog): McpTool[] {
  return [...c.tier1.map((t) => toMcpTool(c, t)), ...metaTools(c)];
}

/** Resolve a prefixed or unprefixed name to a catalog tool. */
export function resolveTool(c: LoadedCatalog, name: string): CatalogTool | undefined {
  const bare = name.startsWith(c.prefix) ? name.slice(c.prefix.length) : name;
  return c.byName.get(bare);
}

const terms = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export function discover(c: LoadedCatalog, q: { query?: string; category?: string; limit?: number }): Record<string, unknown>[] {
  const limit = Math.min(20, Math.max(1, Math.trunc(Number(q.limit ?? 10)) || 10));
  const query = (q.query ?? '').trim().toLowerCase();
  let cands = c.catalog.tools.filter((t) => !c.tier1Names.has(t.name));
  if (q.category) cands = cands.filter((t) => t.category === q.category);
  const exactName = query.startsWith(c.prefix) ? query.slice(c.prefix.length) : query;
  const qTerms = terms(query.startsWith(c.prefix) ? query.slice(c.prefix.length) : query);
  const scored: { t: CatalogTool; s: number }[] = [];
  for (const t of cands) {
    let s = 0;
    if (t.name === exactName) s = 1e6;
    else if (qTerms.length) {
      const hay = new Set(terms(`${t.name} ${t.description} ${t.category}`));
      for (const w of qTerms) if (hay.has(w)) s++;
      if (s === 0) {
        const text = `${t.name} ${t.description}`.toLowerCase();
        for (const w of qTerms) if (w.length >= 2 && text.includes(w)) s += 0.5; // substring fallback (CJK text has no word breaks)
      }
    } else s = 1;
    if (s > 0) scored.push({ t, s });
  }
  scored.sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name));
  return scored.slice(0, limit).map(({ t }) => ({
    name: c.prefix + t.name,
    description: t.description,
    category: t.category,
    risk: t.risk,
    inputSchema: exposedSchema(t),
    ...(t.unavailable ? { unavailable: t.unavailable } : {}),
  }));
}

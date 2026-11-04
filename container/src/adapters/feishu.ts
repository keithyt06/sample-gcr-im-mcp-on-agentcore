// Feishu / Lark adapter (lark-cli). Logic ported from the Lark sample docker/server.js + server-lib.js (MIT-0).
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Im } from '../../../shared/contract';
import { ToolError, envelope, scopeAuthorizeUrl } from '../errors';
import type { ImAppSecret, SecretsApi } from '../secrets';
import type { CallContext, CatalogTool, CliRun, ContainerAdapter, Prepared, ToolResult } from './types';
import { baseEnv, tmpRoot } from '../cli-runner';

const SCOPE_CODES = new Set([99991679, 99991676, 99991672]); // user lacks / token lacks / app not applied
const AUTH_CODE = 99991668;
const APP_SECRET_TTL_MS = 30 * 60 * 1000;

export interface FeishuDeps {
  secrets: SecretsApi;
  appId?: string;
  appSecretId?: string;
  now?: () => number;
}

export function createFeishuAdapter(im: Extract<Im, 'feishu' | 'lark'>, deps: FeishuDeps): ContainerAdapter {
  const now = deps.now ?? Date.now;
  let cache: { value: ImAppSecret; exp: number } | undefined;
  let inflight: Promise<ImAppSecret> | undefined;

  async function appSecret(): Promise<ImAppSecret> {
    if (cache && now() < cache.exp) return cache.value;
    inflight ??= (async () => {
      try {
        if (!deps.appSecretId) return {};
        const value = await deps.secrets.getImApp(deps.appSecretId);
        cache = { value, exp: now() + APP_SECRET_TTL_MS };
        return value;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    im,
    bin: 'lark-cli',
    needsUserToken: true,
    async init() {
      // R2: never block health on the secret. Warm the cache in the background only.
      appSecret().catch(() => undefined);
    },
    async prepare(ctx: CallContext): Promise<Prepared> {
      if (!ctx.userToken) throw new ToolError('im_not_authorized', `No ${im} user credential for this user.`, { authorize_url: ctx.authorizeUrl });
      let s: ImAppSecret;
      try {
        s = await appSecret();
      } catch (e) {
        throw new ToolError('cli_failed', `Could not load the IM app secret: ${(e as Error).name}`);
      }
      if (s.configured !== true || !s.appSecret) throw new ToolError('im_app_not_configured', 'The IM app secret is not configured yet.');
      const cwd = await mkdtemp(join(tmpRoot(), 'lark-'));
      return {
        cwd,
        env: {
          ...baseEnv(),
          LARKSUITE_CLI_USER_ACCESS_TOKEN: ctx.userToken,
          LARKSUITE_CLI_APP_ID: deps.appId || s.appId || '',
          LARKSUITE_CLI_APP_SECRET: s.appSecret,
          LARKSUITE_CLI_BRAND: im,
          LARKSUITE_CLI_DEFAULT_AS: 'user',
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
        },
        dispose: () => rm(cwd, { recursive: true, force: true }),
      };
    },
    argv(tool, args) {
      const out = [...tool.cli.path];
      for (const f of tool.cli.flags ?? []) {
        const v = args[f.key];
        if (v === undefined || v === null || v === '') continue;
        if (f.type === 'bool') {
          if (v === true || v === 'true') out.push(`--${f.name}`);
          continue;
        }
        if (f.type === 'stringArray') {
          if (typeof v === 'string' && v.includes(',') && !v.trim().startsWith('[')) {
            throw new ToolError(
              'invalid_argument',
              `args.${f.key} is an array parameter; a comma-joined string is sent as ONE value. Pass ${f.key}=["a","b"] instead (wrap as ["a,b"] if the comma belongs to one value).`,
            );
          }
          for (const item of toFlagList(v)) out.push(`--${f.name}`, item);
          continue;
        }
        out.push(`--${f.name}`, coerce(v));
      }
      for (const f of tool.cli.flags ?? []) {
        if (f.required && (args[f.key] === undefined || args[f.key] === null || args[f.key] === '')) {
          throw new ToolError('invalid_argument', `Missing required argument: ${f.key}`);
        }
      }
      if (tool.risk === 'high-risk-write' && tool.cli.supportsYes) out.push('--yes');
      return out;
    },
    mapResult(run: CliRun, tool: CatalogTool, ctx: CallContext): ToolResult {
      const raw = (run.stdout.trim() || run.stderr.trim()).trim();
      const json = extractJson(raw);
      const data = json ? safeParse(json) : undefined;
      const err = (data as { error?: Record<string, unknown> } | undefined)?.error;
      if (err && typeof err === 'object') {
        const code = Number(err.code);
        const typed = err.type === 'authorization';
        const sub = String(err.subtype ?? '');
        const scopeClass = SCOPE_CODES.has(code) || (typed && ['missing_scope', 'token_scope_insufficient', 'app_scope_not_applied'].includes(sub));
        if (scopeClass) {
          const scopes = missingScopes(err, tool);
          return envelope('missing_scope', String(err.message ?? 'Missing permission'), {
            required_scopes: scopes,
            authorize_url: scopeAuthorizeUrl(ctx.authorizeUrl, scopes),
            im_code: Number.isFinite(code) ? code : undefined,
          });
        }
        if (code === AUTH_CODE || err.type === 'auth' || err.type === 'authentication') {
          return envelope('im_reauth_required', String(err.message ?? 'Authorization expired'), { im_code: Number.isFinite(code) ? code : undefined });
        }
      } else if (/token is expired|token is invalid/i.test(raw)) {
        return envelope('im_reauth_required', 'Authorization expired or revoked.');
      }
      if (run.exitCode === 0) return { content: [{ type: 'text', text: stripCliNotice(run.stdout.trim() || '{"ok":true,"data":null}') }] };
      if (data && (data as { ok?: unknown }).ok === false) {
        // Validation errors from lark-cli are self-correctable; anything else is terminal.
        const selfCorrectable = (err as { type?: unknown } | undefined)?.type === 'validation';
        return { content: [{ type: 'text', text: json! }], isError: !selfCorrectable };
      }
      return envelope('cli_failed', (raw || `lark-cli exited with ${run.exitCode}`).slice(0, 2000));
    },
  };
}

function missingScopes(err: Record<string, unknown>, tool: CatalogTool): string[] {
  const out = new Set<string>();
  if (Array.isArray(err.missing_scopes)) for (const s of err.missing_scopes) if (typeof s === 'string' && s) out.add(s);
  if (out.size === 0) for (const s of tool.scopes ?? []) out.add(s);
  if (out.size === 0 && typeof err.console_url === 'string') {
    try {
      for (const s of (new URL(err.console_url).searchParams.get('scopes') ?? '').split(/[,\s]+/)) if (s) out.add(s);
    } catch {
      /* ignore */
    }
  }
  if (out.size === 0) {
    for (const m of String(err.message ?? '').matchAll(/scopes?[:\s]+([a-z0-9_:.\- ,]+)/gi)) {
      for (const s of m[1]!.split(/[,\s]+/)) if (/^[a-z0-9_:.-]+$/i.test(s) && s.length > 2) out.add(s);
    }
  }
  return [...out];
}

function coerce(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

/** Array / JSON-array string / scalar → list of scalar strings. Never comma-splits. */
export function toFlagList(v: unknown): string[] {
  let list: unknown = v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const p = JSON.parse(v.trim()) as unknown;
      if (Array.isArray(p)) list = p;
    } catch {
      /* single literal value */
    }
  }
  if (!Array.isArray(list)) list = [list];
  return (list as unknown[]).filter((x) => x !== undefined && x !== null && typeof x !== 'object' && x !== '').map(String);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** lark-cli may print diagnostic lines before the JSON envelope. */
export function extractJson(text: string): string | null {
  if (text.startsWith('{')) {
    try {
      JSON.parse(text);
      return text;
    } catch {
      /* fall through */
    }
  }
  const idx = text.indexOf('\n{');
  if (idx >= 0) {
    const c = text.slice(idx + 1);
    try {
      JSON.parse(c);
      return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Surgically remove top-level `_notice.update` (keeps big integers intact; port of the Lark sample's stripCliNotice). */
export function stripCliNotice(output: string): string {
  if (!output.includes('"_notice"') || output[0] !== '{') return output;
  let i = 1;
  let depth = 1;
  let keyIdx = -1;
  let valStart = -1;
  let valEnd = -1;
  const n = output.length;
  while (i < n) {
    const c = output[i];
    if (c === '"') {
      const strStart = i;
      i++;
      while (i < n) {
        if (output[i] === '\\') i += 2;
        else if (output[i] === '"') break;
        else i++;
      }
      const str = output.slice(strStart, i + 1);
      i++;
      let k = i;
      while (k < n && /\s/.test(output[k]!)) k++;
      if (depth === 1 && output[k] === ':' && str === '"_notice"') {
        keyIdx = strStart;
        k++;
        while (k < n && /\s/.test(output[k]!)) k++;
        if (output[k] !== '{') return output;
        let d = 0;
        let j = k;
        let inStr = false;
        while (j < n) {
          const cj = output[j];
          if (inStr) {
            if (cj === '\\') j++;
            else if (cj === '"') inStr = false;
          } else if (cj === '"') inStr = true;
          else if (cj === '{') d++;
          else if (cj === '}') {
            d--;
            if (d === 0) {
              j++;
              break;
            }
          }
          j++;
        }
        valStart = k;
        valEnd = j;
        break;
      }
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  if (keyIdx < 0) return output;
  let notice: Record<string, unknown>;
  try {
    notice = JSON.parse(output.slice(valStart, valEnd)) as Record<string, unknown>;
  } catch {
    return output;
  }
  delete notice.update;
  if (Object.keys(notice).length > 0) return output.slice(0, valStart) + JSON.stringify(notice) + output.slice(valEnd);
  let start = keyIdx;
  let end = valEnd;
  let p = keyIdx - 1;
  while (p >= 0 && /\s/.test(output[p]!)) p--;
  if (output[p] === ',') start = p;
  else {
    let q = valEnd;
    while (q < n && /\s/.test(output[q]!)) q++;
    if (output[q] === ',') end = q + 1;
  }
  return output.slice(0, start) + output.slice(end);
}

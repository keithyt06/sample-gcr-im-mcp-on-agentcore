// DingTalk adapter (dws). Error parsing ported from quick-dingtalk-mcp packages/shared/src/errors.mjs
// (MIT, Copyright (c) 2026 Keith Yu) and extended for dws 1.0.67's PAT JSON.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError, envelope, scopeAuthorizeUrl } from '../errors';
import { baseEnv, tmpRoot } from '../cli-runner';
import { toFlagList } from './feishu';
import type { CallContext, CatalogTool, CliRun, ContainerAdapter, Prepared, ToolResult } from './types';

const ADMIN_RE = /cli_not_enabled|user_forbidden|user_not_allowed/;

/** `extraEnv` is for tests only (mock MCP endpoint, dws-isolation test). */
export function createDingtalkAdapter(o: { agentCode?: string; extraEnv?: Record<string, string> } = {}): ContainerAdapter {
  return {
    im: 'dingtalk',
    bin: 'dws',
    needsUserToken: true,
    async init() {},
    async prepare(ctx: CallContext): Promise<Prepared> {
      if (!ctx.userToken) throw new ToolError('im_not_authorized', 'No DingTalk user credential for this user.', { authorize_url: ctx.authorizeUrl });
      const tmp = await mkdtemp(join(tmpRoot(), 'dws-'));
      // Empty per-call config + keychain: defense in depth even though --token wins over the keychain.
      await Promise.all(['config', 'keychain', 'work'].map((d) => mkdir(join(tmp, d), { mode: 0o700 })));
      return {
        cwd: join(tmp, 'work'),
        env: {
          ...baseEnv(),
          DWS_CONFIG_DIR: join(tmp, 'config'),
          DWS_KEYCHAIN_DIR: join(tmp, 'keychain'),
          DWS_NO_UPDATE_CHECK: '1',
          DINGTALK_DWS_AGENTCODE: o.agentCode || 'gcr-im-mcp-on-agentcore',
          ...o.extraEnv,
        },
        dispose: () => rm(tmp, { recursive: true, force: true }),
      };
    },
    argv(tool, args, ctx) {
      const out = ['--token', ctx.userToken ?? '', ...tool.cli.path, '-y', '-f', 'json'];
      for (const f of tool.cli.flags ?? []) {
        const v = args[f.key];
        if (v === undefined || v === null || v === '') {
          if (f.required) throw new ToolError('invalid_argument', `Missing required argument: ${f.key}`);
          continue;
        }
        if (f.type === 'bool') {
          if (v === true || v === 'true') out.push(`--${f.name}`);
          else if (v === false || v === 'false') out.push(`--${f.name}=false`);
          continue;
        }
        if (f.type === 'stringArray') {
          // dws array flags are cobra StringSlice: one comma-joined value.
          out.push(`--${f.name}`, toFlagList(v).join(','));
          continue;
        }
        if (f.type === 'int' && !Number.isFinite(Number(v))) throw new ToolError('invalid_argument', `args.${f.key} must be a number`);
        out.push(`--${f.name}`, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      return out;
    },
    mapResult(run: CliRun, tool: CatalogTool, ctx: CallContext): ToolResult {
      const text = `${run.stdout}\n${run.stderr}`;
      if (run.exitCode === 0) return { content: [{ type: 'text', text: run.stdout.trim() || run.stderr.trim() || '{"ok":true}' }] };
      const parsed = parseJson(run.stdout) ?? parseJson(run.stderr);
      const perm = permissionInfo(parsed);
      if (run.exitCode === 4 || perm) {
        const scopes = perm?.scopes.length ? perm.scopes : (tool.scopes ?? []);
        return envelope('missing_scope', perm?.message || 'DingTalk permission required', {
          required_scopes: scopes,
          authorize_url: scopeAuthorizeUrl(ctx.authorizeUrl, scopes),
          im_code: perm?.code,
        });
      }
      if (ADMIN_RE.test(text)) return envelope('im_admin_action_required', errMessage(parsed) || 'DingTalk CLI access is not enabled for this user or app.');
      if (run.exitCode === 2 || isTokenRejected(parsed)) return envelope('im_reauth_required', errMessage(parsed) || 'DingTalk authorization expired or revoked.');
      return envelope('cli_failed', (errMessage(parsed) || text.trim() || `dws exited with ${run.exitCode}`).slice(0, 2000), {
        im_code: (parsed as { error?: { code?: number | string } } | undefined)?.error?.code,
      });
    },
  };
}

/** dws 1.0.67 reports a rejected user token as exit 1 + server_error_code TOKEN_VERIFIED_FAILED (observed). */
function isTokenRejected(p: unknown): boolean {
  const e = (p as { error?: { category?: unknown; server_error_code?: unknown } } | undefined)?.error;
  if (!e || typeof e !== 'object') return false;
  return e.category === 'auth' || (typeof e.server_error_code === 'string' && /^TOKEN_(VERIFIED_FAILED|EXPIRED|INVALID)/.test(e.server_error_code));
}

function parseJson(s: string): unknown {
  const t = s.trim();
  if (!t) return undefined;
  for (const cand of [t, t.slice(t.lastIndexOf('\n{') + 1)]) {
    try {
      return JSON.parse(cand);
    } catch {
      /* next */
    }
  }
  return undefined;
}

function errMessage(p: unknown): string | undefined {
  const o = p as { error?: { message?: string; hint?: string } | string; message?: string; data?: { message?: string } } | undefined;
  if (!o) return undefined;
  if (typeof o.error === 'object' && o.error?.message) return o.error.message;
  return o.data?.message ?? o.message;
}

/** Recognizes dws structured permission errors: nested `{error:{category:'permission'|reason:'missing_scope'}}` and PAT `{success:false, code:'PAT_*', data}`. */
export function permissionInfo(p: unknown): { scopes: string[]; message?: string; code?: string } | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const o = p as Record<string, unknown>;
  const scopes = new Set<string>();
  const add = (v: unknown) => {
    if (Array.isArray(v)) for (const s of v) if (typeof s === 'string' && s) scopes.add(s);
    if (typeof v === 'string' && v) for (const s of v.split(/[\s,]+/)) if (s) scopes.add(s);
  };
  if (o.error === 'permission_required') {
    add(o.missing_scopes);
    return { scopes: [...scopes], message: typeof o.hint === 'string' ? o.hint : undefined };
  }
  if (o.error && typeof o.error === 'object') {
    const e = o.error as Record<string, unknown>;
    if (e.category === 'permission' || e.reason === 'permission_required' || e.reason === 'missing_scope') {
      add(e.missing_scopes);
      return { scopes: [...scopes], message: typeof e.message === 'string' ? e.message : undefined, code: typeof e.code === 'string' ? e.code : undefined };
    }
  }
  if (o.success === false && typeof o.code === 'string' && /^PAT_|^AGENT_CODE_NOT_EXISTS$/.test(o.code)) {
    const d = (o.data ?? {}) as Record<string, unknown>;
    add(d.missingScope);
    add(d.missingScopes);
    add(d.scopes);
    return { scopes: [...scopes], message: typeof d.message === 'string' ? d.message : o.code, code: o.code };
  }
  return undefined;
}

// WeCom adapter (wecom-cli 1.3.x). Ported from wecom-mcp-on-agentcore docker/lib/{cli,credentials}.js (MIT-0).
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError, envelope } from '../errors';
import { baseEnv, tmpRoot } from '../cli-runner';
import { metric } from '../metrics';
import { createKeyedLock } from '../semaphore';
import type { SecretsApi } from '../secrets';
import { WecomAuthFlow } from '../wecom/auth-flow';
import { WecomStore, materialize, writeBackAndClean } from '../wecom/credentials';
import { extractCliError, stripIdentityContext } from '../wecom/identity';
import type { CallContext, CatalogTool, CliRun, ContainerAdapter, Prepared, ToolResult } from './types';

const RETRY_DELAYS_MS = [1500, 4000]; // 850005

export interface WecomDeps {
  secrets: SecretsApi;
  userSecretPrefix: string;
  bin?: string;
  urlWaitMs?: number;
}

export function createWecomAdapter(deps: WecomDeps): ContainerAdapter {
  const bin = deps.bin ?? 'wecom-cli';
  const store = new WecomStore(deps.secrets, deps.userSecretPrefix);
  const lock = createKeyedLock();
  const auth = new WecomAuthFlow({ bin, store, urlWaitMs: deps.urlWaitMs });

  return {
    im: 'wecom',
    bin,
    needsUserToken: false,
    async init() {},
    busy: () => auth.hasPending(),
    shutdown: () => auth.shutdown(),

    async prepare(ctx: CallContext): Promise<Prepared> {
      // Same-user calls are serialized: two CLIs refreshing one credentials.enc would lose a refresh.
      const release = await lock(ctx.userId);
      try {
        const blob = await store.load(ctx.userId);
        if (!blob) {
          throw new ToolError('im_not_authorized', 'No WeCom authorization for this user.', {
            user_action: 'Ask the user to disconnect and reconnect this MCP server to scan the WeCom QR code.',
          });
        }
        const { dir, mtimeNs } = await materialize(blob);
        const cwd = await mkdtemp(join(tmpRoot(), 'wcw-'));
        return {
          cwd,
          env: { ...baseEnv(), WECOM_CLI_CONFIG_DIR: dir, WECOM_CLI_LOG_DIR: join(dir, 'logs'), WECOM_CLI_LOG_LEVEL: 'warn' },
          async dispose() {
            try {
              await writeBackAndClean(store, ctx.userId, dir, mtimeNs);
              await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
            } finally {
              release();
            }
          },
        };
      } catch (e) {
        release();
        throw e;
      }
    },

    argv(tool, args) {
      return [...tool.cli.path, '--json', JSON.stringify(args ?? {})];
    },

    retryable(run: CliRun, attempt: number) {
      return cliCode(run) === 850005 ? RETRY_DELAYS_MS[attempt] : undefined;
    },

    mapResult(run: CliRun, _tool: CatalogTool, _ctx: CallContext): ToolResult {
      const err = extractCliError(run.stdout) ?? extractCliError(run.stderr);
      if (err) {
        switch (err.code) {
          case 850003:
            metric('ImGrantExpired');
            return envelope('im_grant_expired', err.message, { im_code: 850003 });
          case 850005:
            metric('ImRateLimited');
            return envelope('im_rate_limited', err.message, { im_code: 850005, retry_after_sec: 60 });
          case 853006:
            return envelope('im_policy_blocked', err.message, { im_code: 853006 });
          case 851003:
            return envelope('im_object_permission', err.message, { im_code: 851003 });
          case 893201:
            return envelope('im_reauth_required', err.message, { im_code: 893201 });
          default:
            return envelope('cli_failed', err.message || err.type, { im_code: err.code ?? undefined });
        }
      }
      if (run.exitCode !== 0) return envelope('cli_failed', (run.stderr.trim() || run.stdout.trim() || `wecom-cli exited with ${run.exitCode}`).slice(0, 2000));
      let parsed: unknown;
      try {
        parsed = JSON.parse(run.stdout);
      } catch {
        return { content: [{ type: 'text', text: run.stdout.trim() }] };
      }
      const { data, identity } = stripIdentityContext(parsed);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], ...(identity ? { _meta: { wecom_identity: identity } } : {}) };
    },

    async controlRpc(method: string, params: unknown, ctx: CallContext): Promise<unknown> {
      if (method === 'im/auth.start') return auth.start(ctx.userId);
      if (method === 'im/auth.status') {
        const sid = (params as { sessionId?: unknown } | null)?.sessionId;
        return auth.status(ctx.userId, typeof sid === 'string' ? sid : undefined);
      }
      throw new ToolError('unknown_tool', `unknown control method ${method}`);
    },
  };
}

function cliCode(run: CliRun): number | null {
  return (extractCliError(run.stdout) ?? extractCliError(run.stderr))?.code ?? null;
}

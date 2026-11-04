// Tool-level error envelope (technical design §4.7).
import type { ErrorCode } from '../../shared/contract';
import type { ToolResult } from './adapters/types';

export interface ErrorExtra {
  user_action?: string;
  authorize_url?: string;
  required_scopes?: string[];
  im_code?: number | string;
  retry_after_sec?: number;
}

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: ErrorExtra = {},
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Codes the LLM can fix by itself: returned with isError:false so lenient clients still show the hint. */
const SELF_CORRECTABLE: ReadonlySet<ErrorCode> = new Set(['user_approval_required', 'invalid_argument', 'unknown_tool']);

export const USER_ACTIONS: Partial<Record<ErrorCode, string>> = {
  im_not_authorized: 'Ask the user to open authorize_url to connect their IM account, then retry.',
  missing_scope:
    'Ask the user to open authorize_url to grant the missing permission, then retry. For Feishu/Lark an admin may first need to enable the scope and publish a new app version.',
  im_reauth_required: 'The IM authorization expired or was revoked. Ask the user to disconnect and reconnect this MCP server. Do not retry.',
  im_admin_action_required:
    'Ask the DingTalk organization admin to enable CLI access for this app (open-dev console, CLI access management) or approve this user, then retry.',
  im_grant_expired:
    'The WeCom capability grant expired (7-day validity). Ask the user to renew it in the WeCom client, smart-bot management page. Do not re-scan the QR code and do not create a new bot.',
  im_rate_limited: 'The IM platform is rate limiting. Wait about 60 seconds before retrying.',
  im_policy_blocked: 'Chat history is not available in organizations with more than 10 members (WeCom platform policy).',
  im_object_permission:
    'The bot can only modify objects it created or was added to. Create the document with the bot first, then add the user.',
  im_app_not_configured: 'The operator must store the IM app secret (npm run secret:set-im-app) before tools can run.',
  user_approval_required: 'This is a destructive operation. Describe exactly what will change, ask the user to confirm, then retry with _confirm: true.',
  timeout: 'The call timed out. Narrow the query (filters, pagination) and retry.',
  output_too_large: 'The output was too large. Narrow the query (filters, pagination) and retry.',
  server_busy: 'The server is busy. Retry in a few seconds.',
};

export function envelope(code: ErrorCode, message: string, extra: ErrorExtra = {}): ToolResult {
  const error: Record<string, unknown> = { code, message };
  const userAction = extra.user_action ?? USER_ACTIONS[code];
  if (userAction) error.user_action = userAction;
  for (const k of ['authorize_url', 'required_scopes', 'im_code', 'retry_after_sec'] as const) {
    if (extra[k] !== undefined) error[k] = extra[k];
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }], isError: !SELF_CORRECTABLE.has(code) };
}

export function errorResult(e: ToolError): ToolResult {
  return envelope(e.code, e.message, e.extra);
}

/** authorize_url for incremental scope consent: header URL + `&extra_scope=a,b`. */
export function scopeAuthorizeUrl(authorizeUrl: string | undefined, scopes: string[]): string | undefined {
  if (!authorizeUrl) return undefined;
  if (scopes.length === 0) return authorizeUrl;
  const sep = authorizeUrl.includes('?') ? '&' : '?';
  return `${authorizeUrl}${sep}extra_scope=${encodeURIComponent(scopes.join(','))}`;
}

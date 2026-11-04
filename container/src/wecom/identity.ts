// WeCom identity context handling. Ported from wecom-mcp-on-agentcore docker/lib/cli.js (MIT-0).
//
// wecom-cli appends a natural-language `extra_identity_context` to every response (with an instruction
// to hide it from the user). Passing it through would inject foreign instructions into the client LLM,
// so it is removed from the data and returned as structured metadata instead.

// The CLI emits Chinese labels for name, ID, and "authorized human identity" (escaped below).
const BOT_RE = /\u540d\u5b57\uff1a\s*(.+?)\s*\n\s*ID\uff1a\s*(\S+)/;
const USER_RE = /\u6388\u6743\u771f\u4eba\u7528\u6237\u8eab\u4efd\uff1a\s*\n\s*\u540d\u5b57\uff1a\s*(.+?)\s*\n\s*ID\uff1a\s*(\S+)/;

export interface WecomIdentityMeta {
  bot_name: string | null;
  bot_id: string | null;
  authorized_user_name: string | null;
  authorized_user_id: string | null;
  write_scope: 'bot_owned_only';
}

export function stripIdentityContext(payload: unknown): { data: unknown; identity: WecomIdentityMeta | null } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { data: payload, identity: null };
  const raw = (payload as Record<string, unknown>).extra_identity_context;
  if (typeof raw !== 'string') return { data: payload, identity: null };
  const rest = { ...(payload as Record<string, unknown>) };
  delete rest.extra_identity_context;
  const bot = BOT_RE.exec(raw);
  const user = USER_RE.exec(raw);
  return {
    data: rest,
    identity: {
      bot_name: bot?.[1] ?? null,
      bot_id: bot?.[2] ?? null,
      authorized_user_name: user?.[1] ?? null,
      authorized_user_id: user?.[2] ?? null,
      write_scope: 'bot_owned_only',
    },
  };
}

// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export interface CliError {
  type: string;
  code: number | null;
  message: string;
}

/** Structured CLI error from output that may contain log lines before the JSON envelope. */
export function extractCliError(text: string): CliError | null {
  if (!text) return null;
  const clean = text.replace(ANSI_RE, '');
  const starts: number[] = [];
  const re = /^[ \t]*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) starts.push(m.index + m[0].indexOf('{'));
  for (let i = starts.length - 1; i >= 0 && starts.length - i <= 5; i--) {
    try {
      const j = JSON.parse(clean.slice(starts[i])) as { error?: { type?: string; code?: unknown; message?: string } };
      if (j?.error) return normalize(j.error.type || 'UnknownError', j.error.code, j.error.message || '');
    } catch {
      /* not a complete JSON object */
    }
  }
  const codeM = /\[code=(\d+)\]/.exec(clean);
  const msgM = /"message"\s*:\s*"([^"]+)"/.exec(clean);
  if (codeM || msgM) return { type: 'UnknownError', code: codeM ? Number(codeM[1]) : null, message: msgM ? msgM[1]! : clean.trim().slice(-200) };
  return null;
}

/** The outer code can be a CLI wrapper (893999); the platform code is often embedded as `[code=NNN]` / `errcode`. */
function normalize(type: string, code: unknown, message: string): CliError {
  let c: number | null = typeof code === 'number' ? code : Number.isFinite(Number(code)) && code !== null && code !== '' ? Number(code) : null;
  const inner = /\[code=(\d+)\]|errcode["':\s]+(\d+)/.exec(message);
  if (inner && (c === null || c === 893999)) c = Number(inner[1] ?? inner[2]);
  return { type, code: c, message };
}

// Container-side adapter contract (technical design §5.3).
import type { Im } from '../../../shared/contract';

export type Risk = 'read' | 'write' | 'high-risk-write';
export type Family = 'lark' | 'dingtalk' | 'wecom';

export interface FlagSpec {
  name: string; // CLI flag name, e.g. 'chat-id'
  key: string; // argument key in inputSchema, e.g. 'chat_id'
  type: 'string' | 'bool' | 'int' | 'stringArray';
  required: boolean;
}

export interface CatalogTool {
  name: string; // UNPREFIXED, e.g. 'im_messages_send', 'chat_message_send', 'calendar_schedules_create'
  description: string;
  inputSchema: Record<string, unknown>;
  risk: Risk;
  cli: { path: string[]; argStyle: 'flags' | 'json'; flags?: FlagSpec[]; supportsYes?: boolean };
  scopes?: string[];
  category: string;
  unavailable?: string; // reason the tool can never run in this server (e.g. needs a local file path)
}

export interface Catalog {
  family: Family;
  cliVersion: string;
  generatedAt: string;
  tools: CatalogTool[];
}

export interface CallContext {
  userId: string;
  userToken?: string;
  authorizeUrl?: string;
  requestId: string;
  signal: AbortSignal;
  deadline: number; // epoch ms
}

export interface Prepared {
  env: NodeJS.ProcessEnv;
  cwd: string;
  dispose(): Promise<void>;
}

export interface CliRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  aborted: boolean;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ContainerAdapter {
  readonly im: Im;
  readonly bin: string;
  readonly needsUserToken: boolean;
  init(): Promise<void>; // MUST NOT throw (R2)
  prepare(ctx: CallContext): Promise<Prepared>; // throws ToolError
  argv(tool: CatalogTool, args: Record<string, unknown>, ctx: CallContext): string[]; // throws ToolError('invalid_argument')
  mapResult(run: CliRun, tool: CatalogTool, ctx: CallContext): ToolResult;
  /** ms to wait before retrying (wecom 850005); `attempt` starts at 0. undefined = no retry. */
  retryable?(run: CliRun, attempt: number): number | undefined;
  controlRpc?(method: string, params: unknown, ctx: CallContext): Promise<unknown>;
  /** true while a long-running control flow (wecom QR scan) is pending → /ping reports HealthyBusy. */
  busy?(): boolean;
  shutdown?(): Promise<void>;
}

// SigV4-signed InvokeAgentRuntime over HTTPS (technical design §4.5).
// Endpoint comes from AGENTCORE_ENDPOINT (`https://bedrock-agentcore.<region>.<urlSuffix>`,
// derived by CDK from the region), so no partition domain is hardcoded here.
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { ENV, H, type ControlMethod, type RuntimeHeader } from '../../shared/contract';
import { env } from './env';
import { loadKeys } from './keys';
import { runtimeSessionId, type Keys } from './tokens';

export interface RuntimeDeps {
  fetch: typeof fetch;
  credentials: ConstructorParameters<typeof SignatureV4>[0]['credentials'];
}

const defaults = (): RuntimeDeps => ({
  fetch: (...a: Parameters<typeof fetch>) => globalThis.fetch(...a),
  credentials: defaultProvider(),
});
let deps: RuntimeDeps | undefined;

/** Test hook: inject fetch and static credentials. Pass undefined to reset. */
export function setRuntimeDeps(d: Partial<RuntimeDeps> | undefined): void {
  deps = d ? { ...defaults(), ...d } : undefined;
}

const getDeps = (): RuntimeDeps => (deps ??= defaults());

export const DEFAULT_TIMEOUT_MS = 28_000;

export interface InvokeOptions {
  method: string;
  params?: unknown;
  id?: number | string;
  userId: string;
  keys: Keys;
  headers?: Partial<Record<RuntimeHeader, string>>;
  rawBody?: Buffer;
  timeoutMs?: number;
}

export async function invokeRuntime(o: InvokeOptions): Promise<Response> {
  const endpoint = new URL(env(ENV.AGENTCORE_ENDPOINT));
  const region = env(ENV.AWS_REGION);
  const arn = env(ENV.RUNTIME_ARN);
  const body = o.rawBody ?? Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: o.id ?? 1, method: o.method, params: o.params ?? {} }));
  const headers: Record<string, string> = {
    host: endpoint.host,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-session-id': runtimeSessionId(o.keys, o.userId),
    [H.userId]: o.userId,
  };
  for (const [k, v] of Object.entries(o.headers ?? {})) if (v !== undefined && v !== '') headers[k] = v;

  const path = `/runtimes/${encodeURIComponent(arn)}/invocations`;
  const { fetch: doFetch, credentials } = getDeps();
  const signer = new SignatureV4({ service: 'bedrock-agentcore', region, credentials, sha256: Sha256 });
  const signed = await signer.sign(
    new HttpRequest({ method: 'POST', protocol: 'https:', hostname: endpoint.hostname, path, headers, body }),
  );
  return doFetch(`https://${endpoint.host}${path}`, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
    signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

export class RuntimeRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'RuntimeRpcError';
  }
}

/** Extracts the JSON-RPC payload from a single-frame SSE body (or plain JSON). */
export function parseRpcBody(text: string): unknown {
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5).trim() : text);
}

/** Control RPC to the container (`…-Caller: control`). Throws on transport or JSON-RPC error. */
export async function control<T>(method: ControlMethod, params: unknown, userId: string): Promise<T> {
  const keys = await loadKeys();
  const r = await invokeRuntime({ method, params, userId, keys, headers: { [H.caller]: 'control' }, timeoutMs: 25_000 });
  const text = await r.text();
  if (!r.ok) throw new RuntimeRpcError(`runtime http ${r.status}`);
  let payload: unknown;
  try {
    payload = parseRpcBody(text);
  } catch {
    throw new RuntimeRpcError('runtime returned a non-JSON body');
  }
  const p = payload as { result?: T; error?: { code?: number; message?: string } } | null;
  if (!p || typeof p !== 'object') throw new RuntimeRpcError('runtime returned an empty body');
  if (p.error) throw new RuntimeRpcError(p.error.message ?? 'runtime_error', p.error.code);
  if (p.result === undefined) throw new RuntimeRpcError('runtime returned no result');
  return p.result;
}

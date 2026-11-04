// Shared upstream-call helpers for the IM adapters.
import { log } from '../log';
import { ImUpstreamError, type AdapterDeps, type ResolvedDeps } from './types';

export const UPSTREAM_TIMEOUT_MS = 10_000;

export function resolveDeps(d?: AdapterDeps): ResolvedDeps {
  return { fetch: d?.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)), now: d?.now ?? Date.now };
}

export interface JsonResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * fetch with a 10 s timeout whose body is parsed defensively: a non-JSON body (an edge
 * block page, an empty reply) or a read error becomes `body: null`, never a throw.
 * Network errors and timeouts throw ImUpstreamError.
 */
export async function fetchJson(deps: ResolvedDeps, api: string, url: string, init: RequestInit): Promise<JsonResponse> {
  let resp: Response;
  try {
    resp = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (e) {
    throw new ImUpstreamError(api, e instanceof Error ? e.name : 'network_error');
  }
  let text = '';
  try {
    text = await resp.text();
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { status: resp.status, body: parsed as Record<string, unknown> };
    }
  } catch {
    /* fall through */
  }
  log('WARN', 'im_non_json_response', { api, status: resp.status, bodyLength: text.length });
  return { status: resp.status, body: null };
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

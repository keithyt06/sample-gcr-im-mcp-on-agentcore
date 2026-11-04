// API Gateway HTTP API (payload format 2.0) event/result types and response helpers.

export interface HttpEvent {
  version?: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext: { requestId?: string; http: { method: string; path?: string; sourceIp?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

/** A dependency (Secrets Manager, SSM, DynamoDB) is unavailable → 503 + Retry-After. */
export class BackendUnavailableError extends Error {
  constructor(what: string, cause?: unknown) {
    super(`backend unavailable: ${what}`, { cause });
    this.name = 'BackendUnavailableError';
  }
}

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...headers },
    body: JSON.stringify(body),
  };
}

export function html(statusCode: number, body: string, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...NO_STORE,
      ...headers,
    },
    body,
  };
}

export function redirect(location: string): HttpResult {
  return { statusCode: 302, headers: { Location: location, 'Referrer-Policy': 'no-referrer', ...NO_STORE }, body: '' };
}

/** One-frame Streamable-HTTP SSE response (same framing the container uses). */
export function sse(statusCode: number, payload: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/event-stream', ...NO_STORE, ...headers },
    body: `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
  };
}

export function header(event: HttpEvent, name: string): string | undefined {
  const h = event.headers;
  if (!h) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return undefined;
}

export function query(event: HttpEvent): Record<string, string> {
  const out: Record<string, string> = {};
  if (event.rawQueryString !== undefined) {
    for (const [k, v] of new URLSearchParams(event.rawQueryString)) if (!(k in out)) out[k] = v;
    return out;
  }
  for (const [k, v] of Object.entries(event.queryStringParameters ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

export function bodyBuffer(event: HttpEvent): Buffer {
  const b = event.body ?? '';
  return event.isBase64Encoded ? Buffer.from(b, 'base64') : Buffer.from(b, 'utf8');
}

export function method(event: HttpEvent): string {
  return event.requestContext.http.method.toUpperCase();
}

/** Parses a form-encoded or JSON body into flat string fields. Invalid input → {}. */
export function formOrJson(event: HttpEvent): Record<string, string> {
  const text = bodyBuffer(event).toString('utf8');
  const ct = (header(event, 'content-type') ?? '').toLowerCase();
  const out: Record<string, string> = {};
  if (ct.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
      }
    } catch {
      /* invalid JSON → empty */
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v;
  return out;
}

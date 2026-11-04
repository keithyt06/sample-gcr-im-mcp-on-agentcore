// Lambda-side IM adapters (technical design §5.1).
import type { Im } from '../../../shared/contract';

/** dingtalk: clientId/clientSecret are mapped onto appId/appSecret. */
export interface ImApp {
  appId: string;
  appSecret: string;
}

/** expiresAt / issuedAt are epoch seconds. */
export interface ImTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  issuedAt: number;
  scope?: string;
}

export interface ImIdentity {
  imUid: string;
  displayName?: string;
}

/**
 * revoked: the user grant is definitively dead (delete the credential).
 * appRejected: the IM rejected the app credential itself; never delete user credentials.
 */
export type RefreshResult = { ok: true; tokens: ImTokenSet } | { ok: false; revoked: boolean; reason: string; appRejected?: boolean };

export interface RedirectAdapter {
  readonly mode: 'redirect';
  readonly im: 'feishu' | 'lark' | 'dingtalk';
  authorizeUrl(p: { appId: string; callbackUrl: string; state: string; scopes: string[] }): string;
  /** Throws ImUpstreamError on any upstream failure (never a raw parse error). */
  exchangeCode(p: { code: string; callbackUrl: string; app: ImApp }): Promise<{ tokens: ImTokenSet; identity: ImIdentity }>;
  refresh(p: { refreshToken: string; app: ImApp }): Promise<RefreshResult>;
}

export interface QrAdapter {
  readonly mode: 'qr';
  readonly im: 'wecom';
}

export type LambdaAdapter = RedirectAdapter | QrAdapter;

export interface AdapterDeps {
  fetch?: typeof fetch;
  /** Epoch milliseconds. */
  now?: () => number;
}

export interface ResolvedDeps {
  fetch: typeof fetch;
  now: () => number;
}

/** Upstream IM call failed (HTTP error, non-JSON body, business error code, timeout). */
export class ImUpstreamError extends Error {
  constructor(
    readonly api: string,
    readonly detail: string,
  ) {
    super(`${api} failed: ${detail}`);
    this.name = 'ImUpstreamError';
  }
}

export type { Im };

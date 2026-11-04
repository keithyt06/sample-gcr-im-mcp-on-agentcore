// Per-container OAuth context: the IM adapter, scopes, and request helpers.
import { ENV, type Im } from '../../shared/contract';
import { getLambdaAdapter, type AdapterDeps, type LambdaAdapter } from '../shared/adapters';
import { envIm, envOpt } from '../shared/env';
import { header, type HttpEvent } from '../shared/http';
import { detectLang, type Lang } from './pages';

let adapter: { im: Im; a: LambdaAdapter } | undefined;
let adapterDeps: AdapterDeps | undefined;

export function getAdapter(): LambdaAdapter {
  const im = envIm();
  if (!adapter || adapter.im !== im) adapter = { im, a: getLambdaAdapter(im, adapterDeps) };
  return adapter.a;
}

/** Test hook: rebuild the adapter (drops the app-token cache) with optional deps. */
export function resetAdapter(deps?: AdapterDeps): void {
  adapter = undefined;
  adapterDeps = deps;
}

/** IM_SCOPES: comma- and/or space-separated. */
export function imScopes(): string[] {
  return (envOpt(ENV.IM_SCOPES) ?? '').split(/[\s,]+/).filter(Boolean);
}

export function langOf(event: HttpEvent): Lang {
  return detectLang(header(event, 'accept-language'));
}

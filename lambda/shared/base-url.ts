// Public base URL from SSM (`/im-mcp/<slug>/base-url`), cached 5 minutes. The
// Lambdas get only the parameter name, which avoids a CFN cycle with the API (§3.4).
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ENV } from '../../shared/contract';
import { env } from './env';
import { BackendUnavailableError } from './http';

const TTL_MS = 5 * 60 * 1000;
const ssm = new SSMClient({});
let cached: { url: string; until: number } | undefined;

export async function baseUrl(): Promise<string> {
  if (cached && Date.now() < cached.until) return cached.url;
  let v: string | undefined;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: env(ENV.BASE_URL_PARAM) }));
    v = r.Parameter?.Value;
  } catch (e) {
    throw new BackendUnavailableError('base-url', e);
  }
  if (!v || !/^https:\/\/[^/]+/.test(v)) throw new BackendUnavailableError('base-url (invalid)');
  const url = v.replace(/\/+$/, '');
  cached = { url, until: Date.now() + TTL_MS };
  return url;
}

export function resetBaseUrlCache(): void {
  cached = undefined;
}

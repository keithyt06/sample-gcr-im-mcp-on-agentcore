// Internal E2E check that skips the public API Gateway URL. Use it when the default execute-api URL is
// not reachable, e.g. AWS China accounts without ICP filing (every route returns 403 "Forbidden").
//   npm run e2e:internal -- --stack ImMcp-<slug> --region <r>      (or -c config=<path>)
// It invokes the oauth and middleware Lambdas directly with synthetic API Gateway HTTP API (payload 2.0)
// events and runs E2E steps 1-7 from e2e-smoke.ts. Step 8 (throttling) needs the real ingress and is skipped.
// The middleware still calls AgentCore Runtime with SigV4, so steps 6-7 cover the full backend path.
// Needs lambda:InvokeFunction on the two functions, plus what mint-test-token needs.
import { CloudFormationClient, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { createHash, randomBytes } from 'node:crypto';
import type { Im } from '../shared/contract.js';
import { die, isMain, parseArgs, resolveTarget, stackOutputs, type Target } from './common.js';
import { IM_HOSTS } from './e2e-smoke.js';
import { E2E_USER_ID, mintTestToken } from './mint-test-token.js';

interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Physical names of the oauth and middleware functions, read from the stack (never guessed). */
async function functionNames(t: Target): Promise<{ oauth: string; middleware: string }> {
  const cfn = new CloudFormationClient({ region: t.region });
  const fns: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const r = await cfn.send(new ListStackResourcesCommand({ StackName: t.stack, NextToken }));
    for (const s of r.StackResourceSummaries ?? [])
      if (s.ResourceType === 'AWS::Lambda::Function' && s.LogicalResourceId && s.PhysicalResourceId) fns[s.LogicalResourceId] = s.PhysicalResourceId;
    NextToken = r.NextToken;
  } while (NextToken);
  const find = (prefix: string) => Object.entries(fns).find(([k]) => k.startsWith(prefix))?.[1] ?? die(`stack ${t.stack} has no ${prefix} function`);
  return { oauth: find('OauthFn'), middleware: find('MiddlewareFn') };
}

const header = (r: HttpResult, name: string): string =>
  Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ?? '';

/** Parse a JSON body, or the single SSE frame the middleware returns for JSON-RPC responses. */
function parseBody(body = ''): any {
  const data = body
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  try {
    return JSON.parse(data || body);
  } catch {
    return body;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t = resolveTarget(args);
  const outs = await stackOutputs(t);
  const base = (outs.BaseUrl ?? die(`stack ${t.stack} has no BaseUrl output`)).replace(/\/$/, '');
  const host = new URL(base).host;
  const fn = await functionNames(t);
  const lambda = new LambdaClient({ region: t.region });

  const invoke = async (
    target: 'oauth' | 'middleware',
    method: string,
    path: string,
    o: { query?: Record<string, string>; body?: string; headers?: Record<string, string> } = {},
  ): Promise<HttpResult> => {
    const event = {
      version: '2.0',
      routeKey: `${method} ${path}`,
      rawPath: path,
      rawQueryString: new URLSearchParams(o.query ?? {}).toString(),
      queryStringParameters: o.query,
      headers: { host, 'x-forwarded-proto': 'https', 'content-type': 'application/json', ...o.headers },
      requestContext: {
        requestId: `e2e-internal-${randomBytes(6).toString('hex')}`,
        domainName: host,
        stage: '$default',
        http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'e2e-internal' },
      },
      body: o.body,
      isBase64Encoded: false,
    };
    const r = await lambda.send(new InvokeCommand({ FunctionName: fn[target], Payload: Buffer.from(JSON.stringify(event)) }));
    const payload = Buffer.from(r.Payload ?? new Uint8Array()).toString('utf8');
    if (r.FunctionError) throw new Error(`${target} Lambda error: ${payload.slice(0, 300)}`);
    return JSON.parse(payload) as HttpResult;
  };

  const mcpHeaders = { accept: 'application/json, text/event-stream' };
  const rpc = (token: string | undefined, method: string, params: unknown = {}, id = 1) =>
    invoke('middleware', 'POST', '/mcp', {
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      headers: { ...mcpHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });

  const results: boolean[] = [];
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = (await fn()) ?? '';
      results.push(true);
      console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
    } catch (e) {
      results.push(false);
      console.log(`FAIL  ${name}  ${(e as Error).message}`);
    }
  };
  const expect = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  console.log(`stack ${t.stack} (${t.region}) base ${base} [direct Lambda invoke, API Gateway bypassed]`);
  const redirectIm = !!outs.CallbackUrl;
  const redirectUri = 'http://127.0.0.1:33418/callback';
  let clientId = '';
  let token = '';
  let firstTool = '';

  await step('1 GET /.well-known/oauth-authorization-server', async () => {
    const r = await invoke('oauth', 'GET', '/.well-known/oauth-authorization-server');
    expect(r.statusCode === 200, `status ${r.statusCode}`);
    const j = parseBody(r.body) as { issuer?: string };
    expect(j.issuer === base, `issuer ${j.issuer} !== ${base}`);
  });

  await step('2 GET /.well-known/oauth-protected-resource/mcp', async () => {
    const r = await invoke('oauth', 'GET', '/.well-known/oauth-protected-resource/mcp');
    expect(r.statusCode === 200, `status ${r.statusCode}`);
    const j = parseBody(r.body) as { resource?: string };
    expect(j.resource === `${base}/mcp`, `resource ${j.resource}`);
  });

  await step('3 POST /mcp without token -> 401 + WWW-Authenticate', async () => {
    const r = await rpc(undefined, 'initialize');
    expect(r.statusCode === 401, `status ${r.statusCode}`);
    expect(header(r, 'www-authenticate').includes('resource_metadata="'), `WWW-Authenticate: ${header(r, 'www-authenticate')}`);
  });

  await step('4 POST /register (DCR) -> 201', async () => {
    const r = await invoke('oauth', 'POST', '/register', { body: JSON.stringify({ client_name: 'e2e-internal', redirect_uris: [redirectUri] }) });
    expect(r.statusCode === 201, `status ${r.statusCode}`);
    clientId = (parseBody(r.body) as { client_id?: string }).client_id ?? '';
    expect(clientId, 'no client_id');
  });

  await step('5 GET /authorize (PKCE) -> IM', async () => {
    expect(clientId, 'no client_id from step 4');
    const verifier = randomBytes(32).toString('base64url');
    const query = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: randomBytes(8).toString('base64url'),
    };
    const r = await invoke('oauth', 'GET', '/authorize', { query });
    if (redirectIm) {
      expect(r.statusCode === 302, `status ${r.statusCode}`);
      const loc = new URL(header(r, 'location') || 'about:blank');
      expect((Object.values(IM_HOSTS) as string[]).includes(loc.host), `redirect host ${loc.host} is not an IM host`);
      return loc.host;
    }
    expect(r.statusCode === 200, `status ${r.statusCode}`);
    const html = r.body ?? '';
    const hasQr = /<img id="qr"[^>]*src="data:image\/png;base64,[A-Za-z0-9+/=]{100,}"/.test(html);
    expect(hasQr || html.includes('work.weixin.qq.com'), 'QR page has neither a QR image nor a work.weixin.qq.com link');
    return hasQr ? 'QR image' : 'QR link';
  });

  await step('6 minted token -> initialize + tools/list', async () => {
    token = await mintTestToken({ region: t.region, rootKeySecretName: outs.RootKeySecretName, userId: E2E_USER_ID });
    const t0 = Date.now();
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-internal', version: '0' } });
    const initMs = Date.now() - t0;
    expect(init.statusCode === 200, `initialize status ${init.statusCode} ${String(init.body).slice(0, 200)}`);
    const list = await rpc(token, 'tools/list', {}, 2);
    expect(list.statusCode === 200, `tools/list status ${list.statusCode}`);
    const names: string[] = (parseBody(list.body)?.result?.tools ?? []).map((x: { name: string }) => x.name);
    const prefix = names.find((n) => n.endsWith('_discover'))?.replace(/_discover$/, '') as Im | undefined;
    expect(prefix && names.includes(`${prefix}_invoke`), 'no <im>_discover / <im>_invoke tools');
    firstTool = names.find((n) => !n.endsWith('_discover') && !n.endsWith('_invoke')) ?? '';
    return `${names.length} tools, initialize ${initMs} ms`;
  });

  await step('7 tools/call without IM credential -> im_not_authorized', async () => {
    expect(firstTool, 'no tier-1 tool from step 6');
    const r = await rpc(token, 'tools/call', { name: firstTool, arguments: {} }, 3);
    expect(r.statusCode === 200, `status ${r.statusCode}`);
    const res = parseBody(r.body)?.result;
    expect(res?.isError === true, `isError ${res?.isError}`);
    const env = JSON.parse(res.content?.[0]?.text ?? '{}') as { error?: { code?: string; authorize_url?: string } };
    expect(env.error?.code === 'im_not_authorized', `code ${env.error?.code}`);
    if (redirectIm) expect(env.error?.authorize_url?.startsWith(`${base}/authorize?t=`), `authorize_url ${env.error?.authorize_url}`);
    return firstTool;
  });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed (step 8 throttling skipped: needs the public ingress, use npm run e2e)`);
  process.exit(passed === results.length ? 0 : 1);
}

if (isMain(import.meta.url)) main().catch((e: Error) => die(e.message));

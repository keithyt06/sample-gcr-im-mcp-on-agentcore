// Register an OAuth client for MCP clients whose form requires manual values (e.g. Amazon Quick
// "User authentication (OAuth)"). Calls the stack's own DCR endpoint and prints the values to paste.
//   npm run register-client -- [-c config=<path> | --stack ImMcp-<slug> --region <r>]
//                              [--redirect-uri <url> ...] [--public]
// Default redirect URIs: Amazon Quick callbacks in the stack's region and us-east-1.
// The printed client secret is a credential: paste it into the client, don't commit or share it.
import { die, isMain, parseArgs, resolveTarget, stackOutputs } from './common.js';

function quickCallbacks(region: string): string[] {
  return [...new Set([region, 'us-east-1'])].map((r) => `https://${r}.quicksight.aws.amazon.com/sn/oauthcallback`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t = resolveTarget(args);
  const outs = await stackOutputs(t);
  const base = outs.BaseUrl ?? die(`stack ${t.stack} has no BaseUrl output`);
  const uris = process.argv.flatMap((a, i, all) => (a === '--redirect-uri' && all[i + 1] ? [all[i + 1]] : []));
  const redirectUris = uris.length ? uris : quickCallbacks(t.region);
  const isPublic = args.flags.public === true;

  const r = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'manual',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_post',
    }),
  });
  const b = (await r.json()) as Record<string, unknown>;
  if (r.status !== 201) die(`register failed: HTTP ${r.status} ${JSON.stringify(b)}`);

  const rows: [string, string][] = [
    ['MCP server endpoint', `${base}/mcp`],
    ['Client ID', String(b.client_id)],
    ...(isPublic ? ([['Public OAuth client', 'yes (no client secret)']] as [string, string][]) : ([['Client secret', String(b.client_secret)]] as [string, string][])),
    ['Token URL', `${base}/token`],
    ['Authorization URL', `${base}/authorize`],
    ['Redirect URL (allowed)', redirectUris.join('\n                         ')],
  ];
  for (const [k, v] of rows) process.stdout.write(`${k.padEnd(24)} ${v}\n`);
}

if (isMain(import.meta.url)) main().catch((e: Error) => die(e.message));

// Mint an MCP access token for infra-level testing (E2E step 6). Test-only: it reads the HMAC root key.
//   npm run mint-test-token -- [-c config=<path> | --stack ImMcp-<slug> --region <r>] [--user <32 hex>] [--ttl <sec>]
// Prints the token on stdout. Never log or commit the output.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { deriveKeys, mintAccessToken } from '../lambda/shared/tokens.js';
import { die, isMain, parseArgs, resolveTarget, stackOutputs, str } from './common.js';

export const E2E_USER_ID = 'e2e00000000000000000000000000000';

export async function mintTestToken(o: { region: string; rootKeySecretName: string; userId?: string; ttlSec?: number }): Promise<string> {
  const userId = o.userId ?? E2E_USER_ID;
  if (!/^[0-9a-z]{32}$/.test(userId)) throw new Error('user id must be 32 lowercase alphanumeric characters');
  const sm = new SecretsManagerClient({ region: o.region });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: o.rootKeySecretName }));
  if (!r.SecretString) throw new Error(`secret ${o.rootKeySecretName} is empty`);
  return mintAccessToken(deriveKeys(r.SecretString), userId, o.ttlSec ?? 3600);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t = resolveTarget(args);
  const outs = await stackOutputs(t);
  const rootKeySecretName = outs.RootKeySecretName ?? die(`stack ${t.stack} has no RootKeySecretName output`);
  const ttl = str(args, 'ttl');
  const token = await mintTestToken({ region: t.region, rootKeySecretName, userId: str(args, 'user'), ttlSec: ttl ? Number(ttl) : undefined });
  process.stdout.write(`${token}\n`);
}

if (isMain(import.meta.url)) main().catch((e: Error) => die(e.message));

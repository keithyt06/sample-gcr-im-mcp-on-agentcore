// Clean up what `cdk destroy` leaves behind for one slug (review L-7, Ops teardown checklist):
//   - per-user IM credential secrets <slug>/users/* (created at runtime, not by CloudFormation): force-deleted
//   - the per-user-secret KMS CMK (RemovalPolicy RETAIN, about USD 1/month): deletion scheduled (7-day window)
//   npm run teardown:extras -- [-c config=<path> | --slug <slug> --region <r>] [--yes]
// Run it AFTER `npm run destroy`. Without --yes it lists what it would do and asks for confirmation.
import { createInterface } from 'node:readline/promises';
import { KMSClient, ListKeysCommand, ListResourceTagsCommand, DescribeKeyCommand, ScheduleKeyDeletionCommand } from '@aws-sdk/client-kms';
import { DeleteSecretCommand, ListSecretsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { die, isMain, loadArgsConfig, parseArgs, str } from './common.js';

async function userSecretNames(sm: SecretsManagerClient, slug: string): Promise<string[]> {
  const out: string[] = [];
  let NextToken: string | undefined;
  do {
    const r = await sm.send(new ListSecretsCommand({ Filters: [{ Key: 'name', Values: [`${slug}/users/`] }], NextToken, IncludePlannedDeletion: true }));
    for (const s of r.SecretList ?? []) if (s.Name?.startsWith(`${slug}/users/`)) out.push(s.Name);
    NextToken = r.NextToken;
  } while (NextToken);
  return out;
}

/** Customer-managed keys tagged im-mcp:slug=<slug> that are not already pending deletion. */
async function slugKeys(kms: KMSClient, slug: string): Promise<string[]> {
  const out: string[] = [];
  let Marker: string | undefined;
  do {
    const r = await kms.send(new ListKeysCommand({ Marker }));
    for (const k of r.Keys ?? []) {
      try {
        const tags = await kms.send(new ListResourceTagsCommand({ KeyId: k.KeyId }));
        if (!tags.Tags?.some((t) => t.TagKey === 'im-mcp:slug' && t.TagValue === slug)) continue;
        const d = await kms.send(new DescribeKeyCommand({ KeyId: k.KeyId }));
        if (d.KeyMetadata?.KeyManager === 'CUSTOMER' && d.KeyMetadata.KeyState !== 'PendingDeletion') out.push(d.KeyMetadata.Arn ?? k.KeyId!);
      } catch {
        /* keys we cannot read (other owners / AWS managed) are skipped */
      }
    }
    Marker = r.Truncated ? r.NextMarker : undefined;
  } while (Marker);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  let slug = str(args, 'slug');
  let region = str(args, 'region') ?? process.env.AWS_REGION;
  if (!slug || !region) {
    const cfg = loadArgsConfig(args);
    slug ??= cfg.slug;
    region ??= cfg.region;
  }
  const sm = new SecretsManagerClient({ region });
  const kms = new KMSClient({ region });
  const [secrets, keys] = await Promise.all([userSecretNames(sm, slug), slugKeys(kms, slug)]);

  console.log(`slug ${slug} in ${region}:`);
  console.log(`  ${secrets.length} user secret(s) to force-delete (no recovery window)`);
  for (const k of keys) console.log(`  KMS key to schedule for deletion in 7 days: ${k}`);
  if (!secrets.length && !keys.length) return console.log('nothing to clean up');

  if (args.flags.yes !== true) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`Type the slug (${slug}) to confirm: `);
    rl.close();
    if (answer.trim() !== slug) die('not confirmed; nothing changed');
  }
  for (const name of secrets) await sm.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
  for (const k of keys) await kms.send(new ScheduleKeyDeletionCommand({ KeyId: k, PendingWindowInDays: 7 }));
  console.log(`done: ${secrets.length} secret(s) deleted, ${keys.length} key(s) scheduled for deletion`);
  console.log('Still manual (see the Ops teardown checklist): the runtime log group /aws/bedrock-agentcore/runtimes/<id>-DEFAULT and CDK asset images in ECR.');
}

if (isMain(import.meta.url)) main().catch((e: Error) => die(e.message));

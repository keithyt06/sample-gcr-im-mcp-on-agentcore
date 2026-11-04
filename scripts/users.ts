// Operator user management.
//   npm run users -- list                [-c config=<path> | --stack ImMcp-<slug> --region <r>]
//   npm run users -- approve <userId> [...]
//   npm run users -- revoke  <userId> [...]
import { DynamoDBClient, ScanCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DeleteSecretCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { die, isMain, parseArgs, resolveTarget, stackOutputs } from './common.js';

const USAGE = `usage: npm run users -- <command> [-c config=<path> | --stack ImMcp-<slug> --region <region>]

commands:
  list                 List users (user#<id> items) with status:
                         active | pending_approval | revoked | replaced
  approve <userId>...  WeCom with wecom.requireApproval: true. Lets a pending user call tools.
  revoke <userId>...   Disable a user and force-delete their IM credential secret.

revoke semantics:
  - Permanent. There is no "unrevoke". To restore access, the person must log in again; for
    feishu/lark/dingtalk the IM identity is still bound to the disabled user id, so they stay
    blocked until you delete the ident#<im>#<imUid> item by hand.
  - Takes effect at once for new logins and refresh tokens (refresh_token grants check the flag).
  - MCP access tokens already issued stay valid until they expire (at most 1 hour), and the
    middleware caches IM credentials for up to 60 s.
  - The IM credential secret <slug>/users/<userId> is deleted without a recovery window.
    ident#/refresh-token items are not deleted; the disabled flag makes them inert.
  - WeCom: a revoked person who scans again is refused by the oauth Lambda (review M-2).`;

const val = (v?: AttributeValue): string => v?.S ?? v?.N ?? (v?.BOOL !== undefined ? String(v.BOOL) : '');

function status(it: Record<string, AttributeValue>): string {
  if (it.disabled?.BOOL) return it.replacedBy ? 'replaced' : 'revoked';
  if (val(it.approval) === 'pending') return 'pending_approval';
  return 'active';
}

const isUserId = (id: string) => /^[0-9a-z]{32}$/.test(id);

async function main(): Promise<void> {
  const args = parseArgs();
  const [cmd, ...ids] = args.positional;
  if (args.flags.help || !['list', 'approve', 'revoke'].includes(cmd ?? '')) {
    console.error(USAGE);
    process.exit(args.flags.help ? 0 : 2);
  }
  if (cmd !== 'list' && !ids.length) die(`usage: npm run users -- ${cmd} <userId> [...]`);
  for (const id of ids) if (!isUserId(id)) die(`not a user id: ${id}`);

  const t = resolveTarget(args);
  const outs = await stackOutputs(t);
  const table = outs.TableName ?? die(`stack ${t.stack} has no TableName output`);
  const prefix = outs.UserSecretPrefix ?? die(`stack ${t.stack} has no UserSecretPrefix output`);
  const ddb = new DynamoDBClient({ region: t.region });

  if (cmd === 'list') {
    const rows: Record<string, string>[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const r = await ddb.send(
        new ScanCommand({
          TableName: table,
          FilterExpression: 'begins_with(pk, :p)',
          ExpressionAttributeValues: { ':p': { S: 'user#' } },
          ExclusiveStartKey: start,
        }),
      );
      for (const it of r.Items ?? [])
        rows.push({
          userId: val(it.pk).slice('user#'.length),
          im: val(it.im),
          status: status(it),
          createdAt: val(it.createdAt),
          lastLoginAt: val(it.lastLoginAt),
          replacedBy: val(it.replacedBy),
        });
      start = r.LastEvaluatedKey;
    } while (start);
    console.table(rows);
    return;
  }

  if (cmd === 'approve') {
    for (const id of ids) {
      await ddb.send(
        new UpdateItemCommand({
          TableName: table,
          Key: { pk: { S: `user#${id}` } },
          UpdateExpression: 'SET approval = :a, approvedAt = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':a': { S: 'approved' }, ':now': { N: String(Math.floor(Date.now() / 1000)) } },
        }),
      );
      console.log(`approved ${id}`);
    }
    return;
  }

  const sm = new SecretsManagerClient({ region: t.region });
  for (const id of ids) {
    await ddb.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: `user#${id}` } },
        UpdateExpression: 'SET disabled = :t',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':t': { BOOL: true } },
      }),
    );
    try {
      await sm.send(new DeleteSecretCommand({ SecretId: `${prefix}/${id}`, ForceDeleteWithoutRecovery: true }));
    } catch (e) {
      if (!(e instanceof ResourceNotFoundException)) throw e;
    }
    console.log(`revoked ${id} (existing MCP access tokens expire within 1 hour)`);
  }
}

if (isMain(import.meta.url)) main().catch((e: Error) => die(e.message));

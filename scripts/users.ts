// Operator user management.
//   npm run users -- list   [-c config=<path> | --stack ImMcp-<slug> --region <r>]
//   npm run users -- revoke <userId> [...]
// revoke: sets user#<id>.disabled (refresh tokens stop working, new logins are refused), then force-deletes
// the user's IM credential secret. Existing MCP access tokens expire within 1 hour.
import { DynamoDBClient, ScanCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DeleteSecretCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { die, isMain, parseArgs, resolveTarget, stackOutputs } from './common.js';

const val = (v?: AttributeValue): string => v?.S ?? v?.N ?? (v?.BOOL !== undefined ? String(v.BOOL) : '');

async function main(): Promise<void> {
  const args = parseArgs();
  const [cmd, ...ids] = args.positional;
  if (cmd !== 'list' && cmd !== 'revoke') die('usage: npm run users -- list | revoke <userId> [...]');
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
          createdAt: val(it.createdAt),
          lastLoginAt: val(it.lastLoginAt),
          disabled: val(it.disabled) || 'false',
          replacedBy: val(it.replacedBy),
        });
      start = r.LastEvaluatedKey;
    } while (start);
    console.table(rows);
    return;
  }

  if (!ids.length) die('usage: npm run users -- revoke <userId> [...]');
  const sm = new SecretsManagerClient({ region: t.region });
  for (const id of ids) {
    if (!/^[0-9a-z]{32}$/.test(id)) die(`not a user id: ${id}`);
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
    console.log(`revoked ${id}`);
  }
}

if (isMain(import.meta.url)) main().catch((e: Error) => die(e.message));

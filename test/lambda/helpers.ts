// Shared test fixtures: in-memory DynamoDB and Secrets Manager behind aws-sdk-client-mock,
// a static SSM base URL, and HTTP event builders. No AWS calls are made.
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  InvalidRequestException,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  RestoreSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { resetAdapter } from '../../lambda/oauth/context';
import { resetAppSecretCache } from '../../lambda/shared/app-secret';
import { resetBaseUrlCache } from '../../lambda/shared/base-url';
import type { HttpEvent } from '../../lambda/shared/http';
import { resetKeyCache } from '../../lambda/shared/keys';
import { setRuntimeDeps } from '../../lambda/shared/runtime-client';
import { deriveKeys } from '../../lambda/shared/tokens';

export const ROOT = 'test-root-key-0123456789abcdef0123456789abcdef';
export const KEYS = deriveKeys(ROOT);
export const BASE = 'https://mcp.example.com';
export const SLUG = 'team-a';
export const PREFIX = `${SLUG}/users`;
export const USER_A = 'a'.repeat(32);
export const USER_B = 'b'.repeat(32);

export const ddbMock = mockClient(DynamoDBClient);
export const smMock = mockClient(SecretsManagerClient);
export const ssmMock = mockClient(SSMClient);

type Item = Record<string, AttributeValue>;
export const table = new Map<string, Item>();

export interface FakeSecret {
  value?: string;
  kms?: string;
  tags: Record<string, string>;
  deleted?: boolean;
}
export const secrets = new Map<string, FakeSecret>();

const notFound = () => new ResourceNotFoundException({ message: 'Secrets Manager can not find the specified secret.', $metadata: {} });
const pendingDeletion = () =>
  new InvalidRequestException({ message: 'You can not perform this operation on a secret that is scheduled for deletion.', $metadata: {} });

function evalCondition(cond: string | undefined, item: Item | undefined): boolean {
  if (!cond) return true;
  return cond.split(' AND ').every((c) => {
    const m = /^attribute_(not_)?exists\((\w+)\)$/.exec(c.trim());
    if (!m) throw new Error(`unsupported condition ${c}`);
    const has = !!item && m[2]! in item;
    return m[1] ? !has : has;
  });
}

export function installFakes(): void {
  table.clear();
  secrets.clear();
  ddbMock.reset();
  smMock.reset();
  ssmMock.reset();

  ddbMock.on(PutItemCommand).callsFake((i: { Item: Item; ConditionExpression?: string }) => {
    const pk = i.Item.pk!.S!;
    if (!evalCondition(i.ConditionExpression, table.get(pk))) throw new ConditionalCheckFailedException({ message: 'cond', $metadata: {} });
    table.set(pk, structuredClone(i.Item));
    return {};
  });
  ddbMock.on(GetItemCommand).callsFake((i: { Key: Item }) => ({ Item: structuredClone(table.get(i.Key.pk!.S!)) }));
  ddbMock.on(DeleteItemCommand).callsFake((i: { Key: Item; ReturnValues?: string }) => {
    const pk = i.Key.pk!.S!;
    const old = table.get(pk);
    table.delete(pk);
    return i.ReturnValues === 'ALL_OLD' ? { Attributes: old } : {};
  });
  ddbMock.on(UpdateItemCommand).callsFake(
    (i: {
      Key: Item;
      UpdateExpression: string;
      ConditionExpression?: string;
      ExpressionAttributeValues?: Item;
      ExpressionAttributeNames?: Record<string, string>;
      ReturnValues?: string;
    }) => {
      const pk = i.Key.pk!.S!;
      const cur = table.get(pk);
      if (!evalCondition(i.ConditionExpression, cur)) throw new ConditionalCheckFailedException({ message: 'cond', $metadata: {} });
      const item: Item = structuredClone(cur ?? { pk: { S: pk } });
      for (const part of i.UpdateExpression.replace(/^SET\s+/, '').split(',')) {
        const [rawName, val] = part.split('=').map((s) => s.trim()) as [string, string];
        const name = i.ExpressionAttributeNames?.[rawName] ?? rawName;
        item[name] = i.ExpressionAttributeValues![val]!;
      }
      table.set(pk, item);
      return i.ReturnValues === 'ALL_NEW' ? { Attributes: structuredClone(item) } : {};
    },
  );

  smMock.on(GetSecretValueCommand).callsFake((i: { SecretId: string }) => {
    if (i.SecretId === `${SLUG}/root-key`) return { SecretString: ROOT };
    const s = secrets.get(i.SecretId);
    if (!s) throw notFound();
    if (s.deleted) throw pendingDeletion();
    return { SecretString: s.value };
  });
  smMock.on(CreateSecretCommand).callsFake((i: { Name: string; SecretString: string; KmsKeyId?: string }) => {
    const s = secrets.get(i.Name);
    if (s?.deleted) throw pendingDeletion();
    if (s) throw new ResourceExistsException({ message: 'exists', $metadata: {} });
    secrets.set(i.Name, { value: i.SecretString, kms: i.KmsKeyId, tags: {} });
    return {};
  });
  smMock.on(PutSecretValueCommand).callsFake((i: { SecretId: string; SecretString: string }) => {
    const s = secrets.get(i.SecretId);
    if (!s) throw notFound();
    if (s.deleted) throw pendingDeletion();
    s.value = i.SecretString;
    return {};
  });
  smMock.on(RestoreSecretCommand).callsFake((i: { SecretId: string }) => {
    const s = secrets.get(i.SecretId);
    if (!s) throw notFound();
    s.deleted = false;
    return {};
  });
  smMock.on(DescribeSecretCommand).callsFake((i: { SecretId: string }) => {
    const s = secrets.get(i.SecretId);
    if (!s) throw notFound();
    return {
      Name: i.SecretId,
      DeletedDate: s.deleted ? new Date() : undefined,
      Tags: Object.entries(s.tags).map(([Key, Value]) => ({ Key, Value })),
    };
  });
  smMock.on(DeleteSecretCommand).callsFake((i: { SecretId: string }) => {
    const s = secrets.get(i.SecretId);
    if (!s) throw notFound();
    s.deleted = true;
    return {};
  });
  smMock.on(ListSecretsCommand).callsFake((i: { Filters?: { Values?: string[] }[]; NextToken?: string }) => {
    const prefix = i.Filters?.[0]?.Values?.[0] ?? '';
    const all = [...secrets.keys()].filter((n) => n.startsWith(prefix)).sort();
    const start = i.NextToken ? Number(i.NextToken) : 0;
    const page = all.slice(start, start + 2);
    return { SecretList: page.map((Name) => ({ Name })), NextToken: start + 2 < all.length ? String(start + 2) : undefined };
  });

  ssmMock.on(GetParameterCommand).callsFake((i: { Name: string }) => {
    if (i.Name === `/im-mcp/${SLUG}/base-url`) return { Parameter: { Value: BASE } };
    if (i.Name === '/team-a/alarm-webhook') return { Parameter: { Value: 'https://hooks.example.com/bot' } };
    throw Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
  });

  resetKeyCache();
  resetBaseUrlCache();
  resetAppSecretCache();
  resetAdapter();
  setRuntimeDeps(undefined);
}

export function setEnv(im: 'feishu' | 'lark' | 'dingtalk' | 'wecom', extra: Record<string, string> = {}): void {
  const base: Record<string, string> = {
    IM: im,
    SLUG,
    AWS_REGION: 'ap-northeast-1',
    METRIC_NAMESPACE: `ImMcp/${SLUG}`,
    BASE_URL_PARAM: `/im-mcp/${SLUG}/base-url`,
    ROOT_KEY_SECRET_ID: `${SLUG}/root-key`,
    TABLE_NAME: 'OauthTable',
    USER_SECRET_PREFIX: PREFIX,
    USER_SECRET_KMS_KEY_ARN: 'arn:aws:kms:ap-northeast-1:ACCOUNT:key/test',
    EXTRA_REDIRECT_HOSTS: '',
    QUICK_REDIRECT_HOSTS: 'quicksight.aws.amazon.com,*.quicksight.aws.amazon.com',
    RUNTIME_ARN: 'arn:aws:bedrock-agentcore:ap-northeast-1:ACCOUNT:runtime/im_mcp_team_a-abc',
    AGENTCORE_ENDPOINT: 'https://bedrock-agentcore.ap-northeast-1.amazonaws.com',
    NEEDS_USER_TOKEN: im === 'wecom' ? 'false' : 'true',
  };
  if (im !== 'wecom') {
    base.IM_APP_ID = im === 'dingtalk' ? 'dingclientid0001' : 'cli_test00000001';
    base.IM_APP_SECRET_ID = `${SLUG}/im-app`;
    base.IM_SCOPES = im === 'dingtalk' ? 'openid,corpid' : 'offline_access,im:message';
  }
  for (const k of Object.keys(process.env)) if (k in base || k in extra || k === 'IM_APP_ID' || k === 'IM_APP_SECRET_ID' || k === 'IM_SCOPES') delete process.env[k];
  Object.assign(process.env, base, extra);
}

export function configureApp(appId = 'cli_test00000001'): void {
  secrets.set(`${SLUG}/im-app`, { value: JSON.stringify({ appId, appSecret: 'app-secret-value', configured: true }), tags: {} });
}

export function ev(
  methodName: string,
  path: string,
  o: { query?: Record<string, string>; headers?: Record<string, string>; body?: string; base64?: boolean } = {},
): HttpEvent {
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: new URLSearchParams(o.query ?? {}).toString(),
    headers: o.headers ?? {},
    requestContext: { requestId: 'req-1', http: { method: methodName, path } },
    body: o.base64 ? Buffer.from(o.body ?? '').toString('base64') : o.body,
    isBase64Encoded: !!o.base64,
  };
}

export interface FetchCall {
  url: string;
  init: RequestInit;
  body: string;
}

/** fetch fake that routes by URL substring; records calls. */
export function fakeFetch(routes: [string | RegExp, (c: FetchCall) => Response | Promise<Response>][]): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init.body === undefined ? '' : Buffer.isBuffer(init.body) ? init.body.toString('utf8') : String(init.body);
    const c = { url, init, body };
    calls.push(c);
    for (const [m, h] of routes) if (typeof m === 'string' ? url.includes(m) : m.test(url)) return h(c);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch & { calls: FetchCall[] };
  f.calls = calls;
  return f;
}

export const jsonResp = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const sseResp = (payload: unknown): Response =>
  new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });

export function useRuntime(f: typeof fetch): void {
  setRuntimeDeps({ fetch: f, credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-only' } });
}

export function emfLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"_aws"'))
    .map((l) => (JSON.parse(l) as { event: string }).event);
}

export const headersOf = (c: FetchCall): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.init.headers as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
};

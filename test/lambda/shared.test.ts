// env, log/EMF, http helpers, redirects, keys/base-url/app-secret caches, user-secrets.
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  InvalidRequestException,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AppNotConfiguredError, loadAppSecret, parseAppSecret } from '../../lambda/shared/app-secret';
import { baseUrl } from '../../lambda/shared/base-url';
import { env, envIm, envList, envOpt, isRedirectIm, MissingEnvError } from '../../lambda/shared/env';
import { BackendUnavailableError, formOrJson, header, html, query, redirect, sse } from '../../lambda/shared/http';
import { loadKeys } from '../../lambda/shared/keys';
import { errName, hashUserId, log, metric } from '../../lambda/shared/log';
import { hostMatches, isAllowedRedirect, redirectMatches, withParams } from '../../lambda/shared/redirects';
import * as us from '../../lambda/shared/user-secrets';
import { configureApp, ev, installFakes, PREFIX, secrets, setEnv, smMock, ssmMock, USER_A } from './helpers';

let out: MockInstance<typeof console.log>;
beforeEach(() => {
  installFakes();
  setEnv('feishu');
  out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => out.mockRestore());

describe('env', () => {
  it('reads required, optional, list, im', () => {
    expect(env('SLUG')).toBe('team-a');
    delete process.env.SLUG;
    expect(() => env('SLUG')).toThrow(MissingEnvError);
    process.env.IM_SCOPES = '';
    expect(envOpt('IM_SCOPES')).toBeUndefined();
    process.env.EXTRA_REDIRECT_HOSTS = ' a.example.com, ,b.example.com ';
    expect(envList('EXTRA_REDIRECT_HOSTS')).toEqual(['a.example.com', 'b.example.com']);
    expect(envIm()).toBe('feishu');
    process.env.IM = 'slack';
    expect(() => envIm()).toThrow(/invalid/);
    expect(isRedirectIm('wecom')).toBe(false);
    expect(isRedirectIm('lark')).toBe(true);
  });
});

describe('log', () => {
  it('emits JSON logs and EMF lines in the documented shape', () => {
    log('INFO', 'x', { a: 1 });
    metric('TokenLost');
    const lines = out.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines[0]).toMatchObject({ level: 'INFO', event: 'x', a: 1 });
    expect(lines[1]).toMatchObject({
      _aws: { CloudWatchMetrics: [{ Namespace: 'ImMcp/team-a', Dimensions: [[]], Metrics: [{ Name: 'TokenLost', Unit: 'Count' }] }] },
      TokenLost: 1,
      event: 'TokenLost',
    });
    expect(typeof lines[1]._aws.Timestamp).toBe('number');
    delete process.env.METRIC_NAMESPACE;
    metric('RefreshFailed', 2);
    expect(JSON.parse(String(out.mock.calls[2]![0]))._aws.CloudWatchMetrics[0].Namespace).toBe('ImMcp');
  });
  it('hashes user ids', () => {
    expect(hashUserId(USER_A)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashUserId(USER_A)).not.toContain(USER_A.slice(0, 8));
    expect(errName(new TypeError('x'))).toBe('TypeError');
    expect(errName('s')).toBe('string');
  });
});

describe('http helpers', () => {
  it('headers are case-insensitive; query parsing; bodies', () => {
    const e = ev('POST', '/token', { headers: { 'Content-Type': 'application/json' }, body: '{"a":"1","b":2}', query: { x: '1' } });
    expect(header(e, 'content-type')).toBe('application/json');
    expect(header({ ...e, headers: undefined }, 'x')).toBeUndefined();
    expect(query(e)).toEqual({ x: '1' });
    expect(query({ ...e, rawQueryString: undefined, queryStringParameters: { y: '2', z: undefined } })).toEqual({ y: '2' });
    expect(formOrJson(e)).toEqual({ a: '1' });
    expect(formOrJson({ ...e, body: 'not json' })).toEqual({});
    expect(formOrJson({ ...e, body: '[1]' })).toEqual({});
    const f = ev('POST', '/token', { body: 'a=1&a=2&b=x', base64: true });
    expect(formOrJson(f)).toEqual({ a: '1', b: 'x' });
  });
  it('response helpers set no-store', () => {
    expect(html(200, 'x').headers!['Cache-Control']).toBe('no-store');
    expect(redirect('https://x').headers!.Location).toBe('https://x');
    expect(sse(200, { a: 1 }).body).toBe('event: message\ndata: {"a":1}\n\n');
  });
});

describe('redirects', () => {
  const hosts = ['quicksight.aws.amazon.com', '*.quicksight.aws.amazon.com', 'corp.example.com'];
  it.each([
    ['http://127.0.0.1:33418/callback', true],
    ['http://localhost/cb', true],
    ['https://localhost:9/cb', true],
    ['http://[::1]:8080/cb', true],
    ['https://quicksight.aws.amazon.com/sn/oauthcallback', true],
    ['https://us-east-1.quicksight.aws.amazon.com/cb', true],
    ['https://corp.example.com/cb', true],
    ['https://sub.corp.example.com/cb', false],
    ['http://quicksight.aws.amazon.com/cb', false],
    ['https://quicksight.aws.amazon.com.evil.com/cb', false],
    ['https://evilquicksight.aws.amazon.com/cb', false],
    ['cursor://anysphere.cursor-retrieval/oauth', false],
    ['http://user:pw@127.0.0.1/cb', false],
    ['http://127.0.0.1/cb#frag', false],
    ['not a url', false],
    ['', false],
    [`https://corp.example.com/${'a'.repeat(2000)}`, false],
  ])('%s → %s', (uri, ok) => {
    expect(isAllowedRedirect(uri, hosts)).toBe(ok);
  });
  it('reads hosts from env by default', () => {
    process.env.EXTRA_REDIRECT_HOSTS = '*.corp.example.com';
    expect(isAllowedRedirect('https://a.corp.example.com/cb')).toBe(true);
    expect(isAllowedRedirect('https://corp.example.com/cb')).toBe(false);
    expect(isAllowedRedirect('https://quicksight.aws.amazon.com/cb')).toBe(true);
    process.env.QUICK_REDIRECT_HOSTS = '';
    expect(isAllowedRedirect('https://quicksight.aws.amazon.com/cb')).toBe(false);
  });
  it('wildcard matches strict subdomains only', () => {
    expect(hostMatches('a.b.x.y', '*.x.y')).toBe(true);
    expect(hostMatches('x.y', '*.x.y')).toBe(false);
    expect(hostMatches('X.Y', 'x.y')).toBe(true);
  });
  it('loopback compare ignores the port only', () => {
    expect(redirectMatches('http://127.0.0.1:5000/cb', 'http://127.0.0.1:33418/cb')).toBe(true);
    expect(redirectMatches('http://127.0.0.1:5000/other', 'http://127.0.0.1:33418/cb')).toBe(false);
    expect(redirectMatches('http://localhost:5000/cb', 'http://127.0.0.1:33418/cb')).toBe(false);
    expect(redirectMatches('https://corp.example.com:444/cb', 'https://corp.example.com/cb')).toBe(false);
    expect(redirectMatches('bad', 'http://127.0.0.1/cb')).toBe(false);
    expect(redirectMatches('https://q/cb', 'https://q/cb')).toBe(true);
  });
  it('withParams appends and skips empties', () => {
    expect(withParams('http://127.0.0.1/cb?x=1', { code: 'c', state: undefined, e: '' })).toBe('http://127.0.0.1/cb?x=1&code=c');
  });
});

describe('caches and backends', () => {
  it('root key is cached for 5 minutes and failures are BackendUnavailable', async () => {
    const k1 = await loadKeys();
    const k2 = await loadKeys();
    expect(k1).toBe(k2);
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
  it('root key failure / empty', async () => {
    smMock.on(GetSecretValueCommand).rejects(new Error('throttled'));
    await expect(loadKeys()).rejects.toBeInstanceOf(BackendUnavailableError);
    smMock.on(GetSecretValueCommand).resolves({ SecretString: '' });
    await expect(loadKeys()).rejects.toThrow(/empty/);
  });
  it('base url: trailing slash stripped, cached, failures', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'https://x.example.com/' } });
    expect(await baseUrl()).toBe('https://x.example.com');
    expect(await baseUrl()).toBe('https://x.example.com');
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });
  it('base url invalid / error', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'http://insecure' } });
    await expect(baseUrl()).rejects.toThrow(/invalid/);
    ssmMock.on(GetParameterCommand).rejects(new Error('x'));
    await expect(baseUrl()).rejects.toBeInstanceOf(BackendUnavailableError);
  });
  it('app secret: placeholder is not configured', async () => {
    expect(() => parseAppSecret('{"configured":false,"appSecret":"gen"}')).toThrow(AppNotConfiguredError);
    expect(() => parseAppSecret('nope')).toThrow(AppNotConfiguredError);
    expect(() => parseAppSecret('null')).toThrow(AppNotConfiguredError);
    expect(() => parseAppSecret('{"configured":true,"appSecret":"s"}')).toThrow(AppNotConfiguredError);
    expect(parseAppSecret('{"configured":true,"appSecret":"s"}', 'fallback')).toEqual({ appId: 'fallback', appSecret: 's' });
    await expect(loadAppSecret()).rejects.toBeInstanceOf(BackendUnavailableError); // not found
    configureApp();
    expect(await loadAppSecret()).toEqual({ appId: 'cli_test00000001', appSecret: 'app-secret-value' });
    expect(await loadAppSecret()).toEqual({ appId: 'cli_test00000001', appSecret: 'app-secret-value' });
  });
});

describe('user-secrets', () => {
  const cred: us.StoredCredential = { accessToken: 'at', refreshToken: 'rt', expiresAt: 2, issuedAt: 1, im: 'feishu', imUid: 'ou' };

  it('create on the CMK, then put, then restore + put on pending deletion', async () => {
    await us.putCredential(USER_A, cred);
    expect(secrets.get(`${PREFIX}/${USER_A}`)!.kms).toContain(':kms:');
    expect(await us.getCredential(USER_A)).toEqual(cred);
    await us.putCredential(USER_A, { ...cred, accessToken: 'at2' });
    expect((await us.getCredential(USER_A))!.accessToken).toBe('at2');
    await us.deleteCredential(USER_A);
    expect(await us.getCredential(USER_A)).toBeNull();
    await us.putCredential(USER_A, { ...cred, accessToken: 'at3' });
    expect((await us.getCredential(USER_A))!.accessToken).toBe('at3');
  });

  it('restores when put hits pending deletion after a ResourceExists create', async () => {
    secrets.set(`${PREFIX}/${USER_A}`, { value: '{}', tags: {} });
    const pending = new InvalidRequestException({ message: 'marked for deletion', $metadata: {} });
    smMock.on(PutSecretValueCommand).rejectsOnce(pending).callsFake((i: { SecretId: string; SecretString: string }) => {
      secrets.get(i.SecretId)!.value = i.SecretString;
      return {};
    });
    await us.putCredential(USER_A, cred);
    expect(JSON.parse(secrets.get(`${PREFIX}/${USER_A}`)!.value!)).toEqual(cred);
  });

  it('create without CMK env and unexpected errors propagate', async () => {
    delete process.env.USER_SECRET_KMS_KEY_ARN;
    await us.putCredential(USER_A, cred);
    expect(secrets.get(`${PREFIX}/${USER_A}`)!.kms).toBeUndefined();
    smMock.on(CreateSecretCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(us.putCredential(USER_B(), cred)).rejects.toThrow('denied');
    smMock.on(CreateSecretCommand).rejects(Object.assign(new Error('exists'), { name: 'ResourceExistsException' }));
    smMock.on(PutSecretValueCommand).rejects(new Error('put failed'));
    await expect(us.putCredential(USER_A, cred)).rejects.toThrow('put failed');
  });

  it('get: unparseable → null, throttle → BackendUnavailable', async () => {
    secrets.set(`${PREFIX}/${USER_A}`, { value: 'garbage', tags: {} });
    expect(await us.getCredential(USER_A)).toBeNull();
    secrets.set(`${PREFIX}/${USER_A}`, { value: '{"accessToken":1}', tags: {} });
    expect(await us.getCredential(USER_A)).toBeNull();
    secrets.set(`${PREFIX}/${USER_A}`, { value: 'null', tags: {} });
    expect(await us.getCredential(USER_A)).toBeNull();
    smMock.on(GetSecretValueCommand).rejects(Object.assign(new Error('rate'), { name: 'ThrottlingException' }));
    await expect(us.getCredential(USER_A)).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it('describe returns tags and handles absence / pending deletion / errors', async () => {
    expect(await us.describeCredential(USER_A)).toEqual({ exists: false, tags: {} });
    secrets.set(`${PREFIX}/${USER_A}`, { value: '{}', tags: { WecomUserId: 'wo_1' } });
    expect(await us.describeCredential(USER_A)).toEqual({ exists: true, tags: { WecomUserId: 'wo_1' } });
    secrets.get(`${PREFIX}/${USER_A}`)!.deleted = true;
    expect((await us.describeCredential(USER_A)).exists).toBe(false);
    smMock.on(DescribeSecretCommand).rejects(new Error('denied'));
    await expect(us.describeCredential(USER_A)).rejects.toThrow('denied');
  });

  it('list is paginated and single-segment only', async () => {
    for (const n of ['u1', 'u2', 'u3', 'nested/x']) secrets.set(`${PREFIX}/${n}`, { value: '{}', tags: {} });
    secrets.set(`${PREFIX}-other/u9`, { value: '{}', tags: {} });
    secrets.set(`${PREFIX}/`, { value: '{}', tags: {} });
    expect((await us.listCredentialNames()).sort()).toEqual([`${PREFIX}/u1`, `${PREFIX}/u2`, `${PREFIX}/u3`]);
  });

  it('pending-deletion detection', () => {
    expect(us.isPendingDeletion({ name: 'InvalidRequestException', message: 'because it was deleted' })).toBe(true);
    expect(us.isPendingDeletion({ name: 'InvalidRequestException', message: 'other' })).toBe(false);
    expect(us.isPendingDeletion(null)).toBe(false);
  });
});

function USER_B(): string {
  return 'b'.repeat(32);
}

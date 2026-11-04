// IAM least-privilege contract (technical design §3.5, §6.2).
import { describe, expect, it } from 'vitest';
import { arr, resourcesOf, statements, synthFixture, type Synth } from './helpers.js';

/** Actions per role, keyed by a role label, for one synthesized stack. */
function actionsByRole(s: Synth): Record<string, Set<string>> {
  const res = resourcesOf(s.json);
  const label: Record<string, string> = {};
  for (const [id, r] of Object.entries(res)) {
    if (r.Type === 'AWS::Lambda::Function') {
      const fn = r.Properties.FunctionName as string;
      label[r.Properties.Role['Fn::GetAtt'][0]] = fn.slice(fn.lastIndexOf('-') + 1);
    }
    if (r.Type === 'AWS::BedrockAgentCore::Runtime') label[r.Properties.RoleArn['Fn::GetAtt'][0]] = 'runtime';
    void id;
  }
  const out: Record<string, Set<string>> = {};
  for (const { roles, st } of statements(s.json)) {
    for (const role of roles) {
      const l = label[role];
      if (!l) continue;
      out[l] ??= new Set();
      for (const a of arr(st.Action)) out[l].add(a);
    }
  }
  return out;
}

function starStatements(s: Synth): string[] {
  return statements(s.json)
    .filter(({ st }) => arr(st.Resource).includes('*'))
    .flatMap(({ st }) => arr(st.Action))
    .sort();
}

const LOGS = ['logs:CreateLogStream', 'logs:PutLogEvents'];

describe('IAM: feishu (redirect)', () => {
  const s = synthFixture('feishu-aws', { bundle: false });
  const a = actionsByRole(s);

  it('Resource "*" only for ecr:GetAuthorizationToken and secretsmanager:ListSecrets', () => {
    expect(starStatements(s)).toEqual(['ecr:GetAuthorizationToken', 'secretsmanager:ListSecrets']);
  });
  it('runtime role: ECR pull, runtime logs, im-app read; no writes, no models', () => {
    expect([...a.runtime].sort()).toEqual(
      [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetAuthorizationToken',
        'ecr:GetDownloadUrlForLayer',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:DescribeLogStreams',
        'logs:PutLogEvents',
        'secretsmanager:GetSecretValue',
      ].sort(),
    );
  });
  it('oauth role per §6.2 (redirect)', () => {
    expect([...a.oauth].sort()).toEqual(
      [
        ...LOGS,
        'secretsmanager:GetSecretValue',
        'secretsmanager:CreateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:RestoreSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:TagResource',
        'kms:Encrypt',
        'kms:GenerateDataKey',
        'kms:Decrypt',
        'kms:DescribeKey',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        'dynamodb:UpdateItem',
        'ssm:GetParameter',
      ].sort(),
    );
  });
  it('middleware role per §6.2 (redirect)', () => {
    expect([...a.middleware].sort()).toEqual(
      [...LOGS, 'secretsmanager:GetSecretValue', 'kms:Decrypt', 'bedrock-agentcore:InvokeAgentRuntime', 'ssm:GetParameter'].sort(),
    );
  });
  it('refresh role per §6.2', () => {
    expect([...a.refresh].sort()).toEqual(
      [
        ...LOGS,
        'secretsmanager:ListSecrets',
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:DeleteSecret',
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:DescribeKey',
      ].sort(),
    );
  });
  it('user-secret statements are scoped to <slug>/users/*', () => {
    const text = JSON.stringify(s.json);
    expect(text).toContain(':secret:t-feishu-aws/users/*');
    expect(text).not.toMatch(/:secret:\*/);
  });
  it('ssm:GetParameter is scoped to the base-url parameter', () => {
    const ssm = statements(s.json).filter(({ st }) => arr(st.Action).includes('ssm:GetParameter'));
    for (const { st } of ssm) expect(JSON.stringify(st.Resource)).toContain('parameter/im-mcp/t-feishu-aws/base-url');
  });
});

describe('IAM: dingtalk (redirect, no app secret in runtime)', () => {
  const a = actionsByRole(synthFixture('dingtalk-cn', { bundle: false }));
  it('runtime role cannot read secrets', () => {
    expect([...a.runtime].some((x) => x.startsWith('secretsmanager:'))).toBe(false);
  });
});

describe('IAM: wecom (qr)', () => {
  const s = synthFixture('wecom-cn', { bundle: false });
  const a = actionsByRole(s);

  it('Resource "*" only for ecr:GetAuthorizationToken (no refresh Lambda)', () => {
    expect(starStatements(s)).toEqual(['ecr:GetAuthorizationToken']);
  });
  it('runtime role writes user secrets with the CMK', () => {
    for (const x of ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:GetSecretValue', 'kms:Encrypt', 'kms:GenerateDataKey'])
      expect(a.runtime.has(x), x).toBe(true);
  });
  it('oauth role per §6.2 (wecom)', () => {
    expect([...a.oauth].sort()).toEqual(
      [
        ...LOGS,
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:DeleteSecret',
        'bedrock-agentcore:InvokeAgentRuntime',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',
        'dynamodb:UpdateItem',
        'ssm:GetParameter',
      ].sort(),
    );
  });
  it('middleware cannot read user secrets or decrypt (wecom credentials stay in the runtime)', () => {
    expect([...a.middleware].sort()).toEqual(
      [...LOGS, 'secretsmanager:GetSecretValue', 'bedrock-agentcore:InvokeAgentRuntime', 'ssm:GetParameter'].sort(),
    );
  });
});

describe('IAM: alarm webhook Lambda', () => {
  const s = synthFixture('feishu-aws-edge', { bundle: false });
  it('reads only the configured webhook parameter', () => {
    const a = actionsByRole(s);
    expect([...a.alarm].sort()).toEqual([...LOGS, 'ssm:GetParameter'].sort());
    expect(JSON.stringify(s.json)).toContain('parameter/t-feishu-edge/alarm-webhook');
  });
});

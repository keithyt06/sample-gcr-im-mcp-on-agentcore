// 8-combo synth matrix (4 IM x 2 partitions) + edge/WAF + custom-domain variants (technical design §7.2).
// Writes every template to cdk.out/matrix/<name>.template.json for review.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HDR_PREFIX, RUNTIME_HEADERS } from '../../shared/contract.js';
import { REPO_ROOT } from '../../infra/lib/config.js';
import { STAR_RESOURCE_ACTIONS } from '../../infra/lib/nag.js';
import { arr, IMS, one, PARTITIONS, referencedIds, resourcesOf, statements, synthFixture, type Synth } from './helpers.js';

const OUT = join(REPO_ROOT, 'cdk.out/matrix');
mkdirSync(OUT, { recursive: true });

/** Service principals are `<service>.amazonaws.com` in both partitions; anything else ending in amazonaws.com is an endpoint. */
const PRINCIPALS = new Set(['lambda.amazonaws.com', 'bedrock-agentcore.amazonaws.com', 'apigateway.amazonaws.com', 'events.amazonaws.com', 'sns.amazonaws.com']);

const EXPECTED_ROUTES = [
  'GET /.well-known/oauth-authorization-server',
  'GET /.well-known/oauth-protected-resource',
  'GET /.well-known/oauth-protected-resource/mcp',
  'POST /register',
  'GET /authorize',
  'GET /authorize/status',
  'GET /callback',
  'POST /token',
  'POST /mcp',
  'GET /mcp',
  'DELETE /mcp',
];

const COMBOS = IMS.flatMap((im) => PARTITIONS.map((p) => `${im}-${p}`));
const VARIANTS = ['feishu-aws-edge', 'dingtalk-cn-domain'];

describe.each([...COMBOS, ...VARIANTS])('synth %s', (name) => {
  let s: Synth;
  let text: string;
  let isChina: boolean;
  let redirect: boolean;

  beforeAll(() => {
    s = synthFixture(name);
    text = JSON.stringify(s.json);
    writeFileSync(join(OUT, `${name}.template.json`), JSON.stringify(s.json, null, 1));
    if (s.waf) writeFileSync(join(OUT, `${name}-waf.template.json`), JSON.stringify(s.app.synth().getStackByName(s.waf.stackName).template, null, 1));
    isChina = s.cfg.region.startsWith('cn-');
    redirect = s.cfg.im !== 'wecom';
  });

  const runtime = () => one(s.json, 'AWS::BedrockAgentCore::Runtime').props;
  const runtimeRoleId = () => runtime().RoleArn['Fn::GetAtt'][0] as string;

  it('(a) aws-cn: no arn:aws: literal and no amazonaws.com endpoint literal', () => {
    if (!isChina) {
      expect(text).not.toMatch(/amazonaws\.com\.cn/);
      return;
    }
    expect(text).not.toMatch(/arn:aws:/);
    const hosts = [...text.matchAll(/"([A-Za-z0-9.${}:/-]*amazonaws\.com)"/g)].map((m) => m[1]);
    expect(hosts.filter((h) => !PRINCIPALS.has(h))).toEqual([]);
  });

  it('(b) aws-cn: no CloudFront / WAFv2', () => {
    const types = Object.values(resourcesOf(s.json)).map((r) => r.Type);
    if (isChina) expect(types.filter((t) => /^AWS::(CloudFront|WAFv2)::/.test(t))).toEqual([]);
    expect(types.some((t) => t === 'AWS::CloudFront::Distribution')).toBe(s.cfg.ingress.edge === 'cloudfront');
  });

  it('(c) runtime role trusts bedrock-agentcore.amazonaws.com with SourceAccount/SourceArn', () => {
    const role = resourcesOf(s.json)[runtimeRoleId()].Properties;
    const st = role.AssumeRolePolicyDocument.Statement;
    expect(st).toHaveLength(1);
    expect(st[0].Principal).toEqual({ Service: 'bedrock-agentcore.amazonaws.com' });
    expect(st[0].Condition.StringEquals['aws:SourceAccount']).toBeDefined();
    const p = isChina ? 'aws-cn' : 'aws';
    expect(st[0].Condition.ArnLike['aws:SourceArn']).toBe(`arn:${p}:bedrock-agentcore:${s.cfg.region}:111111111111:*`);
  });

  it('(d) header allowlist equals RUNTIME_HEADERS, all with HDR_PREFIX', () => {
    const allow: string[] = runtime().RequestHeaderConfiguration.RequestHeaderAllowlist;
    expect(allow).toEqual(RUNTIME_HEADERS);
    for (const h of allow) expect(h.startsWith(HDR_PREFIX)).toBe(true);
  });

  it('(e) no bedrock:InvokeModel anywhere', () => {
    expect(text).not.toMatch(/bedrock:InvokeModel/);
    for (const { st } of statements(s.json)) for (const a of arr(st.Action)) expect(a).not.toMatch(/^bedrock:|\*/);
  });

  it('(f) Resource "*" only for the documented actions', () => {
    for (const { st } of statements(s.json)) {
      if (arr(st.Resource).includes('*')) for (const a of arr(st.Action)) expect(STAR_RESOURCE_ACTIONS.has(a), a).toBe(true);
    }
  });

  it('(g) runtime env has no reference to the API, CloudFront or SSM (no cycles, D7)', () => {
    const res = resourcesOf(s.json);
    const ids = referencedIds(runtime().EnvironmentVariables);
    for (const id of ids) expect(res[id]?.Type ?? '', id).not.toMatch(/^AWS::(ApiGatewayV2|CloudFront|SSM)::/);
    // and the runtime resource itself depends on none of them
    const deps = new Set([...referencedIds(runtime()), ...(res[one(s.json, 'AWS::BedrockAgentCore::Runtime').id].DependsOn ?? [])]);
    for (const id of deps) expect(res[id]?.Type ?? '', id).not.toMatch(/^AWS::(ApiGatewayV2|CloudFront|SSM|Lambda)::/);
  });

  it('runtime: MCP protocol, PUBLIC network, idle timeout, name, env', () => {
    const r = runtime();
    expect(r.ProtocolConfiguration).toBe('MCP');
    expect(r.NetworkConfiguration).toEqual({ NetworkMode: 'PUBLIC' });
    expect(r.LifecycleConfiguration.IdleRuntimeSessionTimeout).toBe(s.cfg.runtime.idleTimeoutSec);
    expect(r.AgentRuntimeName).toBe(`im_mcp_${s.cfg.slug.replace(/-/g, '_')}`);
    expect(r.EnvironmentVariables.IM).toBe(s.cfg.im);
    expect(r.EnvironmentVariables.AWS_REGION).toBe(s.cfg.region);
    expect('IM_APP_SECRET_ID' in r.EnvironmentVariables).toBe(s.cfg.im === 'feishu' || s.cfg.im === 'lark');
    expect('DINGTALK_DWS_AGENTCODE' in r.EnvironmentVariables).toBe(s.cfg.im === 'dingtalk');
    expect('USER_SECRET_KMS_KEY_ARN' in r.EnvironmentVariables).toBe(s.cfg.im === 'wecom');
    expect(r.AgentRuntimeArtifact.ContainerConfiguration.ContainerUri).toBeDefined();
  });

  it('HTTP API: all routes at the $default stage with throttling and /register override', () => {
    const routes = Object.values(resourcesOf(s.json, 'AWS::ApiGatewayV2::Route')).map((r) => r.Properties.RouteKey);
    expect(routes.sort()).toEqual([...EXPECTED_ROUTES].sort());
    const stage = one(s.json, 'AWS::ApiGatewayV2::Stage');
    const rl = s.cfg.ingress.rateLimit;
    expect(stage.props.StageName).toBe('$default');
    expect(stage.props.DefaultRouteSettings).toMatchObject({ ThrottlingRateLimit: rl.rps, ThrottlingBurstLimit: rl.burst });
    expect(stage.props.RouteSettings['POST /register']).toEqual({ ThrottlingRateLimit: rl.registerRps, ThrottlingBurstLimit: rl.registerBurst });
    expect(stage.props.AccessLogSettings.DestinationArn).toBeDefined();
    // RouteSettings refers to route keys: the stage must depend on every route.
    const routeIds = Object.keys(resourcesOf(s.json, 'AWS::ApiGatewayV2::Route'));
    const deps = resourcesOf(s.json)[stage.id].DependsOn ?? [];
    for (const id of routeIds) expect(deps).toContain(id);
  });

  it('refresh Lambda + 30-min rule iff redirect IM; ImApp secret iff redirect IM', () => {
    const fns = Object.values(resourcesOf(s.json, 'AWS::Lambda::Function')).map((r) => r.Properties.FunctionName as string);
    expect(fns.some((f) => f.endsWith('-refresh'))).toBe(redirect);
    expect(fns.some((f) => f.endsWith('-oauth'))).toBe(true);
    expect(fns.some((f) => f.endsWith('-middleware'))).toBe(true);
    expect(fns.some((f) => f.endsWith('-alarm'))).toBe(!!s.cfg.alarm.webhookUrlSsmParam);
    const rules = Object.values(resourcesOf(s.json, 'AWS::Events::Rule'));
    expect(rules.length).toBe(redirect ? 1 : 0);
    if (redirect) expect(rules[0].Properties.ScheduleExpression).toBe('rate(30 minutes)');
    const secrets = Object.values(resourcesOf(s.json, 'AWS::SecretsManager::Secret')).map((r) => r.Properties.Name);
    expect(secrets).toContain(`${s.cfg.slug}/root-key`);
    expect(secrets.includes(`${s.cfg.slug}/im-app`)).toBe(redirect);
  });

  it('runtime role writes user secrets iff wecom', () => {
    const roleId = runtimeRoleId();
    const acts = statements(s.json)
      .filter((x) => x.roles.includes(roleId))
      .flatMap((x) => arr(x.st.Action));
    expect(acts.includes('secretsmanager:PutSecretValue')).toBe(s.cfg.im === 'wecom');
    expect(acts.includes('secretsmanager:CreateSecret')).toBe(s.cfg.im === 'wecom');
    expect(acts.includes('ecr:GetAuthorizationToken')).toBe(true);
  });

  it('Lambdas: Node 22 arm64, own role, explicit log group', () => {
    for (const r of Object.values(resourcesOf(s.json, 'AWS::Lambda::Function'))) {
      expect(r.Properties.Runtime).toBe('nodejs22.x');
      expect(r.Properties.Architectures).toEqual(['arm64']);
      expect(r.Properties.LoggingConfig.LogGroup).toBeDefined();
    }
    for (const r of Object.values(resourcesOf(s.json, 'AWS::IAM::Role'))) expect(r.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it('base URL SSM param and outputs', () => {
    const p = one(s.json, 'AWS::SSM::Parameter').props;
    expect(p.Name).toBe(`/im-mcp/${s.cfg.slug}/base-url`);
    const outs = Object.keys(s.json.Outputs);
    for (const o of ['BaseUrl', 'McpUrl', 'RuntimeArn', 'AlarmTopicArn', 'RootKeySecretName', 'UserSecretPrefix', 'TableName']) expect(outs).toContain(o);
    expect(outs.includes('CallbackUrl')).toBe(redirect);
    expect(outs.includes('CustomDomainTarget')).toBe(!!s.cfg.ingress.customDomain);
    if (s.cfg.ingress.customDomain) expect(p.Value).toBe(`https://${s.cfg.ingress.customDomain}`);
  });

  it('WAF stack only with ingress.waf (us-east-1, CLOUDFRONT scope)', () => {
    expect(!!s.waf).toBe(s.cfg.ingress.waf);
    if (s.waf) {
      expect(s.waf.region).toBe('us-east-1');
      const acl = s.app.synth().getStackByName(s.waf.stackName).template.Resources.WebAcl.Properties;
      expect(acl.Scope).toBe('CLOUDFRONT');
      expect(acl.Rules.map((r: any) => r.Name)).toEqual(['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet', 'rate-limit-per-ip']);
      const dist = one(s.json, 'AWS::CloudFront::Distribution').props;
      expect(dist.DistributionConfig.WebACLId).toBeDefined();
    }
  });
});

it('the 8 combos cover every IM in both partitions', () => {
  expect(COMBOS).toHaveLength(8);
});

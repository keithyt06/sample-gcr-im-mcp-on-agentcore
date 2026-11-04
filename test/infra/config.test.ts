// Every §2.3 validation rule (one test each), defaults, derived values.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { CN_BASE_DIGEST, CN_BASE_REPO, GLOBAL_BASE_IMAGE } from '../../shared/versions.js';
import { ConfigError, derive, loadConfig, parseConfig, REPO_ROOT, type Config } from '../../infra/lib/config.js';
import { getInfraAdapter } from '../../infra/lib/adapters/index.js';
import { FIXTURES } from './helpers.js';

const base = (over: Record<string, unknown> = {}) => ({ region: 'ap-northeast-1', im: 'feishu', slug: 'team-a', feishu: { appId: 'cli_a1b2c3d4e5f6a7b8' }, ...over });
const CN = { region: 'cn-northwest-1' };
const CERT_CN = 'arn:aws-cn:acm:cn-northwest-1:111111111111:certificate/12345678-1234-1234-1234-123456789012';
const CERT_AWS = 'arn:aws:acm:ap-northeast-1:111111111111:certificate/12345678-1234-1234-1234-123456789012';
const DIGEST = 'sha256:' + 'a'.repeat(64);

function issues(raw: unknown): string[] {
  try {
    parseConfig(raw);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
}
const expectIssue = (raw: unknown, re: RegExp) => expect(issues(raw).join('\n')).toMatch(re);
const ok = (raw: unknown): Config => {
  expect(issues(raw)).toEqual([]);
  return parseConfig(raw);
};

describe('defaults', () => {
  it('fills every default', () => {
    const c = ok(base());
    expect(c.ingress).toEqual({ edge: 'none', waf: false, rateLimit: { rps: 50, burst: 100, registerRps: 5, registerBurst: 10, authorizeRps: 2, authorizeBurst: 5 } });
    expect(c.runtime).toEqual({ idleTimeoutSec: 600, maxConcurrent: 10 });
    expect(c.build).toEqual({ mirror: 'auto' });
    expect(c.oauth).toEqual({ extraRedirectHosts: [] });
    expect(c.alarm).toEqual({});
    expect(c.imConfig).toEqual({ feishu: { appId: 'cli_a1b2c3d4e5f6a7b8' } });
  });
  it('default scopes: feishu from config/scopes/feishu.json (offline_access at least), dingtalk openid+corpid', () => {
    expect(getInfraAdapter('feishu').scopes(ok(base()))).toContain('offline_access');
    const d = ok(base({ im: 'dingtalk', feishu: undefined, dingtalk: { clientId: 'dingabcdefgh1234' } }));
    expect(getInfraAdapter('dingtalk').scopes(d)).toEqual(['openid', 'corpid']);
    const s = ok(base({ feishu: { appId: 'cli_a1b2c3d4e5f6a7b8', scopes: ['offline_access', 'im:message'] } }));
    expect(getInfraAdapter('feishu').scopes(s)).toEqual(['offline_access', 'im:message']);
  });
  it('the example config and every fixture are valid', () => {
    loadConfig(join(REPO_ROOT, 'config/deploy.example.yaml'));
    for (const f of readdirSync(FIXTURES)) loadConfig(join(FIXTURES, f));
  });
  it('missing file gives a helpful error', () => {
    expect(() => loadConfig('/nonexistent/deploy.yaml')).toThrow(/config file not found.*deploy.example.yaml/);
  });
});

describe('schema basics', () => {
  it('rejects unknown keys (strict)', () => expectIssue(base({ foo: 1 }), /foo|Unrecognized/i));
  it('rejects unknown nested keys', () => expectIssue(base({ ingress: { edgee: 'none' } }), /ingress.*edgee|Unrecognized/i));
  it('rejects a bad slug', () => {
    expectIssue(base({ slug: 'A' }), /slug/);
    expectIssue(base({ slug: 'this-slug-is-way-too-long' }), /slug/);
    expectIssue(base({ slug: 'team-' }), /slug/);
  });
  it('rejects a bad im', () => expectIssue(base({ im: 'slack' }), /^im:/m));
  it('rejects a bad appId', () => expectIssue(base({ feishu: { appId: 'abc' } }), /feishu\.appId/));
  it('rejects a non-digest baseImage', () => expectIssue(base({ build: { baseImage: 'node:22' } }), /build\.baseImage.*digest/));
  it('rejects a bad extraRedirectHosts entry', () => expectIssue(base({ oauth: { extraRedirectHosts: ['https://x.com/'] } }), /oauth\.extraRedirectHosts/));
  it('accepts wildcard extraRedirectHosts', () => {
    expect(ok(base({ oauth: { extraRedirectHosts: ['*.corp.example.com', 'mcp.example.com'] } })).oauth.extraRedirectHosts).toHaveLength(2);
  });
  it('rejects more than 10 extraRedirectHosts', () =>
    expectIssue(base({ oauth: { extraRedirectHosts: Array.from({ length: 11 }, (_, i) => `h${i}.example.com`) } }), /oauth\.extraRedirectHosts/));
  it('rejects a bad webhookUrlSsmParam', () => expectIssue(base({ alarm: { webhookUrlSsmParam: 'no-slash' } }), /alarm\.webhookUrlSsmParam/));
  it('rejects writing imConfig directly', () => expectIssue(base({ imConfig: {} }), /imConfig: not a config key/));
});

describe('§2.3 rule 1: region allowlist', () => {
  it('rejects a region without AgentCore', () => expectIssue(base({ region: 'af-south-1' }), /region: "af-south-1" has no AgentCore Runtime/));
  it('accepts both China regions', () => {
    ok(base({ region: 'cn-north-1' }));
    ok(base(CN));
  });
});

describe('§2.3 rule 2: IM block', () => {
  it('requires the block named by im', () => expectIssue({ ...base(), feishu: undefined, im: 'feishu' }, /feishu: block missing for im=feishu/));
  it('lark uses the lark block, not feishu', () => {
    expectIssue(base({ im: 'lark' }), /lark: block missing/);
    expectIssue(base({ im: 'lark' }), /feishu: block present but im=lark/);
    ok({ ...base({ im: 'lark', lark: { appId: 'cli_b1b2c3d4e5f6a7b8' } }), feishu: undefined });
  });
  it('rejects any other IM block', () => expectIssue(base({ im: 'dingtalk', dingtalk: { clientId: 'dingabcdefgh1234' } }), /feishu: block present but im=dingtalk/));
  it('wecom block: maxPendingQr / requireApproval defaults and validation (H-1, M-3)', () => {
    const { feishu: _f, ...rest } = base({ im: 'wecom' });
    expect(ok({ ...rest, wecom: {} }).imConfig.wecom).toEqual({ maxPendingQr: 20, requireApproval: false });
    expect(ok({ ...rest, wecom: null }).imConfig.wecom).toEqual({ maxPendingQr: 20, requireApproval: false });
    expect(ok({ ...rest, wecom: { maxPendingQr: 5, requireApproval: true } }).imConfig.wecom).toEqual({ maxPendingQr: 5, requireApproval: true });
    expectIssue({ ...rest, wecom: { maxPendingQr: 0 } }, /wecom\.maxPendingQr/);
    expectIssue({ ...rest, wecom: { requireApproval: 'yes' } }, /wecom\.requireApproval/);
  });
  it('wecom needs no block, and accepts an empty one', () => {
    const { feishu: _f, ...rest } = base({ im: 'wecom' });
    ok(rest);
    ok({ ...rest, wecom: {} });
    ok({ ...rest, wecom: null }); // "wecom:" with no value in YAML
  });
});

describe('§2.3 rule 3: secrets never go in config', () => {
  it.each(['appSecret', 'token', 'password', 'passwd', 'apiKey', 'clientSecret', 'ACCESS_TOKEN'])('rejects key %s', (k) => {
    expectIssue(base({ feishu: { appId: 'cli_a1b2c3d4e5f6a7b8', [k]: 'x' } }), /secrets never go in config; use npm run secret:set-im-app/);
  });
  it('checks recursively, including arrays', () => expectIssue(base({ x: [{ deep: { mySecret: 1 } }] }), /x\.0\.deep\.mySecret: secrets never go in config/));
  it('allows webhookUrlSsmParam by name', () => ok(base({ alarm: { webhookUrlSsmParam: '/team-a/alarm-webhook' } })));
});

describe('§2.3 rule 4: no CloudFront in aws-cn', () => {
  it('rejects edge: cloudfront in China', () =>
    expectIssue(base({ ...CN, ingress: { edge: 'cloudfront' } }), /ingress\.edge: cloudfront is not available in AWS China regions/));
  it('accepts edge: cloudfront in aws', () => ok(base({ ingress: { edge: 'cloudfront' } })));
});

describe('§2.3 rule 5: no WAF in aws-cn', () => {
  it('rejects waf: true in China', () =>
    expectIssue(base({ ...CN, ingress: { waf: true } }), /ingress\.waf is not available in AWS China regions \(HTTP API has no WAF\); API Gateway throttling applies/));
});

describe('§2.3 rule 6: waf requires cloudfront', () => {
  it('rejects waf without edge: cloudfront', () => expectIssue(base({ ingress: { waf: true } }), /ingress\.waf requires ingress\.edge: cloudfront/));
  it('accepts waf with cloudfront', () => ok(base({ ingress: { edge: 'cloudfront', waf: true } })));
});

describe('§2.3 rule 7: no customDomain with cloudfront (R9)', () => {
  it('rejects the combination', () =>
    expectIssue(base({ ingress: { edge: 'cloudfront', customDomain: 'mcp.example.com', certificateArn: CERT_AWS } }), /ingress\.customDomain together with ingress\.edge: cloudfront/));
});

describe('§2.3 rule 8: customDomain + certificateArn', () => {
  it('requires both', () => {
    expectIssue(base({ ingress: { customDomain: 'mcp.example.com' } }), /ingress\.customDomain and ingress\.certificateArn must be set together/);
    expectIssue(base({ ingress: { certificateArn: CERT_AWS } }), /must be set together/);
  });
  it('certificate partition must match the region', () =>
    expectIssue(base({ ingress: { customDomain: 'mcp.example.com', certificateArn: CERT_CN } }), /certificateArn: must be in partition aws and region ap-northeast-1/));
  it('certificate region must match', () =>
    expectIssue(base({ region: 'cn-north-1', ingress: { customDomain: 'mcp.example.cn', certificateArn: CERT_CN } }), /must be in partition aws-cn and region cn-north-1/));
  it('accepts a matching pair in both partitions', () => {
    ok(base({ ingress: { customDomain: 'mcp.example.com', certificateArn: CERT_AWS } }));
    ok(base({ ...CN, ingress: { customDomain: 'mcp.example.cn', certificateArn: CERT_CN } }));
  });
  it('rejects a non-ACM ARN and a bad host', () => {
    expectIssue(base({ ingress: { customDomain: 'mcp.example.com', certificateArn: 'arn:aws:iam::111111111111:role/x' } }), /ingress\.certificateArn/);
    expectIssue(base({ ingress: { customDomain: 'MCP_bad', certificateArn: CERT_AWS } }), /ingress\.customDomain/);
  });
});

describe('§2.3 rule 9: rate limits', () => {
  it('burst >= rps', () => expectIssue(base({ ingress: { rateLimit: { rps: 100, burst: 50 } } }), /rateLimit\.burst must be >= ingress\.rateLimit\.rps/));
  it('registerBurst >= registerRps', () => expectIssue(base({ ingress: { rateLimit: { registerRps: 10, registerBurst: 5 } } }), /registerBurst must be >= registerRps/));
  it('registerRps <= rps', () => expectIssue(base({ ingress: { rateLimit: { rps: 5, burst: 100, registerRps: 6, registerBurst: 10 } } }), /registerRps must be <= rps/));
  it('range limits', () => expectIssue(base({ ingress: { rateLimit: { rps: 0 } } }), /ingress\.rateLimit\.rps/));
  it('authorizeBurst >= authorizeRps (H-1)', () => expectIssue(base({ ingress: { rateLimit: { authorizeRps: 4, authorizeBurst: 3 } } }), /authorizeBurst must be >= authorizeRps/));
  it('authorizeRps <= rps (H-1)', () =>
    expectIssue(base({ ingress: { rateLimit: { rps: 3, burst: 100, registerRps: 1, authorizeRps: 4, authorizeBurst: 10 } } }), /authorizeRps must be <= rps/));
});

describe('§2.3 rule 10: cn mirror on a Global region needs build.baseImage', () => {
  it('rejects mirror: cn on aws without baseImage', () => expectIssue(base({ build: { mirror: 'cn' } }), /build\.baseImage is required when build\.mirror is cn/));
  it('accepts it with baseImage', () => ok(base({ build: { mirror: 'cn', baseImage: `registry.example.com/node@${DIGEST}` } })));
  it('China with auto needs nothing', () => ok(base(CN)));
});

describe('derive()', () => {
  const env = { CDK_DEFAULT_ACCOUNT: '111111111111' };
  it('aws partition', () => {
    const d = derive(ok(base()), env);
    expect(d).toMatchObject({
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
      isChina: false,
      awsConsoleHost: 'console.aws.amazon.com',
      agentcoreEndpoint: 'https://bedrock-agentcore.ap-northeast-1.amazonaws.com',
      effectiveMirror: 'global',
      npmRegistry: 'https://registry.npmjs.org',
      baseImage: GLOBAL_BASE_IMAGE,
      cliFamily: 'lark',
      authMode: 'redirect',
      imConsoleCallbackHint: 'https://open.feishu.cn/app/cli_a1b2c3d4e5f6a7b8/safe',
      quickRedirectHosts: ['quicksight.aws.amazon.com', '*.quicksight.aws.amazon.com'],
    });
  });
  it('changing only region switches partition (G3)', () => {
    const d = derive(ok(base(CN)), env);
    expect(d).toMatchObject({
      partition: 'aws-cn',
      urlSuffix: 'amazonaws.com.cn',
      isChina: true,
      awsConsoleHost: 'console.amazonaws.cn',
      agentcoreEndpoint: 'https://bedrock-agentcore.cn-northwest-1.amazonaws.com.cn',
      effectiveMirror: 'cn',
      npmRegistry: 'https://registry.npmmirror.com',
      baseImage: `111111111111.dkr.ecr.cn-northwest-1.amazonaws.com.cn/${CN_BASE_REPO}@${CN_BASE_DIGEST}`,
      quickRedirectHosts: [],
    });
  });
  it('uses the ACCOUNT placeholder without CDK_DEFAULT_ACCOUNT', () => {
    expect(derive(ok(base(CN)), {}).baseImage).toMatch(/^ACCOUNT\.dkr\.ecr\.cn-northwest-1\.amazonaws\.com\.cn\//);
  });
  it('build.baseImage overrides; mirror: global in China uses npmjs + global base', () => {
    const img = `registry.example.com/node@${DIGEST}`;
    expect(derive(ok(base({ build: { mirror: 'cn', baseImage: img } })), env)).toMatchObject({ effectiveMirror: 'cn', npmRegistry: 'https://registry.npmmirror.com', baseImage: img });
    expect(derive(ok(base({ ...CN, build: { mirror: 'global' } })), env)).toMatchObject({ npmRegistry: 'https://registry.npmjs.org', baseImage: GLOBAL_BASE_IMAGE });
  });
  it('per-IM cliFamily, authMode and console hint', () => {
    const lark = derive(ok({ ...base({ im: 'lark', lark: { appId: 'cli_b1b2c3d4e5f6a7b8' } }), feishu: undefined }), env);
    expect(lark).toMatchObject({ cliFamily: 'lark', imConsoleCallbackHint: 'https://open.larksuite.com/app/cli_b1b2c3d4e5f6a7b8/safe' });
    const ding = derive(ok({ ...base({ im: 'dingtalk', dingtalk: { clientId: 'dingabcdefgh1234' } }), feishu: undefined }), env);
    expect(ding).toMatchObject({ cliFamily: 'dingtalk', authMode: 'redirect', imConsoleCallbackHint: 'https://open-dev.dingtalk.com/fe/app' });
    const wc = derive(ok({ ...base({ im: 'wecom' }), feishu: undefined }), env);
    expect(wc).toMatchObject({ cliFamily: 'wecom', authMode: 'qr', imConsoleCallbackHint: undefined });
  });
});

describe('YAML shape (§2.2)', () => {
  it('top-level IM block is lifted into imConfig', () => {
    const c = parseConfig(parseYaml('region: cn-north-1\nim: dingtalk\nslug: team-b\ndingtalk: { clientId: dingabcdefgh1234, scopes: [openid] }\n'));
    expect(c.imConfig.dingtalk).toEqual({ clientId: 'dingabcdefgh1234', scopes: ['openid'] });
  });
  it('a non-mapping document is rejected', () => {
    expect(() => parseConfig(parseYaml('- a\n- b\n'))).toThrow(/YAML mapping/);
  });
});

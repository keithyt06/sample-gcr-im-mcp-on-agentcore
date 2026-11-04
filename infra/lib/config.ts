// Typed deployment config (technical design §2). The config never holds secrets.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Im } from '../../shared/contract.js';
import { CN_BASE_DIGEST, CN_BASE_REPO, GLOBAL_BASE_IMAGE } from '../../shared/versions.js';
import { awsConsoleHost, partitionOf, urlSuffixOf, type Partition } from './partition.js';
import { AGENTCORE_REGIONS, isAgentCoreRegion } from './regions.js';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const host = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const scope = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
const IM_KEYS = ['feishu', 'lark', 'dingtalk', 'wecom'] as const;

const BaseSchema = z
  .object({
    region: z.string(),
    im: z.enum(IM_KEYS),
    slug: z.string().regex(/^[a-z][a-z0-9-]{1,18}[a-z0-9]$/, 'slug: 3-20 chars, lowercase letters, digits and "-", must start with a letter'),
    ingress: z
      .object({
        customDomain: host.optional(),
        certificateArn: z
          .string()
          .regex(/^arn:aws(-cn)?:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]{36}$/, 'ingress.certificateArn: must be an ACM certificate ARN')
          .optional(),
        edge: z.enum(['none', 'cloudfront']).default('none'),
        waf: z.boolean().default(false),
        rateLimit: z
          .object({
            rps: z.number().int().min(1).max(10000).default(50),
            burst: z.number().int().min(1).max(5000).default(100),
            registerRps: z.number().int().min(1).max(100).default(5),
            registerBurst: z.number().int().min(1).max(200).default(10),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    runtime: z
      .object({
        idleTimeoutSec: z.number().int().min(60).max(28800).default(600),
        maxConcurrent: z.number().int().min(1).max(50).default(10),
      })
      .strict()
      .prefault({}),
    build: z
      .object({
        mirror: z.enum(['auto', 'cn', 'global']).default('auto'),
        baseImage: z
          .string()
          .regex(/^[\w.\-/:]+@sha256:[0-9a-f]{64}$/, 'build.baseImage: must be a full image reference pinned by digest (<repo>@sha256:<64 hex>)')
          .optional(),
      })
      .strict()
      .prefault({}),
    oauth: z
      .object({
        extraRedirectHosts: z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+$/)).max(10).default([]),
      })
      .strict()
      .prefault({}),
    alarm: z
      .object({
        webhookUrlSsmParam: z.string().regex(/^\/[A-Za-z0-9_.\-/]{1,1000}$/).optional(),
      })
      .strict()
      .prefault({}),
    imConfig: z
      .object({
        feishu: z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]{8,32}$/), scopes: z.array(scope).max(300).optional() }).strict().optional(),
        lark: z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]{8,32}$/), scopes: z.array(scope).max(300).optional() }).strict().optional(),
        dingtalk: z.object({ clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), scopes: z.array(scope).max(50).optional() }).strict().optional(),
        wecom: z.object({}).strict().optional(),
      })
      .strict(),
  })
  .strict();

export const ConfigSchema = BaseSchema.superRefine((c, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });

  // Rule 1: region allowlist.
  if (!isAgentCoreRegion(c.region)) {
    issue(['region'], `region: "${c.region}" has no AgentCore Runtime. Use one of: ${AGENTCORE_REGIONS.join(', ')}`);
    return; // partition-dependent rules below need a known region
  }
  const partition = partitionOf(c.region);
  const isChina = partition === 'aws-cn';

  // Rule 2: exactly the selected IM block. wecom has no keys, so its block is optional.
  if (c.im !== 'wecom' && !c.imConfig[c.im]) {
    const key = c.im === 'dingtalk' ? 'clientId' : 'appId';
    issue([c.im], `${c.im}: block missing for im=${c.im}; add a top-level "${c.im}: { ${key}: ... }" block`);
  }
  for (const k of IM_KEYS) {
    if (k !== c.im && c.imConfig[k]) issue([k], `${k}: block present but im=${c.im}; remove it or change im`);
  }

  const ing = c.ingress;
  // Rules 4, 5: China has no CloudFront / WAF.
  if (isChina && ing.edge === 'cloudfront') issue(['ingress', 'edge'], 'ingress.edge: cloudfront is not available in AWS China regions; use edge: none');
  if (isChina && ing.waf)
    issue(['ingress', 'waf'], 'ingress.waf is not available in AWS China regions (HTTP API has no WAF); API Gateway throttling applies. Set waf: false');
  // Rule 6.
  if (ing.waf && ing.edge !== 'cloudfront' && !isChina) issue(['ingress', 'waf'], 'ingress.waf requires ingress.edge: cloudfront');
  // Rule 7 (R9).
  if (ing.edge === 'cloudfront' && ing.customDomain)
    issue(['ingress', 'customDomain'], 'ingress.customDomain together with ingress.edge: cloudfront is not supported in v1; use edge: none with a custom domain');
  // Rule 8.
  if (!!ing.customDomain !== !!ing.certificateArn)
    issue(['ingress', ing.customDomain ? 'certificateArn' : 'customDomain'], 'ingress.customDomain and ingress.certificateArn must be set together');
  if (ing.certificateArn) {
    const [, arnPartition, , arnRegion] = ing.certificateArn.split(':');
    if (arnPartition !== partition || arnRegion !== c.region)
      issue(
        ['ingress', 'certificateArn'],
        `ingress.certificateArn: must be in partition ${partition} and region ${c.region} (got ${arnPartition}/${arnRegion}); request the certificate in the stack's region`,
      );
  }
  // Rule 9.
  const rl = ing.rateLimit;
  if (rl.burst < rl.rps) issue(['ingress', 'rateLimit', 'burst'], 'ingress.rateLimit.burst must be >= ingress.rateLimit.rps');
  if (rl.registerBurst < rl.registerRps) issue(['ingress', 'rateLimit', 'registerBurst'], 'ingress.rateLimit.registerBurst must be >= registerRps');
  if (rl.registerRps > rl.rps) issue(['ingress', 'rateLimit', 'registerRps'], 'ingress.rateLimit.registerRps must be <= rps');
  // Rule 10.
  if (effectiveMirrorOf(c.build.mirror, isChina) === 'cn' && !isChina && !c.build.baseImage)
    issue(
      ['build', 'baseImage'],
      'build.baseImage is required when build.mirror is cn for an AWS Global region (the China ECR mirror lives in another partition); set a digest-pinned image reachable from your build host',
    );
});

export type Config = z.output<typeof ConfigSchema>;

const SECRET_KEY = /secret|token|password|passwd|apikey/i;
const SECRET_KEY_ALLOW = new Set(['webhookUrlSsmParam']);

function findSecretKeys(v: unknown, path: string[] = []): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => findSecretKeys(x, [...path, String(i)]));
  if (v === null || typeof v !== 'object') return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => {
    const p = [...path, k];
    return [...(SECRET_KEY.test(k) && !SECRET_KEY_ALLOW.has(k) ? [p.join('.')] : []), ...findSecretKeys(x, p)];
  });
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid config:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Validate a raw (YAML-parsed) object. Top-level feishu/lark/dingtalk/wecom blocks are lifted into imConfig (§2.2). */
export function parseConfig(raw: unknown): Config {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(['config must be a YAML mapping']);
  // Rule 3 (G3): secrets never go in config.
  const secretKeys = findSecretKeys(raw);
  if (secretKeys.length)
    throw new ConfigError(secretKeys.map((k) => `${k}: secrets never go in config; use npm run secret:set-im-app`));

  const obj = { ...(raw as Record<string, unknown>) };
  if ('imConfig' in obj) throw new ConfigError(['imConfig: not a config key; write the IM block at top level (for example "feishu: { appId: ... }")']);
  const imConfig: Record<string, unknown> = {};
  for (const k of IM_KEYS) {
    if (obj[k] !== undefined) imConfig[k] = obj[k] ?? {}; // `wecom:` with no value parses as null
    delete obj[k];
  }
  const r = ConfigSchema.safeParse({ ...obj, imConfig });
  if (!r.success) {
    throw new ConfigError(
      r.error.issues.map((i) => {
        const p = (i.path[0] === 'imConfig' ? i.path.slice(1) : i.path).join('.');
        return i.message.startsWith(`${p}:`) || i.message.startsWith(`${p} `) ? i.message : `${p || '(root)'}: ${i.message}`;
      }),
    );
  }
  return r.data;
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) throw new ConfigError([`config file not found: ${path} (copy config/deploy.example.yaml, or pass -c config=<path>)`]);
  return parseConfig(parseYaml(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------------------------------------
// Derived values (§2.4). Never in config.

export type Mirror = 'cn' | 'global';

export interface Derived {
  partition: Partition;
  urlSuffix: string;
  isChina: boolean;
  awsConsoleHost: string;
  agentcoreEndpoint: string;
  effectiveMirror: Mirror;
  npmRegistry: string;
  baseImage: string;
  cliFamily: 'lark' | 'dingtalk' | 'wecom';
  authMode: 'redirect' | 'qr';
  imConsoleCallbackHint?: string;
  quickRedirectHosts: string[];
}

function effectiveMirrorOf(mirror: 'auto' | 'cn' | 'global', isChina: boolean): Mirror {
  return mirror === 'auto' ? (isChina ? 'cn' : 'global') : mirror;
}

const NPM_REGISTRY: Record<Mirror, string> = {
  cn: 'https://registry.npmmirror.com',
  global: 'https://registry.npmjs.org',
};

export function cliFamilyOf(im: Im): Derived['cliFamily'] {
  return im === 'feishu' || im === 'lark' ? 'lark' : im;
}

export function derive(cfg: Config, env: NodeJS.ProcessEnv = process.env): Derived {
  const partition = partitionOf(cfg.region);
  const urlSuffix = urlSuffixOf(cfg.region);
  const isChina = partition === 'aws-cn';
  const effectiveMirror = effectiveMirrorOf(cfg.build.mirror, isChina);
  const account = env.CDK_DEFAULT_ACCOUNT || 'ACCOUNT'; // placeholder in unit tests; images build only at deploy time
  const baseImage =
    cfg.build.baseImage ??
    (effectiveMirror === 'cn' ? `${account}.dkr.ecr.${cfg.region}.${urlSuffix}/${CN_BASE_REPO}@${CN_BASE_DIGEST}` : GLOBAL_BASE_IMAGE);
  const appId = cfg.imConfig.feishu?.appId ?? cfg.imConfig.lark?.appId;
  const hint: Record<Im, string | undefined> = {
    feishu: appId && `https://open.feishu.cn/app/${appId}/safe`,
    lark: appId && `https://open.larksuite.com/app/${appId}/safe`,
    dingtalk: 'https://open-dev.dingtalk.com/fe/app',
    wecom: undefined,
  };
  return {
    partition,
    urlSuffix,
    isChina,
    awsConsoleHost: awsConsoleHost(cfg.region),
    agentcoreEndpoint: `https://bedrock-agentcore.${cfg.region}.${urlSuffix}`,
    effectiveMirror,
    npmRegistry: NPM_REGISTRY[effectiveMirror],
    baseImage,
    cliFamily: cliFamilyOf(cfg.im),
    authMode: cfg.im === 'wecom' ? 'qr' : 'redirect',
    imConsoleCallbackHint: hint[cfg.im],
    quickRedirectHosts: isChina ? [] : ['quicksight.aws.amazon.com', '*.quicksight.aws.amazon.com'],
  };
}

/** Default Feishu/Lark user scopes: `scopes.user` of config/scopes/feishu.json (generated by gen:catalog, WP-C). */
export function defaultFeishuScopes(): string[] {
  const p = `${REPO_ROOT}config/scopes/feishu.json`;
  if (!existsSync(p)) return ['offline_access'];
  const j = JSON.parse(readFileSync(p, 'utf8')) as { scopes?: { user?: string[] } };
  return j.scopes?.user?.length ? j.scopes.user : ['offline_access'];
}

export const DEFAULT_DINGTALK_SCOPES = ['openid', 'corpid'];

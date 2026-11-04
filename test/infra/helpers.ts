import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig, REPO_ROOT, type Config } from '../../infra/lib/config.js';
import { addImMcpStacks, type ImMcpStack } from '../../infra/lib/stack.js';
import type { ImMcpWafStack } from '../../infra/lib/waf-stack.js';

/** Fixture account only; never a real account id. */
export const TEST_ACCOUNT = '111111111111';
export const FIXTURES = join(REPO_ROOT, 'test/fixtures/configs');
export const IMS = ['feishu', 'lark', 'dingtalk', 'wecom'] as const;
export const PARTITIONS = ['aws', 'cn'] as const;

const cdkContext = (JSON.parse(readFileSync(join(REPO_ROOT, 'cdk.json'), 'utf8')) as { context: Record<string, unknown> }).context;

export function fixture(name: string): Config {
  return loadConfig(join(FIXTURES, `${name}.yaml`));
}

export interface Synth {
  cfg: Config;
  app: App;
  main: ImMcpStack;
  waf?: ImMcpWafStack;
  template: Template;
  json: Record<string, any>;
}

/** Synthesize a fixture exactly like `cdk synth` does (same cdk.json context), with no AWS credentials. */
/** `bundle: false` skips Lambda esbuild bundling (IAM/nag tests); the matrix test always bundles. */
export function synthFixture(name: string, opts: { nag?: boolean; bundle?: boolean } = {}): Synth {
  const cfg = fixture(name);
  const context = { ...cdkContext, ...(opts.bundle === false ? { 'aws:cdk:bundling-stacks': [] } : {}) };
  // Unique outdir: test files run in parallel workers.
  // Unique dir under the gitignored cdk.out/: test files run in parallel workers.
  mkdirSync(join(REPO_ROOT, 'cdk.out/test'), { recursive: true });
  const outdir = mkdtempSync(join(REPO_ROOT, 'cdk.out/test', `${name}-`));
  const app = new App({ context, outdir });
  const { main, waf } = addImMcpStacks(app, cfg, TEST_ACCOUNT);
  if (opts.nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  app.synth();
  const template = Template.fromStack(main);
  return { cfg, app, main, waf, template, json: template.toJSON() };
}

export type Resources = Record<string, { Type: string; Properties?: any; DependsOn?: string[] }>;

export function resourcesOf(json: Record<string, any>, type?: string): Resources {
  const all = json.Resources as Resources;
  return type ? Object.fromEntries(Object.entries(all).filter(([, r]) => r.Type === type)) : all;
}

export function one<T = any>(json: Record<string, any>, type: string): { id: string; props: T } {
  const r = Object.entries(resourcesOf(json, type));
  if (r.length !== 1) throw new Error(`expected exactly one ${type}, got ${r.length}`);
  return { id: r[0][0], props: r[0][1].Properties as T };
}

export interface PolicyStatement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
}
export const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

/** Every IAM statement in the template, with the logical id of the role(s) it is attached to. */
export function statements(json: Record<string, any>): { roles: string[]; st: PolicyStatement }[] {
  const out: { roles: string[]; st: PolicyStatement }[] = [];
  for (const [id, r] of Object.entries(resourcesOf(json))) {
    if (r.Type === 'AWS::IAM::Policy') {
      const roles = arr(r.Properties.Roles).map((x: any) => x.Ref as string);
      for (const st of r.Properties.PolicyDocument.Statement) out.push({ roles, st });
    } else if (r.Type === 'AWS::IAM::Role') {
      for (const p of arr(r.Properties.Policies) as any[]) for (const st of p.PolicyDocument.Statement) out.push({ roles: [id], st });
    }
  }
  return out;
}

/** Collect every `{Ref: X}` / `{Fn::GetAtt: [X, ...]}` logical id referenced inside a value. */
export function referencedIds(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => referencedIds(x, acc));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'Ref' && typeof x === 'string') acc.add(x);
      else if (k === 'Fn::GetAtt' && Array.isArray(x)) acc.add(String(x[0]));
      else if (k === 'Fn::Sub' && typeof x === 'string') for (const m of x.matchAll(/\$\{([A-Za-z0-9]+)(\.[^}]*)?\}/g)) acc.add(m[1]);
      referencedIds(x, acc);
    }
  }
  return acc;
}

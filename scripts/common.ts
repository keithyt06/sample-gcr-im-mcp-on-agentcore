// Shared helpers for the operator scripts (not deployed).
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { loadConfig, type Config } from '../infra/lib/config.js';
import { namesFor } from '../infra/lib/names.js';

export interface Args {
  flags: Record<string, string | true>;
  positional: string[];
}

/** `--key value`, `--key=value`, `--flag`, and CDK-style `-c config=<path>`. */
export function parseArgs(argv = process.argv.slice(2)): Args {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' && argv[i + 1]?.includes('=')) {
      const [k, v] = argv[++i].split(/=(.*)/s);
      flags[k] = v;
    } else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

export function str(args: Args, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function loadArgsConfig(args: Args): Config {
  return loadConfig(str(args, 'config') ?? 'config/deploy.yaml');
}

export interface Target {
  stack: string;
  region: string;
}

/** Stack + region from `--stack/--region`, else from the config file (`-c config=` / `--config`, default config/deploy.yaml). */
export function resolveTarget(args: Args): Target {
  const stack = str(args, 'stack');
  const region = str(args, 'region') ?? process.env.AWS_REGION;
  if (stack && region) return { stack, region };
  const cfg = loadArgsConfig(args);
  return { stack: stack ?? namesFor(cfg.slug, cfg.region).stack, region: region ?? cfg.region };
}

export async function stackOutputs(t: Target): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({ region: t.region });
  const r = await cfn.send(new DescribeStacksCommand({ StackName: t.stack }));
  const outs = r.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outs.map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
}

export function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** True when this module is the process entry point (so scripts can also be imported by tests / other scripts). */
export function isMain(importMetaUrl: string): boolean {
  return !!process.argv[1] && importMetaUrl === new URL(`file://${process.argv[1]}`).href;
}

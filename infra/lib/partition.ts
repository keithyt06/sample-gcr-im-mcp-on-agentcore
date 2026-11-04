// Partition facts derived ONLY from the region (D2). Never hardcode them elsewhere.
import { RegionInfo } from 'aws-cdk-lib/region-info';

export type Partition = 'aws' | 'aws-cn';

function info(region: string): RegionInfo {
  const ri = RegionInfo.get(region);
  if (!ri.partition || !ri.domainSuffix) throw new Error(`Unknown region "${region}" (RegionInfo has no partition data)`);
  return ri;
}

export function partitionOf(region: string): Partition {
  const p = info(region).partition;
  if (p !== 'aws' && p !== 'aws-cn') throw new Error(`Unsupported partition "${p}" for region ${region}`);
  return p;
}

/** DNS suffix: `amazonaws.com` (aws) or `amazonaws.com.cn` (aws-cn). */
export function urlSuffixOf(region: string): string {
  return info(region).domainSuffix!;
}

const CONSOLE_HOST: Record<Partition, string> = {
  aws: 'console.aws.amazon.com',
  'aws-cn': 'console.amazonaws.cn',
};

export function awsConsoleHost(region: string): string {
  return CONSOLE_HOST[partitionOf(region)];
}

/**
 * `arn:<partition>:<service>:<region>:<account>:<resource>` for the stack's own region/account.
 * The partition is a literal derived from the region (never `arn:aws` hardcoded).
 */
export function stackArn(stack: { region: string; account: string }, service: string, resource: string): string {
  return `arn:${partitionOf(stack.region)}:${service}:${stack.region}:${stack.account}:${resource}`;
}

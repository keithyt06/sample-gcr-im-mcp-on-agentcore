import { describe, expect, it } from 'vitest';
import { awsConsoleHost, partitionOf, stackArn, urlSuffixOf } from '../../infra/lib/partition.js';
import { AGENTCORE_REGIONS } from '../../infra/lib/regions.js';

describe('partition helpers (RegionInfo based)', () => {
  it.each([
    ['ap-northeast-1', 'aws', 'amazonaws.com', 'console.aws.amazon.com'],
    ['us-west-2', 'aws', 'amazonaws.com', 'console.aws.amazon.com'],
    ['cn-north-1', 'aws-cn', 'amazonaws.com.cn', 'console.amazonaws.cn'],
    ['cn-northwest-1', 'aws-cn', 'amazonaws.com.cn', 'console.amazonaws.cn'],
  ])('%s -> %s / %s / %s', (region, partition, suffix, consoleHost) => {
    expect(partitionOf(region)).toBe(partition);
    expect(urlSuffixOf(region)).toBe(suffix);
    expect(awsConsoleHost(region)).toBe(consoleHost);
  });

  it('every allowlisted region resolves to aws or aws-cn', () => {
    for (const r of AGENTCORE_REGIONS) expect(['aws', 'aws-cn']).toContain(partitionOf(r));
    expect(AGENTCORE_REGIONS).toHaveLength(23);
  });

  it('unknown region throws', () => {
    expect(() => partitionOf('xx-nowhere-9')).toThrow(/Unknown region/);
  });

  it('stackArn uses the derived partition literal', () => {
    expect(stackArn({ region: 'cn-northwest-1', account: '111111111111' }, 'ssm', 'parameter/x')).toBe(
      'arn:aws-cn:ssm:cn-northwest-1:111111111111:parameter/x',
    );
    expect(stackArn({ region: 'us-west-2', account: '111111111111' }, 'logs', 'log-group:/a')).toBe('arn:aws:logs:us-west-2:111111111111:log-group:/a');
  });
});

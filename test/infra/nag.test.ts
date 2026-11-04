// cdk-nag AwsSolutions must report no unacknowledged findings (technical design §7.2).
import { describe, expect, it } from 'vitest';
import { IMS, PARTITIONS, synthFixture } from './helpers.js';

const NAMES = [...IMS.flatMap((im) => PARTITIONS.map((p) => `${im}-${p}`)), 'feishu-aws-edge', 'dingtalk-cn-domain'];

describe.each(NAMES)('cdk-nag AwsSolutions: %s', (name) => {
  it('synthesizes with no unacknowledged findings', () => {
    // app.synth() throws "Validation failed" with the report if any finding is not acknowledged.
    expect(() => synthFixture(name, { nag: true, bundle: false })).not.toThrow();
  });
});

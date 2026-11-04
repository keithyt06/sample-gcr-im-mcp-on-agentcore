// Regions where Amazon Bedrock AgentCore Runtime is available (product spec §5.2, listed 2026-11-04).
// Source of truth, re-check at each release:
//   https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html
//   https://docs.amazonaws.cn/en_us/aws/latest/userguide/bedrock-agentcore.html
export const AGENTCORE_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-south-1',
  'eu-south-2',
  'eu-north-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-5',
  'ap-southeast-7',
  'cn-north-1',
  'cn-northwest-1',
] as const;

export type AgentCoreRegion = (typeof AGENTCORE_REGIONS)[number];

export function isAgentCoreRegion(region: string): region is AgentCoreRegion {
  return (AGENTCORE_REGIONS as readonly string[]).includes(region);
}

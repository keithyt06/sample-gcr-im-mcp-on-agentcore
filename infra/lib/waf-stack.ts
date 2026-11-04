import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { Names } from './names.js';

export interface ImMcpWafStackProps extends StackProps {
  names: Names;
}

/** CLOUDFRONT-scope web ACL; must live in us-east-1 (aws partition only, §3.3). */
export class ImMcpWafStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: ImMcpWafStackProps) {
    super(scope, id, props);
    const vis = (metricName: string) => ({ cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true });
    const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: vis(name),
    });

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: props.names.wafAcl,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: vis(props.names.wafAcl),
      rules: [
        managed('AWSManagedRulesCommonRuleSet', 1),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
        {
          name: 'rate-limit-per-ip',
          priority: 3,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 1000, evaluationWindowSec: 300, aggregateKeyType: 'IP' } },
          visibilityConfig: vis('rate-limit-per-ip'),
        },
      ],
    });
    this.webAclArn = acl.attrArn;
    new CfnOutput(this, 'WebAclArn', { value: acl.attrArn });
  }
}

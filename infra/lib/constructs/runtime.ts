import { Stack } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { RUNTIME_HEADERS } from '../../../shared/contract.js';
import type { InfraAdapter } from '../adapters/index.js';
import type { Config } from '../config.js';
import type { Names } from '../names.js';
import { stackArn } from '../partition.js';
import type { Image } from './image.js';

/** The service principal is the same in both partitions (D2). */
export const AGENTCORE_PRINCIPAL = 'bedrock-agentcore.amazonaws.com';

/** Tag the wecom container puts on a user secret (read back by lambda/oauth/qr.ts). */
export const WECOM_USER_TAG = 'WecomUserId';

export interface RuntimeProps {
  cfg: Config;
  names: Names;
  adapter: InfraAdapter;
  image: Image;
  cmk: kms.IKey;
  imApp?: secretsmanager.ISecret;
}

export class Runtime extends Construct {
  readonly role: iam.Role;
  readonly runtime: agentcore.CfnRuntime;
  readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: RuntimeProps) {
    super(scope, id);
    const { cfg, names, adapter, image, cmk, imApp } = props;
    const stack = Stack.of(this);

    this.role = new iam.Role(this, 'RuntimeRole', {
      description: `AgentCore Runtime execution role (${names.runtime})`,
      assumedBy: new iam.ServicePrincipal(AGENTCORE_PRINCIPAL, {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': stackArn(stack, 'bedrock-agentcore', '*') },
        },
      }),
    });

    // ECR pull of the asset repo; GetAuthorizationToken on "*" (no resource-level permissions).
    image.asset.repository.grantPull(this.role);

    const logGroupArn = stackArn(stack, 'logs', 'log-group:/aws/bedrock-agentcore/runtimes/*');
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [logGroupArn, `${logGroupArn}:log-stream:*`],
      }),
    );

    if (imApp && adapter.cliFamily === 'lark') {
      this.role.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [imApp.secretArn] }));
    }
    if (adapter.runtimeWritesUserSecrets) {
      // Known limitation (review M-8): one execution role serves every user's microVM and AgentCore passes no
      // per-session tags, so access cannot be scoped to one user's secret. We narrow what we can:
      // read/write only under <slug>/users/*, create only with this stack's CMK, tag only with WecomUserId,
      // and no DescribeSecret (the container never calls it).
      const users = userSecretsArn(stack, names);
      this.role.addToPolicy(
        new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'], resources: [users] }),
      );
      this.role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:CreateSecret'],
          resources: [users],
          conditions: { StringEquals: { 'secretsmanager:KmsKeyArn': cmk.keyArn } },
        }),
      );
      this.role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:TagResource'],
          resources: [users],
          conditions: { 'ForAllValues:StringEquals': { 'aws:TagKeys': [WECOM_USER_TAG] }, Null: { 'aws:TagKeys': 'false' } },
        }),
      );
      this.role.addToPolicy(
        new iam.PolicyStatement({ actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], resources: [cmk.keyArn] }),
      );
    }

    const env: Record<string, string> = {
      IM: cfg.im,
      SLUG: cfg.slug,
      METRIC_NAMESPACE: names.metricNamespace,
      MAX_CONCURRENT: String(cfg.runtime.maxConcurrent),
      AWS_REGION: cfg.region,
      ...adapter.runtimeEnv(cfg, { appSecretName: imApp ? names.imAppSecret : undefined, cmkArn: cmk.keyArn }),
    };

    this.runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: names.runtime,
      description: `IM MCP server (${cfg.im})`,
      roleArn: this.role.roleArn,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image.asset.imageUri } },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'MCP',
      lifecycleConfiguration: { idleRuntimeSessionTimeout: cfg.runtime.idleTimeoutSec },
      requestHeaderConfiguration: { requestHeaderAllowlist: [...RUNTIME_HEADERS] },
      environmentVariables: env,
      tags: { project: 'gcr-im-mcp-on-agentcore', slug: cfg.slug },
    });
    // The inline policy must exist before the service validates the image pull.
    this.runtime.node.addDependency(this.role);
    this.runtimeArn = this.runtime.attrAgentRuntimeArn;
  }
}

/** `arn:<p>:secretsmanager:<r>:<a>:secret:<slug>/users/*` */
export function userSecretsArn(stack: Stack, names: Names): string {
  return stackArn(stack, 'secretsmanager', `secret:${names.userSecretPrefix}/*`);
}

import { Duration, Stack } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { ENV } from '../../../shared/contract.js';
import { ImFunction } from './functions.js';
import type { LambdaCommonProps } from './oauth.js';
import { userSecretsArn } from './runtime.js';

/** IM token refresh every 30 minutes (redirect IMs only, §6.3, R14). */
export class RefreshFunction extends Construct {
  readonly f: ImFunction;

  constructor(scope: Construct, id: string, props: Omit<LambdaCommonProps, 'runtimeArn' | 'd'>) {
    super(scope, id);
    const { cfg, names, adapter, storage } = props;
    const stack = Stack.of(this);

    this.f = new ImFunction(this, 'Refresh', {
      name: 'refresh',
      names,
      environment: {
        [ENV.IM]: cfg.im,
        [ENV.USER_SECRET_PREFIX]: names.userSecretPrefix,
        [ENV.USER_SECRET_KMS_KEY_ARN]: storage.userSecretKey.keyArn,
        [ENV.IM_APP_ID]: adapter.appId(cfg) ?? '',
        [ENV.IM_APP_SECRET_ID]: names.imAppSecret,
        [ENV.METRIC_NAMESPACE]: names.metricNamespace,
      },
    });

    // ListSecrets has no resource-level permissions; the code filters by name prefix.
    this.f.allow(['secretsmanager:ListSecrets'], ['*']);
    this.f.allow(
      ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:DeleteSecret'],
      [userSecretsArn(stack, names)],
    );
    if (storage.imApp) this.f.allow(['secretsmanager:GetSecretValue'], [storage.imApp.secretArn]);
    this.f.allow(['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], [storage.userSecretKey.keyArn]);

    new events.Rule(this, 'Schedule', {
      description: `Refresh IM user tokens (${cfg.slug})`,
      schedule: events.Schedule.rate(Duration.minutes(30)),
      targets: [new targets.LambdaFunction(this.f.fn, { retryAttempts: 0 })],
    });
  }
}

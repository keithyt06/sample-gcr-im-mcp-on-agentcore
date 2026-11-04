import { Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { ENV, type MetricName } from '../../../shared/contract.js';
import type { InfraAdapter } from '../adapters/index.js';
import type { Config } from '../config.js';
import type { Names } from '../names.js';
import { stackArn } from '../partition.js';
import { ImFunction } from './functions.js';

export interface AlarmsProps {
  cfg: Config;
  names: Names;
  adapter: InfraAdapter;
  httpApiId: string;
  fns: { oauth: lambda.IFunction; middleware: lambda.IFunction; refresh?: lambda.IFunction };
}

/** SNS topic + alarms (§6.4), optional webhook Lambda. */
export class Alarms extends Construct {
  readonly topic: sns.Topic;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: AlarmsProps) {
    super(scope, id);
    const { cfg, names, adapter, fns } = props;
    const stack = Stack.of(this);

    // Unencrypted on purpose: CloudWatch cannot publish to an aws/sns-encrypted topic (nag acknowledged).
    this.topic = new sns.Topic(this, 'Topic', { topicName: names.alarmTopic, enforceSSL: true });
    const action = new cwActions.SnsAction(this.topic);

    const add = (name: string, metric: cloudwatch.IMetric, threshold: number, desc: string) => {
      const a = new cloudwatch.Alarm(this, name, {
        alarmName: names.alarm(name),
        alarmDescription: desc,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(action);
      a.addOkAction(action);
      this.alarms.push(a);
    };
    const emf = (m: MetricName, period: Duration) =>
      new cloudwatch.Metric({ namespace: names.metricNamespace, metricName: m, statistic: 'Sum', period });
    const fiveMin = Duration.minutes(5);

    if (adapter.authMode === 'redirect') {
      add('token-lost', emf('TokenLost', fiveMin), 1, 'A refreshed IM token could not be stored; the user must re-authorize');
      add('refresh-failed', emf('RefreshFailed', Duration.minutes(30)), 3, 'IM token refresh failures');
    } else {
      add('grant-expired', emf('ImGrantExpired', fiveMin), 1, 'WeCom smart-bot grant expired (850003); users must renew it in the WeCom client');
    }
    add('oauth-errors', fns.oauth.metricErrors({ period: fiveMin, statistic: 'Sum' }), 1, 'OAuth Lambda errors');
    add('middleware-errors', fns.middleware.metricErrors({ period: fiveMin, statistic: 'Sum' }), 1, 'Middleware Lambda errors');
    if (fns.refresh) add('refresh-errors', fns.refresh.metricErrors({ period: fiveMin, statistic: 'Sum' }), 1, 'Refresh Lambda errors');
    add(
      'api-5xx',
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: { ApiId: props.httpApiId, Stage: '$default' },
        statistic: 'Sum',
        period: fiveMin,
      }),
      5,
      'HTTP API 5xx responses',
    );

    if (cfg.alarm.webhookUrlSsmParam) {
      const f = new ImFunction(this, 'Alarm', {
        name: 'alarm',
        names,
        environment: { [ENV.WEBHOOK_URL_PARAM]: cfg.alarm.webhookUrlSsmParam, [ENV.IM]: cfg.im, [ENV.SLUG]: cfg.slug },
      });
      f.allow(['ssm:GetParameter'], [stackArn(stack, 'ssm', `parameter${cfg.alarm.webhookUrlSsmParam}`)]);
      this.topic.addSubscription(new subs.LambdaSubscription(f.fn));
    }
  }
}

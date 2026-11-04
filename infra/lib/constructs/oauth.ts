import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ENV } from '../../../shared/contract.js';
import type { InfraAdapter } from '../adapters/index.js';
import type { Config, Derived } from '../config.js';
import type { Names } from '../names.js';
import { stackArn } from '../partition.js';
import { ImFunction } from './functions.js';
import { userSecretsArn } from './runtime.js';
import type { Storage } from './storage.js';

export interface LambdaCommonProps {
  cfg: Config;
  d: Derived;
  names: Names;
  adapter: InfraAdapter;
  storage: Storage;
  runtimeArn: string;
}

/** `arn:<p>:ssm:<r>:<a>:parameter/im-mcp/<slug>/base-url`, built from the literal name (no dependency on the API, D7). */
export function baseUrlParamArn(stack: Stack, names: Names): string {
  return stackArn(stack, 'ssm', `parameter${names.baseUrlParam}`);
}

/** OAuth 2.1 Authorization Server Lambda (§4.4, §6.2). */
export class OauthFunction extends Construct {
  readonly f: ImFunction;

  constructor(scope: Construct, id: string, props: LambdaCommonProps) {
    super(scope, id);
    const { cfg, d, names, adapter, storage, runtimeArn } = props;
    const stack = Stack.of(this);
    const redirect = adapter.authMode === 'redirect';
    const appId = adapter.appId(cfg);

    const environment: Record<string, string> = {
      [ENV.IM]: cfg.im,
      [ENV.SLUG]: cfg.slug,
      [ENV.BASE_URL_PARAM]: names.baseUrlParam,
      [ENV.ROOT_KEY_SECRET_ID]: names.rootKeySecret,
      [ENV.TABLE_NAME]: storage.table.tableName,
      [ENV.USER_SECRET_PREFIX]: names.userSecretPrefix,
      [ENV.USER_SECRET_KMS_KEY_ARN]: storage.userSecretKey.keyArn,
      [ENV.EXTRA_REDIRECT_HOSTS]: cfg.oauth.extraRedirectHosts.join(','),
      [ENV.QUICK_REDIRECT_HOSTS]: d.quickRedirectHosts.join(','),
      [ENV.METRIC_NAMESPACE]: names.metricNamespace,
    };
    if (redirect) {
      environment[ENV.IM_APP_ID] = appId ?? '';
      environment[ENV.IM_APP_SECRET_ID] = names.imAppSecret;
      environment[ENV.IM_SCOPES] = adapter.scopes(cfg).join(',');
    } else {
      environment[ENV.RUNTIME_ARN] = runtimeArn;
      environment[ENV.AGENTCORE_ENDPOINT] = d.agentcoreEndpoint;
    }

    this.f = new ImFunction(this, 'Oauth', { name: 'oauth', names, environment });
    const users = userSecretsArn(stack, names);

    this.f.allow(['secretsmanager:GetSecretValue'], [storage.rootKey.secretArn, ...(storage.imApp ? [storage.imApp.secretArn] : [])]);
    if (redirect) {
      this.f.allow(
        [
          'secretsmanager:GetSecretValue',
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:RestoreSecret',
          'secretsmanager:DescribeSecret',
          'secretsmanager:TagResource',
        ],
        [users],
      );
      this.f.allow(['kms:Encrypt', 'kms:GenerateDataKey', 'kms:Decrypt', 'kms:DescribeKey'], [storage.userSecretKey.keyArn]);
    } else {
      this.f.allow(['secretsmanager:DescribeSecret', 'secretsmanager:DeleteSecret'], [users]);
      this.f.allow(['bedrock-agentcore:InvokeAgentRuntime'], [runtimeArn, `${runtimeArn}/*`]);
    }
    this.f.allow(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'], [storage.table.tableArn]);
    this.f.allow(['ssm:GetParameter'], [baseUrlParamArn(stack, names)]);
  }
}

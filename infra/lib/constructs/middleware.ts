import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ENV } from '../../../shared/contract.js';
import { ImFunction } from './functions.js';
import { baseUrlParamArn, type LambdaCommonProps } from './oauth.js';
import { userSecretsArn } from './runtime.js';

/** MCP proxy Lambda: verifies the MCP token, loads the IM credential, SigV4 → InvokeAgentRuntime (§4.5, §6.2). */
export class MiddlewareFunction extends Construct {
  readonly f: ImFunction;

  constructor(scope: Construct, id: string, props: LambdaCommonProps) {
    super(scope, id);
    const { cfg, d, names, adapter, storage, runtimeArn } = props;
    const stack = Stack.of(this);
    const redirect = adapter.authMode === 'redirect';

    this.f = new ImFunction(this, 'Middleware', {
      name: 'middleware',
      names,
      environment: {
        [ENV.IM]: cfg.im,
        [ENV.SLUG]: cfg.slug,
        [ENV.BASE_URL_PARAM]: names.baseUrlParam,
        [ENV.ROOT_KEY_SECRET_ID]: names.rootKeySecret,
        [ENV.USER_SECRET_PREFIX]: names.userSecretPrefix,
        [ENV.RUNTIME_ARN]: runtimeArn,
        [ENV.AGENTCORE_ENDPOINT]: d.agentcoreEndpoint,
        [ENV.NEEDS_USER_TOKEN]: String(redirect),
        [ENV.METRIC_NAMESPACE]: names.metricNamespace,
      },
    });

    this.f.allow(['secretsmanager:GetSecretValue'], [storage.rootKey.secretArn, ...(redirect ? [userSecretsArn(stack, names)] : [])]);
    if (redirect) this.f.allow(['kms:Decrypt'], [storage.userSecretKey.keyArn]);
    this.f.allow(['bedrock-agentcore:InvokeAgentRuntime'], [runtimeArn, `${runtimeArn}/*`]);
    this.f.allow(['ssm:GetParameter'], [baseUrlParamArn(stack, names)]);
  }
}

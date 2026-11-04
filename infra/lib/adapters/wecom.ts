import { ENV } from '../../../shared/contract.js';
import type { InfraAdapter } from './types.js';

export const wecomAdapter: InfraAdapter = {
  im: 'wecom',
  authMode: 'qr',
  cliFamily: 'wecom',
  needsAppSecret: false,
  runtimeWritesUserSecrets: true,
  needsRefresh: false,
  appId: () => undefined,
  scopes: () => [],
  runtimeEnv: (cfg, ctx) => ({
    [ENV.USER_SECRET_PREFIX]: `${cfg.slug}/users`,
    [ENV.USER_SECRET_KMS_KEY_ARN]: ctx.cmkArn,
  }),
  imConsoleCallbackHint: () => undefined,
};

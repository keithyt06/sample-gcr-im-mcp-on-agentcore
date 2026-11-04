// Adapter factory: picks the container adapter for IM from the Runtime env (technical design §3.5).
import type { Im } from '../../../shared/contract';
import { ENV } from '../../../shared/contract';
import { createSecrets, type SecretsApi } from '../secrets';
import { createDingtalkAdapter } from './dingtalk';
import { createFeishuAdapter } from './feishu';
import type { ContainerAdapter } from './types';
import { createWecomAdapter } from './wecom';

export interface AdapterDeps {
  secrets?: SecretsApi;
  env?: NodeJS.ProcessEnv;
  /** dingtalk, tests only. */
  dwsExtraEnv?: Record<string, string>;
  /** wecom, tests only. */
  wecomUrlWaitMs?: number;
}

export function getContainerAdapter(im: Im, deps: AdapterDeps = {}): ContainerAdapter {
  const env = deps.env ?? process.env;
  const secrets = deps.secrets ?? createSecrets({ region: env[ENV.AWS_REGION], kmsKeyId: env[ENV.USER_SECRET_KMS_KEY_ARN] || undefined });
  switch (im) {
    case 'feishu':
    case 'lark':
      return createFeishuAdapter(im, { secrets, appId: env[ENV.IM_APP_ID], appSecretId: env[ENV.IM_APP_SECRET_ID] });
    case 'dingtalk':
      return createDingtalkAdapter({ agentCode: env[ENV.DINGTALK_DWS_AGENTCODE], extraEnv: deps.dwsExtraEnv });
    case 'wecom':
      return createWecomAdapter({ secrets, userSecretPrefix: env[ENV.USER_SECRET_PREFIX] || 'users', urlWaitMs: deps.wecomUrlWaitMs });
    default:
      throw new Error(`unsupported IM ${String(im)}`);
  }
}

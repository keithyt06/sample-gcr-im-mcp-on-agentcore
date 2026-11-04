import { ENV } from '../../../shared/contract.js';
import { DEFAULT_DINGTALK_SCOPES } from '../config.js';
import type { InfraAdapter } from './types.js';

export const DWS_AGENTCODE = 'gcr-im-mcp-on-agentcore';

export const dingtalkAdapter: InfraAdapter = {
  im: 'dingtalk',
  authMode: 'redirect',
  cliFamily: 'dingtalk',
  needsAppSecret: true,
  runtimeWritesUserSecrets: false,
  needsRefresh: true,
  appId: (cfg) => cfg.imConfig.dingtalk?.clientId,
  scopes: (cfg) => cfg.imConfig.dingtalk?.scopes ?? DEFAULT_DINGTALK_SCOPES,
  runtimeEnv: () => ({ [ENV.DINGTALK_DWS_AGENTCODE]: DWS_AGENTCODE }),
  imConsoleCallbackHint: () => 'https://open-dev.dingtalk.com/fe/app',
};

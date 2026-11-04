import { ENV } from '../../../shared/contract.js';
import { defaultFeishuScopes, type Config } from '../config.js';
import type { InfraAdapter } from './types.js';

const CONSOLE: Record<'feishu' | 'lark', string> = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' };

/** feishu and lark share one adapter; `brand` selects the console host and the config block. */
export function feishuAdapter(brand: 'feishu' | 'lark'): InfraAdapter {
  const block = (cfg: Config) => cfg.imConfig[brand];
  return {
    im: brand,
    authMode: 'redirect',
    cliFamily: 'lark',
    needsAppSecret: true,
    runtimeWritesUserSecrets: false,
    needsRefresh: true,
    appId: (cfg) => block(cfg)?.appId,
    scopes: (cfg) => block(cfg)?.scopes ?? defaultFeishuScopes(),
    runtimeEnv: (cfg, ctx) => ({
      [ENV.IM_APP_ID]: block(cfg)?.appId ?? '',
      [ENV.IM_APP_SECRET_ID]: ctx.appSecretName ?? '',
    }),
    imConsoleCallbackHint: (cfg) => {
      const id = block(cfg)?.appId;
      return id ? `${CONSOLE[brand]}/app/${id}/safe` : undefined;
    },
  };
}

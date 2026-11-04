import type { Im } from '../../../shared/contract.js';
import type { Config } from '../config.js';

export interface InfraAdapter {
  im: Im;
  authMode: 'redirect' | 'qr';
  cliFamily: 'lark' | 'dingtalk' | 'wecom';
  /** feishu, lark, dingtalk */
  needsAppSecret: boolean;
  /** appId / clientId */
  appId(cfg: Config): string | undefined;
  scopes(cfg: Config): string[];
  runtimeEnv(cfg: Config, ctx: { appSecretName?: string; cmkArn: string }): Record<string, string>;
  /** wecom */
  runtimeWritesUserSecrets: boolean;
  /** redirect IMs */
  needsRefresh: boolean;
  imConsoleCallbackHint(cfg: Config): string | undefined;
}

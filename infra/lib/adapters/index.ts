import type { Im } from '../../../shared/contract.js';
import { dingtalkAdapter } from './dingtalk.js';
import { feishuAdapter } from './feishu.js';
import type { InfraAdapter } from './types.js';
import { wecomAdapter } from './wecom.js';

export type { InfraAdapter } from './types.js';

export function getInfraAdapter(im: Im): InfraAdapter {
  switch (im) {
    case 'feishu':
    case 'lark':
      return feishuAdapter(im);
    case 'dingtalk':
      return dingtalkAdapter;
    case 'wecom':
      return wecomAdapter;
  }
}

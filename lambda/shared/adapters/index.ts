import type { Im } from '../../../shared/contract';
import { createDingtalkAdapter } from './dingtalk';
import { createFeishuAdapter } from './feishu';
import type { AdapterDeps, LambdaAdapter } from './types';
import { createWecomAdapter } from './wecom';

export * from './types';

export function getLambdaAdapter(im: Im, deps?: AdapterDeps): LambdaAdapter {
  switch (im) {
    case 'feishu':
    case 'lark':
      return createFeishuAdapter(im, deps);
    case 'dingtalk':
      return createDingtalkAdapter(deps);
    case 'wecom':
      return createWecomAdapter();
  }
}

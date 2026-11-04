// WeCom authorizes by QR scan inside the container; the Lambda logic lives in oauth/qr.ts.
import type { QrAdapter } from './types';

export function createWecomAdapter(): QrAdapter {
  return { mode: 'qr', im: 'wecom' };
}

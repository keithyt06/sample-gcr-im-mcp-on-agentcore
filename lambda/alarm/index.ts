// SNS (CloudWatch alarm) → IM group bot webhook (technical design §6.4).
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ENV, type Im } from '../../shared/contract';
import { env, envIm } from '../shared/env';
import { log } from '../shared/log';

export interface SnsEvent {
  Records: { Sns: { Message: string; Subject?: string } }[];
}

interface AlarmMessage {
  AlarmName?: string;
  NewStateValue?: string;
  NewStateReason?: string;
}

const ssm = new SSMClient({});
const TIMEOUT_MS = 5000;

export function alarmText(slug: string, region: string, a: AlarmMessage): string {
  return `[${slug}/${region}] ${a.AlarmName ?? 'unknown'} ${a.NewStateValue ?? 'UNKNOWN'}: ${a.NewStateReason ?? ''}`;
}

export function webhookBody(im: Im, text: string): unknown {
  return im === 'feishu' || im === 'lark' ? { msg_type: 'text', content: { text } } : { msgtype: 'text', text: { content: text } };
}

export async function handler(event: SnsEvent, deps: { fetch?: typeof fetch } = {}): Promise<void> {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const im = envIm();
  const slug = env(ENV.SLUG);
  const region = process.env[ENV.AWS_REGION] ?? '';
  const p = await ssm.send(new GetParameterCommand({ Name: env(ENV.WEBHOOK_URL_PARAM), WithDecryption: true }));
  const url = p.Parameter?.Value;
  if (!url || !/^https:\/\//.test(url)) {
    log('ERROR', 'webhook_url_invalid');
    return;
  }
  for (const rec of event.Records ?? []) {
    let alarm: AlarmMessage;
    try {
      alarm = JSON.parse(rec.Sns.Message) as AlarmMessage;
    } catch {
      alarm = { AlarmName: rec.Sns.Subject ?? 'unknown', NewStateReason: rec.Sns.Message };
    }
    const resp = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookBody(im, alarmText(slug, region, alarm))),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      log('ERROR', 'webhook_send_failed', { status: resp.status });
      throw new Error(`webhook returned ${resp.status}`);
    }
  }
}

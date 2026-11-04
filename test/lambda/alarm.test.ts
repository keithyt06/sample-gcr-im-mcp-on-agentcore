import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { alarmText, handler, webhookBody } from '../../lambda/alarm/index';
import { fakeFetch, installFakes, jsonResp, setEnv, ssmMock } from './helpers';

let out: MockInstance<typeof console.log>;
beforeEach(() => {
  installFakes();
  setEnv('feishu', { WEBHOOK_URL_PARAM: '/team-a/alarm-webhook' });
  out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => out.mockRestore());

const alarm = { AlarmName: 'im-mcp-team-a-ap-northeast-1-token-lost', NewStateValue: 'ALARM', NewStateReason: 'Threshold crossed', Region: 'Asia Pacific (Tokyo)' };
const snsEvent = (m: string, subject?: string) => ({ Records: [{ Sns: { Message: m, Subject: subject } }] });

describe('alarm webhook', () => {
  it('text format', () => {
    expect(alarmText('team-a', 'ap-northeast-1', alarm)).toBe('[team-a/ap-northeast-1] im-mcp-team-a-ap-northeast-1-token-lost ALARM: Threshold crossed');
    expect(alarmText('s', 'r', {})).toBe('[s/r] unknown UNKNOWN: ');
  });
  it.each([
    ['feishu', { msg_type: 'text', content: { text: 't' } }],
    ['lark', { msg_type: 'text', content: { text: 't' } }],
    ['dingtalk', { msgtype: 'text', text: { content: 't' } }],
    ['wecom', { msgtype: 'text', text: { content: 't' } }],
  ] as const)('%s body', (im, expected) => {
    expect(webhookBody(im, 't')).toEqual(expected);
  });
  it('reads the URL from SSM (with decryption) and posts per record', async () => {
    const f = fakeFetch([['hooks.example.com', () => jsonResp(200, { ok: true })]]);
    await handler(snsEvent(JSON.stringify(alarm)), { fetch: f });
    expect(ssmMock.commandCalls(GetParameterCommand)[0]!.args[0].input).toEqual({ Name: '/team-a/alarm-webhook', WithDecryption: true });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ msg_type: 'text', content: { text: '[team-a/ap-northeast-1] im-mcp-team-a-ap-northeast-1-token-lost ALARM: Threshold crossed' } });
  });
  it('non-JSON SNS message falls back to subject + raw text', async () => {
    setEnv('dingtalk', { WEBHOOK_URL_PARAM: '/team-a/alarm-webhook' });
    const f = fakeFetch([['hooks', () => jsonResp(200, {})]]);
    await handler(snsEvent('plain text', 'Subj'), { fetch: f });
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ msgtype: 'text', text: { content: '[team-a/ap-northeast-1] Subj UNKNOWN: plain text' } });
  });
  it('non-2xx throws so SNS retries', async () => {
    const f = fakeFetch([['hooks', () => jsonResp(500, {})]]);
    await expect(handler(snsEvent(JSON.stringify(alarm)), { fetch: f })).rejects.toThrow('500');
  });
  it('invalid URL in SSM is logged and skipped', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'http://insecure' } });
    const f = fakeFetch([]);
    await handler(snsEvent('{}'), { fetch: f });
    expect(f.calls).toHaveLength(0);
  });
});

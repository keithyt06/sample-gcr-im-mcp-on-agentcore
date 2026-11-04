// Store the IM app secret in Secrets Manager `<slug>/im-app` as {appId, appSecret, configured: true}.
//   npm run secret:set-im-app -- [-c config=<path>] [--no-validate]
// The secret is read from a no-echo prompt (or from stdin when piped), never from argv.
// Before writing, the credentials are checked against the IM (feishu/lark app_access_token; dingtalk accessToken).
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { getInfraAdapter } from '../infra/lib/adapters/index.js';
import type { Config } from '../infra/lib/config.js';
import { namesFor } from '../infra/lib/names.js';
import { die, isMain, loadArgsConfig, parseArgs } from './common.js';

async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let buf = '';
    for await (const c of stdin) buf += String(c);
    return buf.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let s = '';
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          done();
          return resolve(s.trim());
        }
        if (c === '\u0003') {
          done();
          return reject(new Error('aborted'));
        }
        s = c === '\u007f' || c === '\b' ? s.slice(0, -1) : s + c;
      }
    };
    stdin.on('data', onData);
  });
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: r.status, json: {} };
  }
}

/** Throws with a readable reason when the IM rejects the credentials. */
export async function validateImApp(cfg: Config, appId: string, appSecret: string): Promise<void> {
  if (cfg.im === 'feishu' || cfg.im === 'lark') {
    const host = cfg.im === 'feishu' ? 'open.feishu.cn' : 'open.larksuite.com';
    const { json } = await postJson(`https://${host}/open-apis/auth/v3/app_access_token/internal`, { app_id: appId, app_secret: appSecret });
    if (json.code !== 0 || typeof json.app_access_token !== 'string')
      throw new Error(`${cfg.im} rejected the credentials: code=${String(json.code)} msg=${String(json.msg)}`);
  } else if (cfg.im === 'dingtalk') {
    const { status, json } = await postJson('https://api.dingtalk.com/v1.0/oauth2/accessToken', { appKey: appId, appSecret });
    if (status !== 200 || typeof json.accessToken !== 'string')
      throw new Error(`dingtalk rejected the credentials: HTTP ${status} ${String(json.code ?? '')} ${String(json.message ?? '')}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadArgsConfig(args);
  const adapter = getInfraAdapter(cfg.im);
  if (!adapter.needsAppSecret) die(`im=${cfg.im} has no app secret (users authorize by QR scan); nothing to do`);
  const appId = adapter.appId(cfg) ?? die(`config has no ${cfg.im} app id`);
  const label = cfg.im === 'dingtalk' ? 'DingTalk Client Secret (AppSecret)' : `${cfg.im === 'feishu' ? 'Feishu' : 'Lark'} App Secret`;
  const appSecret = await readHidden(`${label} for ${appId}: `);
  if (!appSecret) die('empty secret');

  if (args.flags['no-validate'] !== true) {
    await validateImApp(cfg, appId, appSecret);
    console.error(`validated against ${cfg.im}: OK`);
  }
  const name = namesFor(cfg.slug, cfg.region).imAppSecret;
  const sm = new SecretsManagerClient({ region: cfg.region });
  await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: JSON.stringify({ appId, appSecret, configured: true }) }));
  console.error(`stored ${name} in ${cfg.region}. Lambdas pick it up within 5 minutes, the container within 30 minutes.`);
}

if (isMain(import.meta.url)) main().catch((e: Error) => die(e.message));

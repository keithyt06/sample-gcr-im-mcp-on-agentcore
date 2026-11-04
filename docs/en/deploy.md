[Chinese](../zh-CN/deploy.md) | English

# Deploy, operate, and clean up

This page is the detailed walkthrough. Prepare the items in [prerequisites.md](prerequisites.md) and the IM app in the per-IM guide first.

All commands run from the repo root. Every helper script accepts `-c config=<path>` (default `config/deploy.yaml`) or `--stack ImMcp-<slug> --region <region>`.

## 1. Install and configure

```bash
npm ci
cp config/deploy.example.yaml config/deploy.yaml    # gitignored
```

Edit `config/deploy.yaml`. Minimal examples:

```yaml
# AWS Global, Feishu
region: ap-northeast-1
im: feishu
slug: team-a
feishu:
  appId: cli_xxxxxxxxxxxxxxxx
```

```yaml
# AWS China, DingTalk, ICP-filed custom domain
region: cn-northwest-1
im: dingtalk
slug: team-b
dingtalk:
  clientId: dingxxxxxxxxxxxx
ingress:
  customDomain: mcp.example.cn
  certificateArn: arn:aws-cn:acm:cn-northwest-1:<account-id>:certificate/<uuid>
```

```yaml
# WeCom, operator approval on
region: ap-northeast-1
im: wecom
slug: team-c
wecom:
  requireApproval: true
```

Full key reference: `config/deploy.example.yaml` and `infra/lib/config.ts`. Highlights:

| Key | Default | Notes |
|---|---|---|
| `region` | (required) | Partition is derived from it. Allowed list: `infra/lib/regions.ts` |
| `im` | (required) | `feishu` \| `lark` \| `dingtalk` \| `wecom`, one per deployment |
| `slug` | (required) | 3–20 chars, `^[a-z][a-z0-9-]{1,18}[a-z0-9]$` |
| `ingress.customDomain` + `ingress.certificateArn` | unset | Set both. Certificate in the stack's partition and region |
| `ingress.edge` | `none` | `cloudfront`: AWS Global only, not together with `customDomain` in v1 |
| `ingress.waf` | `false` | Needs `edge: cloudfront`; creates `ImMcp-<slug>-Waf` in us-east-1 |
| `ingress.rateLimit` | `rps 50, burst 100, registerRps 5, registerBurst 10, authorizeRps 2, authorizeBurst 5` | API Gateway throttles: stage default, `POST /register`, `GET /authorize` |
| `runtime.idleTimeoutSec` | `600` | AgentCore session idle timeout (60–28800) |
| `runtime.maxConcurrent` | `10` | Concurrent CLI calls per microVM (1–50) |
| `build.mirror` | `auto` | `auto`: China regions use npmmirror + the China ECR base image |
| `build.baseImage` | unset | Digest-pinned base image; required for `mirror: cn` on a Global region |
| `oauth.extraRedirectHosts` | `[]` | Extra HTTPS redirect hosts for MCP clients (`*.example.com` allowed) |
| `alarm.webhookUrlSsmParam` | unset | **Name** of an SSM parameter holding an IM bot webhook URL |
| `feishu` / `lark`: `appId`, `scopes` | scopes = `config/scopes/feishu.json` | |
| `dingtalk`: `clientId`, `scopes` | scopes = `[openid, corpid]` | |
| `wecom`: `requireApproval`, `maxPendingQr` | `false`, `20` | See [im-setup-wecom.md](im-setup-wecom.md) |

Check the config without deploying:

```bash
npx cdk synth -c config=config/deploy.yaml > /dev/null
```

## 2. Bootstrap (once per account and region)

```bash
export AWS_PROFILE=<your-profile> AWS_REGION=<region>
npx cdk bootstrap aws://<account-id>/<region>
# Only for ingress.waf: true (AWS Global):
npx cdk bootstrap aws://<account-id>/us-east-1
```

## 3. AWS China only: mirror the base image (once per region)

```bash
AWS_PROFILE=<your-china-profile> scripts/mirror-base-image.sh cn-northwest-1   # or cn-north-1
```

The script creates the ECR repository `gcr-im-mcp/base/node` (immutable tags, scan on push) outside the stack, grants the CDK image-publishing role pull access, pulls the pinned `linux/arm64` Node image from `public.ecr.aws`, and pushes it. Run it from a host that reaches both `public.ecr.aws` and China ECR. It prints the digest: if it differs from `CN_BASE_DIGEST` in `shared/versions.ts`, pin the printed value there or in `build.baseImage`.

The build in China then uses only the mirrored base image and `registry.npmmirror.com`. Nothing is fetched from GitHub, Docker Hub, or `public.ecr.aws` during the build.

## 4. Deploy

```bash
AWS_PROFILE=<your-profile> AWS_REGION=<region> npm run deploy -- -c config=config/deploy.yaml
```

`npm run deploy` is `cdk deploy --all --require-approval never`. It builds the ARM64 container image locally, pushes it to the CDK assets repository, and creates the stack `ImMcp-<slug>` (plus `ImMcp-<slug>-Waf` in us-east-1 if `ingress.waf: true`). Measured deploy times were about 2–2.5 minutes in ap-northeast-1 and about 5 minutes in cn-northwest-1. The image is about 95 MB (Feishu/Lark) to 155 MB (DingTalk, WeCom) compressed.

Stack outputs:

| Output | Use |
|---|---|
| `BaseUrl` | Public base URL |
| `McpUrl` | Give this to MCP clients |
| `CallbackUrl` | Feishu/Lark/DingTalk: register in the IM console |
| `ImConsoleCallbackHint` | Feishu/Lark: link to the app's Security Settings. DingTalk: link to the app list |
| `ImAppSecretName` | Feishu/Lark/DingTalk: `<slug>/im-app`, filled by `secret:set-im-app` |
| `CustomDomainTarget` | Custom domain only: point your DNS CNAME (or alias) here |
| `RuntimeArn`, `AlarmTopicArn`, `RootKeySecretName`, `UserSecretPrefix`, `TableName` | Operations |

## 5. After deploy

1. **Feishu / Lark / DingTalk: store the app secret.** The secret `<slug>/im-app` exists only after the deploy.
   ```bash
   AWS_PROFILE=<your-profile> AWS_REGION=<region> npm run secret:set-im-app -- -c config=config/deploy.yaml
   ```
   It prompts without echo, validates the credentials against the IM, and writes `{appId, appSecret, configured: true}`. `--no-validate` skips the check. Lambdas pick it up within 5 minutes, the container within 30 minutes.
2. **Register `CallbackUrl`** in the IM console (per-IM guide). WeCom has no callback.
3. **Custom domain:** create the DNS record pointing at `CustomDomainTarget`.
4. **Verify:** `npm run e2e -- -c config=config/deploy.yaml` (China without ICP: `npm run e2e:internal`). See [testing.md](testing.md).
5. Give users `McpUrl`. Client setup is in the [README](../../README.md#connect-an-mcp-client).

## 6. Operations

### Users

```bash
npm run users -- list                 # userId, im, status (active | pending_approval | revoked | replaced), timestamps
npm run users -- approve <userId>...  # WeCom with wecom.requireApproval: true
npm run users -- revoke <userId>...   # disable + force-delete the user's IM credential
```

Revocation is permanent and takes effect at once for new logins and refresh grants. Access tokens already issued stay valid for up to 1 hour, and the middleware caches IM credentials for up to 60 seconds. Details: [security.md](security.md#revocation-timing).

### Logs

| Log group | Content |
|---|---|
| `/aws/lambda/im-mcp-<slug>-oauth` | OAuth AS: DCR, authorize, callback, token, WeCom QR status |
| `/aws/lambda/im-mcp-<slug>-middleware` | MCP proxy → InvokeAgentRuntime |
| `/aws/lambda/im-mcp-<slug>-refresh` | 30-minute IM token refresh (Feishu/Lark/DingTalk) |
| `/aws/lambda/im-mcp-<slug>-alarm` | Alarm → webhook (if configured) |
| `/aws/apigateway/im-mcp-<slug>-access` | API Gateway access log (route, status, latency, integration error) |
| `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT` | Container stdout (created by the service, not by the stack) |

Lambda logs carry a hash of the user id (`userIdHash`), never tokens.

### Alarms

All alarms go to the SNS topic `AlarmTopicArn`. Subscribe your email to it, or set `alarm.webhookUrlSsmParam` to forward to an IM bot webhook. Alarm names are `im-mcp-<slug>-<region>-<name>`:

| Alarm | IM | Fires when |
|---|---|---|
| `token-lost` | Feishu/Lark/DingTalk | A refreshed IM token could not be stored; the user must re-authorize |
| `refresh-failed` | Feishu/Lark/DingTalk | 3 or more refresh failures in 30 minutes |
| `grant-expired` | WeCom | A user's 7-day capability grant expired (850003) |
| `oauth-errors`, `middleware-errors`, `refresh-errors` | all | Lambda errors in 5 minutes |
| `api-5xx` | all | 5 or more HTTP API 5xx responses in 5 minutes |

### Rotating secrets

- IM app secret: run `npm run secret:set-im-app` again.
- HMAC root key: put a new random value in `<slug>/root-key`. Every MCP token and DCR client id becomes invalid within 5 minutes; all users reconnect.

### Updating

Change the config or code and run `npm run deploy` again. Changing `region` to the other partition, `im`, or `slug` creates a different deployment; destroy the old one separately.

## Cleanup

```bash
AWS_PROFILE=<your-profile> AWS_REGION=<region> npm run destroy -- -c config=config/deploy.yaml
AWS_PROFILE=<your-profile> AWS_REGION=<region> npm run teardown:extras -- -c config=config/deploy.yaml
```

`npm run destroy` is `cdk destroy --all --force`. It removes the stack, including the DynamoDB table, `<slug>/root-key`, `<slug>/im-app`, Lambda and API log groups.

It does **not** remove:

| Left behind | Why | How to remove |
|---|---|---|
| Per-user secrets `<slug>/users/*` | Created at runtime, not by CloudFormation | `npm run teardown:extras` (force-delete, no recovery window) |
| KMS key for user secrets | `RemovalPolicy.RETAIN` (about USD 1 per month until deleted) | `npm run teardown:extras` schedules deletion with a 7-day window. The key is found by its tag `im-mcp:slug=<slug>` |
| Runtime log group `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT` | Created by the service | Delete it in CloudWatch Logs |
| Container images in the CDK assets ECR repository | Shared by CDK | `aws ecr batch-delete-image` on `cdk-<qualifier>-container-assets-<account-id>-<region>` |
| China base-image mirror `gcr-im-mcp/base/node` | Shared by every deployment in the region | Keep it, or delete the repository when you decommission the region |
| DNS record, ACM certificate | Yours | Remove manually |

`teardown:extras` lists what it will delete and asks you to type the slug; `--yes` skips the prompt. Redeploying the same slug right after a destroy without `teardown:extras` can fail, because deleted secret names stay reserved during their recovery window.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **AWS China: every request to `BaseUrl` returns `403 {"message":"Forbidden"}`**, access log shows status 403, Lambdas are never invoked | The account has no ICP filing; public access to the default `execute-api` URL is blocked. Undefined routes return 404 | Use an ICP-filed `ingress.customDomain`. To verify the backend without ICP, run `npm run e2e:internal` |
| `npm run e2e` fails steps 4–5 with **429** | Run right after a previous e2e run: step 8 drains the `/register` bucket, and `/authorize` allows 2 rps / burst 5 | Wait about 30 seconds and run again |
| `InvalidClientTokenId` with China credentials | `AWS_REGION` not set, so STS goes to the global endpoint | Set `AWS_REGION=cn-north-1` or `cn-northwest-1` |
| Docker build fails with `exec format error` or `no match for platform` | The host cannot build `linux/arm64` | Use an ARM64 host, or on x86 install QEMU binfmt (`docker run --privileged --rm tonistiigi/binfmt --install arm64`) and use `buildx`. In China the binfmt image comes from Docker Hub, which is often unreachable; an ARM64 build host avoids it |
| China deploy fails pulling the base image (`not found` / `denied`) | Base image not mirrored in this region, digest mismatch, or the repository policy is missing | Run `scripts/mirror-base-image.sh <region>` and pin the printed digest |
| `secret:set-im-app` fails with `ResourceNotFoundException` | Run before the first deploy | Deploy first |
| `secret:set-im-app` prints `<im> rejected the credentials` | Wrong secret, or app on the wrong platform (Feishu vs Lark) | Re-run with the correct value |
| Config validation error | Key or value invalid; the message names the key and the fix | Correct `config/deploy.yaml` |
| Deploy error naming an existing secret `<slug>/...` | A previous deploy with the same slug left a secret scheduled for deletion | `npm run teardown:extras`, or use a new slug |
| Tool results `im_app_not_configured` | App secret not stored | `npm run secret:set-im-app` |
| IM authorization page shows a redirect URI error | `CallbackUrl` not registered, or a different host | Register the exact `CallbackUrl` |

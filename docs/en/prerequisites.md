[Chinese](../zh-CN/prerequisites.md) | English

# Prerequisites: what to prepare before deploying

Everything in this table must be ready **before** the first `deploy`. Secrets never go in `config/deploy.yaml`; they are written to AWS Secrets Manager with the helper script.

**Needed for:** `all` = every deployment. `china` = `region` is `cn-north-1` or `cn-northwest-1`. `global` = any other supported region.

| # | Item | Needed for | Where to get it | Where it goes |
|---|---|---|---|---|
| 1 | AWS account with admin (or CDK-deploy) permissions in the target region | all | AWS Global: your AWS account. AWS China: a separate China account (Beijing operated by Sinnet, Ningxia by NWCD). Global and China accounts and credentials are not interchangeable | Not stored. Used by your shell |
| 2 | AWS credentials profile for that partition | all | `aws configure --profile <name>` (or SSO). Use a separate profile for China | `AWS_PROFILE` env var. Also set `AWS_REGION` (in China, STS otherwise calls the global endpoint and fails with `InvalidClientTokenId`) |
| 3 | Target region with AgentCore Runtime | all | [Global region list](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html) · [China](https://docs.amazonaws.cn/en_us/aws/latest/userguide/bedrock-agentcore.html) | Config key `region`. The partition is derived from it; there is no partition key |
| 4 | Deployment slug (short name, lowercase, unique per account + region) | all | You choose it, for example `team-a` | Config key `slug`. Used in stack names (`ImMcp-<slug>`) and secret names (`<slug>/im-app`) |
| 5 | Node.js 22 LTS or later + npm | all | https://nodejs.org (or nvm) | Local toolchain (verify against `engines` in `package.json`) |
| 6 | Docker that can build **linux/arm64** images: an ARM64 host, or Docker with `buildx` + QEMU on x86 | all | Docker Desktop / Docker Engine. In China, an ARM64 host is recommended (QEMU/binfmt images come from Docker Hub, which is often unreachable) | Local toolchain |
| 7 | AWS CLI v2 | all | https://aws.amazon.com/cli/ | Local toolchain |
| 8 | CDK bootstrap in the target account + region | all | `npx cdk bootstrap aws://<account>/<region>` (once per account/region) | AWS account (CDKToolkit stack) |
| 9 | CDK bootstrap in `us-east-1` | global, only if `ingress.edge: cloudfront` + `ingress.waf: true` | Same command with `us-east-1` | AWS account |
| 10 | Base image mirrored into China ECR (one time per Node base-image upgrade) | china | Run the mirror script from a machine that can reach both Docker Hub and China ECR, with credentials for both partitions | China ECR repository (the stack's build reads it automatically when `build.mirror` resolves to `cn`) |
| 11 | Build mirror choice | all (default fine) | `auto` uses the CN mirror for China regions and global sources otherwise. Set `cn` when you build a **Global** stack from inside mainland China | Config key `build.mirror` (`auto` \| `cn` \| `global`) |
| 12 | **ICP-filed domain name** | china (required in practice) | Your ICP filing through your China account's ICP process. Without it, the public endpoint is not reachable from the internet | Config key `ingress.customDomain` |
| 13 | TLS certificate for that domain in ACM, **same region** as the stack | china; global if you use a custom domain | Request or import it in ACM in the target region | Config key `ingress.certificateArn` |
| 14 | DNS record for the custom domain | whenever you use a custom domain | Your DNS provider. Create it after the first deploy, pointing at the API Gateway regional domain name from the deploy output | DNS (outside AWS or in Route 53) |
| 15 | IM tenant + admin who can create and approve apps | all | Your Feishu / Lark / DingTalk / WeCom organization | See the per-IM guide |
| 16 | Feishu custom app: **App ID** + **App Secret** | feishu | [open.feishu.cn/app](https://open.feishu.cn/app). See [im-setup-feishu.md](im-setup-feishu.md) | App ID → config key `im.feishu.appId`. Secret → `npm run secret:set-im-app` → Secrets Manager `<slug>/im-app` `{appId, appSecret}` |
| 17 | Lark custom app: **App ID** + **App Secret** | lark | [open.larksuite.com/app](https://open.larksuite.com/app). See [im-setup-lark.md](im-setup-lark.md) | App ID → `im.lark.appId`. Secret → `npm run secret:set-im-app` → `<slug>/im-app` `{appId, appSecret}` |
| 18 | DingTalk internal app: **Client ID (AppKey)** + **Client Secret (AppSecret)** | dingtalk | [open-dev.dingtalk.com](https://open-dev.dingtalk.com). See [im-setup-dingtalk.md](im-setup-dingtalk.md) | Client ID → `im.dingtalk.clientId`. Secret → `npm run secret:set-im-app` → `<slug>/im-app` `{clientId, clientSecret}` |
| 19 | Scopes to request at user authorization (optional; defaults are provided) | feishu / lark / dingtalk | Per-IM guide | Config keys `im.feishu.scopes` / `im.lark.scopes` / `im.dingtalk.scopes` |
| 20 | WeCom: nothing to create in a developer console | wecom | Each user scans a QR code in the WeCom client after deploy, which creates or binds their smart bot. See [im-setup-wecom.md](im-setup-wecom.md) | No app credentials. Per-user credentials are stored by the service |
| 21 | **Admin approvals** | feishu / lark: publish the app version and approve it. dingtalk: publish the app and **enable CLI access** for the org. wecom: users (and admin if your org restricts bots) approve the smart-bot capability grants | IM admin console (see per-IM guide) | Done in the IM console. Nothing stored |
| 22 | **Redirect (callback) URL registration**, done **after the first deploy** | feishu / lark / dingtalk | The deploy output prints `<base>/callback` | Paste it in the IM console (Feishu/Lark: Security Settings → Redirect URLs; DingTalk: see guide). `<base>` is `https://<ingress.customDomain>` or the API Gateway URL |
| 23 | Alarm webhook URL (optional) | all | A bot webhook in your IM (or any HTTPS endpoint) | Store the URL in an **SSM parameter** you create. Config key `alarm.webhookUrlSsmParam` holds only the **parameter name** |
| 24 | MCP client | all | Global: Amazon Quick, Kiro, Claude Code, Codex, Cursor. China: Kiro, Claude Code, Codex, Cursor (Amazon Quick is not available in AWS China) | End users only need `<base>/mcp` |

> **Note on `im.<im>.*` keys:** in `config/deploy.yaml` these are written as a top-level `feishu:` (or `lark:`, `dingtalk:`, `wecom:`) block, next to `im: feishu`. For example, `im.feishu.appId` is `feishu: { appId: cli_xxx }`. Keep only the block that matches `im`. See `config/deploy.example.yaml`.

## Order of operations

1. Items 1–11 (AWS side), item 12–13 if China.
2. Create the IM app (items 15–19) **or**, for WeCom, nothing.
3. Fill `config/deploy.yaml`. Run `npm run secret:set-im-app` (not for WeCom).
4. Deploy. Copy `<base>/callback` from the output.
5. Register the callback URL in the IM console (item 22), publish or approve (item 21), and create the DNS record (item 14).
6. Give end users `<base>/mcp`.

## Never put these in the repo or config

App secrets, user tokens, AWS access keys, account IDs, `.aws/` files, private keys, webhook URLs that contain tokens. The config file holds **identifiers and names only** (app ID, SSM parameter name, certificate ARN).

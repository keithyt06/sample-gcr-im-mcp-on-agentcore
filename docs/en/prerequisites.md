[Chinese](../zh-CN/prerequisites.md) | English

# Prerequisites: what to prepare before deploying

Have everything in this table ready before the first deploy, except the items marked **after deploy**. Secrets never go in `config/deploy.yaml`. You write the IM app secret to AWS Secrets Manager with `npm run secret:set-im-app` **after** the first deploy, because the deploy creates that secret.

**Needed for:** `all` = every deployment. `china` = `region` is `cn-north-1` or `cn-northwest-1`. `global` = any other supported region.

| # | Item | Needed for | Where to get it | Where it goes |
|---|---|---|---|---|
| 1 | AWS account with admin (or CDK-deploy) permissions in the target region | all | AWS Global: your AWS account. AWS China: a separate China account (Beijing operated by Sinnet, Ningxia by NWCD). Global and China accounts and credentials are not interchangeable | Not stored. Used by your shell |
| 2 | AWS credentials profile for that partition | all | `aws configure --profile <name>` (or SSO). Use a separate profile for China | `AWS_PROFILE` env var. Also set `AWS_REGION`. With China credentials, STS otherwise calls the global endpoint and fails with `InvalidClientTokenId` |
| 3 | Target region with AgentCore Runtime | all | The supported list is `infra/lib/regions.ts` (21 Global regions plus `cn-north-1` and `cn-northwest-1`). A config with any other region fails validation and the error lists the allowed regions. Re-check: [Global](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html) · [China](https://docs.amazonaws.cn/en_us/aws/latest/userguide/bedrock-agentcore.html) | Config key `region`. The partition is derived from it; there is no partition key |
| 4 | Deployment slug | all | You choose it, for example `team-a`. Rule: 3–20 characters, lowercase letters, digits and `-`, starts with a letter, does not end with `-` (`^[a-z][a-z0-9-]{1,18}[a-z0-9]$`). Unique per account + region | Config key `slug`. Used in the stack name (`ImMcp-<slug>`) and secret names (`<slug>/im-app`, `<slug>/root-key`, `<slug>/users/<id>`) |
| 5 | Node.js 20.19 or later (22 LTS recommended) + npm | all | https://nodejs.org (or nvm) | Local toolchain (`engines.node` in `package.json` is `>=20.19`) |
| 6 | Docker that can build **linux/arm64** images: an ARM64 host, or Docker with `buildx` + QEMU on x86 | all | Docker Desktop / Docker Engine. In China, an ARM64 host is recommended, because the QEMU/binfmt installer image comes from Docker Hub, which is often unreachable | Local toolchain |
| 7 | AWS CLI v2 | all | https://aws.amazon.com/cli/ | Local toolchain |
| 8 | CDK bootstrap in the target account + region | all | `npx cdk bootstrap aws://<account-id>/<region>` (once per account/region) | AWS account (CDKToolkit stack) |
| 9 | CDK bootstrap in `us-east-1` | global, only if `ingress.edge: cloudfront` + `ingress.waf: true` | Same command with `us-east-1` | AWS account |
| 10 | Base image mirrored into China ECR | china | Run `AWS_PROFILE=<your-china-profile> scripts/mirror-base-image.sh <cn-north-1\|cn-northwest-1>` once per China region (and again after a base-image upgrade). It pulls the pinned `linux/arm64` Node image from `public.ecr.aws` (no login needed) and pushes it to the repository `gcr-im-mcp/base/node` in your China account. It needs **China credentials only** and a host that can reach both `public.ecr.aws` and China ECR. It prints the pushed digest: it should equal `CN_BASE_DIGEST` in `shared/versions.ts`; if it doesn't, pin the printed value in `CN_BASE_DIGEST` or in `build.baseImage` | China ECR repository `gcr-im-mcp/base/node` (outside the stack, so `destroy` keeps it). The build reads it automatically when `build.mirror` resolves to `cn` |
| 11 | Build mirror choice | all (default fine) | `auto` uses npmmirror + the China ECR base image for China regions and global sources otherwise. Set `cn` when you build a **Global** stack from inside mainland China. In that case you must also set `build.baseImage` to a digest-pinned image your build host can pull (`<registry>/<repo>@sha256:<64 hex>`), because the China ECR mirror lives in another partition | Config keys `build.mirror` (`auto` \| `cn` \| `global`) and `build.baseImage` |
| 12 | **ICP-filed domain name** | china (required for public access) | Your ICP filing through your China account's ICP process. Without it, every route on the default `execute-api` URL returns `403 {"message":"Forbidden"}` from the internet (observed in cn-northwest-1) | Config key `ingress.customDomain` |
| 13 | TLS certificate for that domain in ACM, **same partition and region** as the stack | china; global if you use a custom domain | Request or import it in ACM in the target region | Config key `ingress.certificateArn` (set together with `customDomain`) |
| 14 | DNS record for the custom domain (**after deploy**) | whenever you use a custom domain | Your DNS provider. Create a CNAME (or alias) pointing at the stack output `CustomDomainTarget` | DNS (outside AWS or in Route 53) |
| 15 | IM tenant + admin who can create and approve apps | all | Your Feishu / Lark / DingTalk / WeCom organization | See the per-IM guide |
| 16 | Feishu custom app: **App ID** + **App Secret** | feishu | [open.feishu.cn/app](https://open.feishu.cn/app). See [im-setup-feishu.md](im-setup-feishu.md) | App ID → config key `im.feishu.appId`. Secret → **after deploy**, `npm run secret:set-im-app` → Secrets Manager `<slug>/im-app` |
| 17 | Lark custom app: **App ID** + **App Secret** | lark | [open.larksuite.com/app](https://open.larksuite.com/app). See [im-setup-lark.md](im-setup-lark.md) | App ID → `im.lark.appId`. Secret → **after deploy**, `npm run secret:set-im-app` → `<slug>/im-app` |
| 18 | DingTalk internal app: **Client ID (AppKey)** + **Client Secret (AppSecret)** | dingtalk | [open-dev.dingtalk.com](https://open-dev.dingtalk.com). See [im-setup-dingtalk.md](im-setup-dingtalk.md) | Client ID → `im.dingtalk.clientId`. Secret → **after deploy**, `npm run secret:set-im-app` → `<slug>/im-app` |
| 19 | Scopes to request at user authorization (optional; defaults are provided) | feishu / lark / dingtalk | Per-IM guide | Config keys `im.feishu.scopes` / `im.lark.scopes` / `im.dingtalk.scopes` |
| 20 | WeCom: nothing to create in a developer console | wecom | Each user scans a QR code in the WeCom client after deploy, which creates or binds their smart bot. See [im-setup-wecom.md](im-setup-wecom.md) | No app credentials. Per-user credentials are stored by the service. Recommended: `wecom: { requireApproval: true }` |
| 21 | **Admin approvals** | feishu / lark: publish the app version and approve it. dingtalk: publish the app and **enable CLI access** for the org. wecom: users (and the admin, if your org restricts bots) approve the smart-bot capability grants | IM admin console (see per-IM guide) | Done in the IM console. Nothing stored |
| 22 | **Redirect (callback) URL registration** (**after deploy**) | feishu / lark / dingtalk | Stack output `CallbackUrl` (= `<base>/callback`). Feishu/Lark also get `ImConsoleCallbackHint`, a direct link to the console page | Paste it in the IM console (Feishu/Lark: Security Settings → Redirect URLs; DingTalk: see guide) |
| 23 | Alarm webhook URL (optional) | all | A bot webhook in your IM (or any HTTPS endpoint) | Store the URL in an **SSM parameter** you create. Config key `alarm.webhookUrlSsmParam` holds only the **parameter name** |
| 24 | MCP client | all | Global: Amazon Quick, Kiro, Claude Code, Codex, Cursor. China: Kiro, Claude Code, Codex, Cursor (Amazon Quick is not available in AWS China) | End users only need `<base>/mcp` (stack output `McpUrl`). Amazon Quick: [tutorial](client-amazon-quick.md) |

**`<base>`** is the public base URL, printed as the stack output `BaseUrl`. It is `https://<ingress.customDomain>` when you set a custom domain, the CloudFront domain when `ingress.edge: cloudfront`, and otherwise the API Gateway `execute-api` URL. Other outputs: `McpUrl`, `CallbackUrl` and `ImAppSecretName` (feishu/lark/dingtalk), `ImConsoleCallbackHint` (feishu/lark/dingtalk), `CustomDomainTarget` (custom domain only), `RuntimeArn`, `AlarmTopicArn`, `RootKeySecretName`, `UserSecretPrefix`, `TableName`.

> **Note on `im.<im>.*` keys:** in `config/deploy.yaml` these are written as a top-level `feishu:` (or `lark:`, `dingtalk:`, `wecom:`) block, next to `im: feishu`. For example, `im.feishu.appId` is `feishu: { appId: cli_xxxxxxxxxxxxxxxx }` (the App ID must match `^cli_[A-Za-z0-9]{8,32}$`). Keep only the block that matches `im`. See `config/deploy.example.yaml`.

## Order of operations

1. Items 1–11 (AWS side). For China, also items 12–13.
2. Create the IM app (items 15–19, 21), or for WeCom, nothing.
3. Fill `config/deploy.yaml`.
4. Deploy: `npm run deploy -- -c config=config/deploy.yaml`. Note the outputs.
5. Feishu / Lark / DingTalk: `npm run secret:set-im-app -- -c config=config/deploy.yaml` (stores the app secret in the secret the deploy created).
6. Register `CallbackUrl` in the IM console (item 22). Create the DNS record (item 14) if you use a custom domain.
7. Run `npm run e2e` (see [testing.md](testing.md)), then give end users `McpUrl`.

Running `secret:set-im-app` before the first deploy fails with `ResourceNotFoundException`: the secret `<slug>/im-app` does not exist yet.

Detailed walkthrough: [deploy.md](deploy.md).

## Never put these in the repo or config

App secrets, user tokens, AWS access keys, account IDs, `.aws/` files, private keys, webhook URLs that contain tokens. The config file holds **identifiers and names only** (app ID, SSM parameter name, certificate ARN). Keys whose name looks like a secret (`secret`, `token`, `password`, `apikey`) are rejected by the config validator.

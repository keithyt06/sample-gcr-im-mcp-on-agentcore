简体中文 | [English](../en/deploy.md)

# 部署、运维与清理

本页是详细操作步骤。请先按 [prerequisites.md](prerequisites.md) 准备好各项内容，并按对应 IM 的配置指南准备好 IM 应用。

所有命令都在仓库根目录执行。所有辅助脚本都接受 `-c config=<路径>`（默认 `config/deploy.yaml`）或 `--stack ImMcp-<slug> --region <区域>`。

## 1. 安装与配置

```bash
npm ci
cp config/deploy.example.yaml config/deploy.yaml    # 已在 .gitignore 中
```

编辑 `config/deploy.yaml`。最小示例：

```yaml
# AWS Global，飞书
region: ap-northeast-1
im: feishu
slug: team-a
feishu:
  appId: cli_xxxxxxxxxxxxxxxx
```

```yaml
# AWS 中国区，钉钉，已备案的自定义域名
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
# 企业微信，开启管理员审批
region: ap-northeast-1
im: wecom
slug: team-c
wecom:
  requireApproval: true
```

完整配置项见 `config/deploy.example.yaml` 和 `infra/lib/config.ts`。要点：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `region` | （必填） | 分区由它推导。允许的区域见 `infra/lib/regions.ts` |
| `im` | （必填） | `feishu` \| `lark` \| `dingtalk` \| `wecom`，每个部署一个 |
| `slug` | （必填） | 3–20 个字符，`^[a-z][a-z0-9-]{1,18}[a-z0-9]$` |
| `ingress.customDomain` + `ingress.certificateArn` | 不设置 | 两者同时设置。证书须与 Stack 在同一分区、同一区域 |
| `ingress.edge` | `none` | `cloudfront`：仅 AWS Global，v1 中不能与 `customDomain` 同时使用 |
| `ingress.waf` | `false` | 需要 `edge: cloudfront`；会在 us-east-1 创建 `ImMcp-<slug>-Waf` |
| `ingress.rateLimit` | `rps 50, burst 100, registerRps 5, registerBurst 10, authorizeRps 2, authorizeBurst 5` | API Gateway 限流：Stage 默认值、`POST /register`、`GET /authorize` |
| `runtime.idleTimeoutSec` | `600` | AgentCore 会话空闲超时（60–28800） |
| `runtime.maxConcurrent` | `10` | 每个 microVM 内并发的 CLI 调用数（1–50） |
| `build.mirror` | `auto` | `auto`：中国区使用 npmmirror + 中国区 ECR 基础镜像 |
| `build.baseImage` | 不设置 | 以 digest 固定的基础镜像；在 Global 区域使用 `mirror: cn` 时必填 |
| `oauth.extraRedirectHosts` | `[]` | 允许 MCP 客户端使用的额外 HTTPS 重定向主机（可写 `*.example.com`） |
| `alarm.webhookUrlSsmParam` | 不设置 | 存放 IM 机器人 webhook URL 的 SSM 参数的**名称** |
| `feishu` / `lark`：`appId`、`scopes` | scopes = `config/scopes/feishu.json` | |
| `dingtalk`：`clientId`、`scopes` | scopes = `[openid, corpid]` | |
| `wecom`：`requireApproval`、`maxPendingQr` | `false`、`20` | 见 [im-setup-wecom.md](im-setup-wecom.md) |

不部署、只检查配置：

```bash
npx cdk synth -c config=config/deploy.yaml > /dev/null
```

## 2. Bootstrap（每个账号每个区域一次）

```bash
export AWS_PROFILE=<your-profile> AWS_REGION=<region>
npx cdk bootstrap aws://<account-id>/<region>
# 仅当 ingress.waf: true（AWS Global）：
npx cdk bootstrap aws://<account-id>/us-east-1
```

## 3. 仅 AWS 中国区：同步基础镜像（每个区域一次）

```bash
AWS_PROFILE=<your-china-profile> scripts/mirror-base-image.sh cn-northwest-1   # 或 cn-north-1
```

脚本会在 Stack 之外创建 ECR 仓库 `gcr-im-mcp/base/node`（标签不可变，推送时扫描），授予 CDK 镜像发布角色拉取权限，从 `public.ecr.aws` 拉取固定版本的 `linux/arm64` Node 镜像并推送。请在能同时访问 `public.ecr.aws` 和中国区 ECR 的主机上运行。脚本会打印 digest：如果与 `shared/versions.ts` 中的 `CN_BASE_DIGEST` 不同，请把打印出的值填到那里或填到 `build.baseImage`。

之后中国区的构建只使用同步好的基础镜像和 `registry.npmmirror.com`，构建过程中不会访问 GitHub、Docker Hub 或 `public.ecr.aws`。

## 4. 部署

```bash
AWS_PROFILE=<your-profile> AWS_REGION=<region> npm run deploy -- -c config=config/deploy.yaml
```

`npm run deploy` 即 `cdk deploy --all --require-approval never`。它会在本机构建 ARM64 容器镜像，推送到 CDK 资产仓库，然后创建 Stack `ImMcp-<slug>`（`ingress.waf: true` 时还会在 us-east-1 创建 `ImMcp-<slug>-Waf`）。实测部署时间：ap-northeast-1 约 2–2.5 分钟，cn-northwest-1 约 5 分钟。压缩后镜像约 95 MB（飞书/Lark）到 155 MB（钉钉、企业微信）。

Stack 输出：

| 输出 | 用途 |
|---|---|
| `BaseUrl` | 公网基础 URL |
| `McpUrl` | 发给 MCP 客户端 |
| `CallbackUrl` | 飞书/Lark/钉钉：在 IM 后台登记 |
| `ImConsoleCallbackHint` | 飞书/Lark：应用安全设置页面的链接。钉钉：应用列表的链接 |
| `ImAppSecretName` | 飞书/Lark/钉钉：`<slug>/im-app`，由 `secret:set-im-app` 写入 |
| `CustomDomainTarget` | 仅自定义域名：DNS 的 CNAME（或别名）记录指向这里 |
| `RuntimeArn`、`AlarmTopicArn`、`RootKeySecretName`、`UserSecretPrefix`、`TableName` | 运维使用 |

## 5. 部署之后

1. **飞书 / Lark / 钉钉：写入应用密钥。**密钥 `<slug>/im-app` 在部署之后才存在。
   ```bash
   AWS_PROFILE=<your-profile> AWS_REGION=<region> npm run secret:set-im-app -- -c config=config/deploy.yaml
   ```
   脚本不回显地提示输入，先向 IM 校验凭证，再写入 `{appId, appSecret, configured: true}`。`--no-validate` 可跳过校验。Lambda 在 5 分钟内读到新值，容器在 30 分钟内读到。
2. **在 IM 后台登记 `CallbackUrl`**（见各 IM 配置指南）。企业微信没有回调。
3. **自定义域名：**创建指向 `CustomDomainTarget` 的 DNS 记录。
4. **验证：**`npm run e2e -- -c config=config/deploy.yaml`（没有 ICP 的中国区：`npm run e2e:internal`），见 [testing.md](testing.md)。
5. 把 `McpUrl` 发给用户。客户端配置见 [README](../../README.zh-CN.md#连接-mcp-客户端)。

## 6. 运维

### 用户管理

```bash
npm run users -- list                 # userId、im、状态（active | pending_approval | revoked | replaced）、时间戳
npm run users -- approve <userId>...  # 企业微信，wecom.requireApproval: true 时使用
npm run users -- revoke <userId>...   # 禁用用户并强制删除其 IM 凭证
```

撤销是永久的，对新登录和 refresh 换发立即生效。已经签发的 access token 最长在 1 小时内仍然有效，middleware 会把 IM 凭证缓存最多 60 秒。详见 [security.md](security.md#撤销的生效时间)。

### 日志

| 日志组 | 内容 |
|---|---|
| `/aws/lambda/im-mcp-<slug>-oauth` | OAuth 授权服务器：DCR、authorize、callback、token、企业微信扫码状态 |
| `/aws/lambda/im-mcp-<slug>-middleware` | MCP 代理 → InvokeAgentRuntime |
| `/aws/lambda/im-mcp-<slug>-refresh` | 每 30 分钟刷新 IM token（飞书/Lark/钉钉） |
| `/aws/lambda/im-mcp-<slug>-alarm` | 告警 → webhook（如已配置） |
| `/aws/apigateway/im-mcp-<slug>-access` | API Gateway 访问日志（路由、状态码、延迟、集成错误） |
| `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT` | 容器标准输出（由服务创建，不属于 Stack） |

Lambda 日志中只有用户 ID 的哈希（`userIdHash`），从不记录 token。

### 告警

所有告警都发送到 SNS 主题 `AlarmTopicArn`。可以把邮箱订阅到这个主题，或设置 `alarm.webhookUrlSsmParam` 转发到 IM 机器人 webhook。告警名称为 `im-mcp-<slug>-<region>-<name>`：

| 告警 | IM | 触发条件 |
|---|---|---|
| `token-lost` | 飞书/Lark/钉钉 | 刷新后的 IM token 未能保存，用户需要重新授权 |
| `refresh-failed` | 飞书/Lark/钉钉 | 30 分钟内刷新失败 3 次或以上 |
| `grant-expired` | 企业微信 | 某用户的 7 天能力授权已过期（850003） |
| `oauth-errors`、`middleware-errors`、`refresh-errors` | 全部 | 5 分钟内出现 Lambda 错误 |
| `api-5xx` | 全部 | 5 分钟内 HTTP API 5xx 响应达到 5 次或以上 |

### 轮换密钥

- IM 应用密钥：再次执行 `npm run secret:set-im-app`。
- HMAC 根密钥：向 `<slug>/root-key` 写入新的随机值。5 分钟内所有 MCP token 和 DCR client id 失效，所有用户重新连接。

### 更新

修改配置或代码后再次执行 `npm run deploy`。把 `region` 改到另一个分区、或修改 `im` 或 `slug`，都会产生一个新的部署，旧部署需要单独销毁。

## 清理

```bash
AWS_PROFILE=<your-profile> AWS_REGION=<region> npm run destroy -- -c config=config/deploy.yaml
AWS_PROFILE=<your-profile> AWS_REGION=<region> npm run teardown:extras -- -c config=config/deploy.yaml
```

`npm run destroy` 即 `cdk destroy --all --force`。它会删除 Stack，包括 DynamoDB 表、`<slug>/root-key`、`<slug>/im-app`、Lambda 和 API 的日志组。

以下资源**不会**被删除：

| 残留资源 | 原因 | 删除方法 |
|---|---|---|
| 每个用户的密钥 `<slug>/users/*` | 运行时创建，不归 CloudFormation 管理 | `npm run teardown:extras`（强制删除，无恢复期） |
| 用户密钥的 KMS 密钥 | `RemovalPolicy.RETAIN`（删除前约每月 1 美元） | `npm run teardown:extras` 会安排 7 天后删除。通过标签 `im-mcp:slug=<slug>` 找到该密钥 |
| Runtime 日志组 `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT` | 由服务创建 | 在 CloudWatch Logs 中删除 |
| CDK 资产 ECR 仓库中的容器镜像 | CDK 共用 | 对 `cdk-<qualifier>-container-assets-<account-id>-<region>` 执行 `aws ecr batch-delete-image` |
| 中国区基础镜像仓库 `gcr-im-mcp/base/node` | 同一区域所有部署共用 | 保留；或在不再使用该区域时删除仓库 |
| DNS 记录、ACM 证书 | 属于你自己 | 手动删除 |

`teardown:extras` 会先列出要删除的内容，要求你输入 slug 确认；`--yes` 跳过确认。如果 destroy 之后没有执行 `teardown:extras` 就立即用同一个 slug 重新部署，可能会失败，因为已删除的密钥名称在恢复期内仍被占用。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| **AWS 中国区：所有对 `BaseUrl` 的请求都返回 `403 {"message":"Forbidden"}`**，访问日志显示状态 403，Lambda 从未被调用 | 账号没有 ICP 备案，默认 `execute-api` URL 的公网访问被拦截。未定义的路由返回 404 | 使用已备案的 `ingress.customDomain`。没有 ICP 时可以用 `npm run e2e:internal` 验证后端 |
| `npm run e2e` 第 4–5 步报 **429** | 紧接着上一次 e2e 运行：第 8 步耗尽了 `/register` 令牌桶，`/authorize` 只允许 2 rps / 突发 5 | 等待约 30 秒后重试 |
| 使用中国区凭证时报 `InvalidClientTokenId` | 没有设置 `AWS_REGION`，STS 请求了 Global 端点 | 设置 `AWS_REGION=cn-north-1` 或 `cn-northwest-1` |
| Docker 构建报 `exec format error` 或 `no match for platform` | 主机无法构建 `linux/arm64` | 使用 ARM64 主机；或在 x86 上安装 QEMU binfmt（`docker run --privileged --rm tonistiigi/binfmt --install arm64`）并使用 `buildx`。在中国区该 binfmt 镜像来自 Docker Hub，经常无法访问，使用 ARM64 构建主机可以避开 |
| 中国区部署拉取基础镜像失败（`not found` / `denied`） | 该区域没有同步基础镜像、digest 不一致，或缺少仓库策略 | 执行 `scripts/mirror-base-image.sh <region>` 并固定打印出的 digest |
| `secret:set-im-app` 报 `ResourceNotFoundException` | 在首次部署之前执行了 | 先部署 |
| `secret:set-im-app` 打印 `<im> rejected the credentials` | 密钥错误，或应用建在了错误的平台（飞书与 Lark） | 用正确的值重新执行 |
| 配置校验错误 | 配置项或取值不合法；错误信息会指出配置项和修正方法 | 修改 `config/deploy.yaml` |
| 部署报错，提到已存在的密钥 `<slug>/...` | 之前同一 slug 的部署留下了待删除的密钥 | 执行 `npm run teardown:extras`，或换一个 slug |
| 工具结果返回 `im_app_not_configured` | 没有写入应用密钥 | `npm run secret:set-im-app` |
| IM 授权页提示重定向 URI 错误 | `CallbackUrl` 没有登记，或主机不一致 | 登记与输出完全一致的 `CallbackUrl` |

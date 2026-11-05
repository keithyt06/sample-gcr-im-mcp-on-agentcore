简体中文 | [English](../en/security.md)

# 安全模型

本页说明信任边界、token 模型、数据存放位置、IAM 结构和已知限制，面向部署本样例的运维人员和审核人员。本样例**不是生产就绪的代码**，用于真实数据之前，请按你自己的要求进行评审。

## 组件与信任边界

```
 MCP 客户端（Kiro、Claude Code、Codex、Cursor、Amazon Quick）
      |  HTTPS, Authorization: Bearer <MCP access token>
      v
 [B1] API Gateway HTTP API（+ 可选自定义域名；AWS Global 可选 CloudFront + WAF）
      |                     路由限流：默认 50 rps / 突发 100，
      |                     POST /register 5/10，GET /authorize 2/5
      +--> oauth Lambda       OAuth 2.1 授权服务器（well-known、DCR、authorize、
      |                       callback、token、企业微信扫码状态）
      +--> middleware Lambda  校验 MCP token，读取用户的 IM 凭证，
               |              SigV4 签名
               v
 [B2] AgentCore Runtime  InvokeAgentRuntime（仅 IAM / SigV4）
               |   每个用户会话一个 microVM（会话 ID = HMAC(userId)）
               v
      容器（MCP 服务，:8000/mcp）--> 厂商 CLI（lark-cli | dws | wecom-cli）
                                        |
 [B3]                                   v  以用户身份走 HTTPS
                                    IM 开放平台（飞书 / Lark / 钉钉 / 企业微信）
```

| 边界 | 跨越边界的内容 | 控制措施 |
|---|---|---|
| B1 公网 → API Gateway | 任意 HTTP 请求 | TLS。MCP token 在 middleware Lambda 中校验。OAuth 端点按设计公开（RFC 8414 / 9728 / 7591）。API Gateway 路由限流。AWS Global 可以加上 `ingress.edge: cloudfront` + `ingress.waf: true`（AWS 托管规则组 + 每 IP 每 5 分钟 1000 次的速率规则）。本样例在 AWS 中国区不提供 CloudFront/WAF，那里唯一的边缘控制是限流 |
| B2 Lambda → AgentCore Runtime | JSON-RPC 请求体 + 自定义请求头（`X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Id`、`-User-Token`、`-Authorize-Url`、`-Request-Id`、`-Caller`） | Runtime 只能通过 SigV4 `InvokeAgentRuntime` 访问，只有 middleware 和 oauth Lambda 的角色有权调用。因此容器**信任这些请求头**。客户端的请求头不会被转发，只转发原始 JSON-RPC 请求体。`Mcp-Session-Id` 在服务端推导，忽略客户端传入的值。以 `im/` 开头的方法会被 middleware 拒绝，容器对这些方法还要求 `Caller: control` |
| B3 容器 → IM | 用户 token（钉钉：`--token` 命令行参数；飞书/Lark：环境变量；企业微信：每个用户的加密配置） | 每次调用都用 `execFile`（不经过 shell）运行 CLI，使用单次调用专用的临时工作目录，环境变量只有 `PATH`、`HOME`、`LANG`、`NO_COLOR` 和适配器变量（没有 `AWS_*`）。参数名只来自工具目录，参数值作为独立的 argv 项传入 |

## Token 模型

| Token | 格式 | 有效期 | 存放位置 |
|---|---|---|---|
| MCP access token | HMAC-SHA256 签名的 `{userId, exp}`（密钥由根密钥派生） | **1 小时** | 只在客户端。无状态校验（每次请求不查数据库） |
| MCP refresh token | 随机值，以 SHA-256 哈希存储 | 90 天，每次使用都轮换；重放会撤销整个 token 族 | DynamoDB `refresh#<hash>` |
| 授权码 | 随机值，哈希存储，一次性，绑定 client_id + redirect_uri + PKCE challenge | 120 秒 | DynamoDB `code#<hash>` |
| DCR `client_id` | HMAC 签名的重定向 URI 列表（无状态，不存储） | 不过期 | 只在客户端 |
| 增量授权 token（在 `authorize_url` 中） | 用单独的密钥做 HMAC 签名，不能当作 access token 使用 | 10 分钟 | 工具结果 |
| 根密钥 | 64 位随机字符，由 CloudFormation 生成 | 直到 Stack 删除 | Secrets Manager `<slug>/root-key`，Lambda 缓存 5 分钟 |

PKCE（仅 S256）是必需的。客户端默认为公共客户端（只用 PKCE）；以 `client_secret_post` / `client_secret_basic` 注册的客户端（用于要求填写 secret 的表单，通过 `npm run register-client`）会获得由根密钥派生的无状态 secret，提交的 secret 必须匹配。重定向 URI 必须是回环地址（`127.0.0.1`、`localhost`、`[::1]`，任意端口）、Amazon Quick 的主机（仅 AWS Global），或 `oauth.extraRedirectHosts` 中的 HTTPS 主机。自定义 URI scheme、锚点和 userinfo 一律拒绝。允许列表在注册时**和** `/authorize` 时都会检查。

### 撤销的生效时间

`npm run users -- revoke <userId>`：
- 对新登录和 refresh token 换发**立即生效**：不会再签发新的 MCP access token。
- **已经签发的 MCP access token 在过期前仍然有效，最长 1 小时。**这是有意的设计：access token 有效期短，校验时不逐次查询数据库。
- middleware 会把用户的 IM 凭证缓存最多 **60 秒**。
- 用户的 IM 凭证密钥会被立即强制删除，缓存过期后 IM 调用随即失败。
- 撤销是永久的，没有"取消撤销"。飞书/Lark/钉钉的 IM 身份仍绑定在已禁用的用户上，所以此人会一直被拒绝。企业微信中被撤销的身份再次扫码会被拒绝。

如需一次性让所有人下线（例如怀疑根密钥泄露），轮换根密钥：对 `<slug>/root-key` 执行 `aws secretsmanager put-secret-value`，写入新的随机值。在 Lambda 5 分钟缓存过期后，所有 access token、refresh token 和 DCR client id 全部失效，所有用户需要重新连接。

## 存储的数据

| 数据 | 存储位置 | 加密 | 保留 |
|---|---|---|---|
| IM 应用密钥（飞书/Lark/钉钉） | Secrets Manager `<slug>/im-app` | AWS 托管密钥 | 随 Stack 删除 |
| HMAC 根密钥 | Secrets Manager `<slug>/root-key` | AWS 托管密钥 | 随 Stack 删除 |
| 每个用户的 IM 凭证（用户 access + refresh token；企业微信为加密的 CLI 配置） | Secrets Manager `<slug>/users/<userId>` | **专用 KMS CMK**（开启轮换） | 运行时创建，`destroy` **不会**删除；请使用 `npm run teardown:extras` |
| OAuth state、授权码、refresh token 哈希、用户记录（`im`、IM 用户 ID、时间戳、`disabled`、`approval`） | DynamoDB 表（按需计费，开启 PITR） | AWS 托管密钥 | 短期数据带 TTL；表随 Stack 删除 |
| 日志 | CloudWatch Logs（Lambda、API 访问日志：30 天；Runtime 日志组由服务创建） | 默认 | Lambda 只记录用户 ID 的哈希，从不记录 token、授权码或密钥 |

KMS CMK 设置了 `RemovalPolicy.RETAIN`，避免误删 Stack 后用户密钥无法解密。`destroy` 之后用 `npm run teardown:extras` 安排删除它。

## IAM 概要

| 角色 | 主要权限 |
|---|---|
| Runtime 执行角色 | 拉取镜像资产的 ECR 权限；`/aws/bedrock-agentcore/runtimes/*` 下的 CloudWatch Logs；仅飞书/Lark：读取 `<slug>/im-app`；仅企业微信：对 `<slug>/users/*` 下的密钥 get/put/create（只能用本 Stack 的 CMK）和打标签（只允许 `WecomUserId` 标签键），以及用 CMK 加解密。**没有 `bedrock:InvokeModel`。**信任策略：`bedrock-agentcore.amazonaws.com`，带 `aws:SourceAccount` 和 `aws:SourceArn` 条件 |
| oauth Lambda | 读取根密钥和 IM 应用密钥；`<slug>/users/*` 下的用户密钥；CMK；DynamoDB 表；base-URL SSM 参数；仅企业微信：对本 Runtime 的 `InvokeAgentRuntime` |
| middleware Lambda | 读取根密钥，以及（重定向类 IM）用户密钥 + CMK 解密；对本 Runtime 的 `InvokeAgentRuntime`；base-URL SSM 参数 |
| refresh Lambda（飞书/Lark/钉钉） | `*` 上的 `secretsmanager:ListSecrets`；`<slug>/users/*` 下的 get/put/describe/delete；读取 IM 应用密钥；CMK |
| alarm Lambda（可选） | 对配置的 webhook 参数的 `ssm:GetParameter` |

`Resource: "*"` 只用于 `ecr:GetAuthorizationToken` 和 `secretsmanager:ListSecrets`，这两个操作不支持资源级权限（见 [Service Authorization Reference](https://docs.aws.amazon.com/service-authorization/latest/reference/)）。refresh Lambda 在代码中按名称前缀过滤。

## 威胁与缓解措施

| 威胁 | 缓解措施 / 现状 |
|---|---|
| **企业微信扫码钓鱼与跨租户访问。**企业微信扫码流程没有租户边界：任何组织中有企业微信账号的人都能完成授权。你把扫码链接发给谁，谁就会以**他自己**的身份授权给**你的** MCP 客户端，费用记在你的 AWS 账单上。反过来，攻击者也可以把自己部署的扫码页发给受害者 | 设置 `wecom.requireApproval: true`（新用户需要等待 `npm run users -- approve`）。待审批用户永远拿不到 token。提醒用户只扫自己从自己的 MCP 客户端发起的二维码 |
| 匿名客户端发起大量企业微信扫码会话（每个最长占用一个 microVM 300 秒） | `GET /authorize` 路由限流（2 rps / 突发 5）、`wecom.maxPendingQr` 全局上限（默认 20）和单 IP 3 个的上限 |
| IM 内容中的提示注入诱导智能体执行破坏性工具 | 破坏性工具（`delete`、`remove`、`recall`、`revoke`、`transfer_owner` 等）要求 `_confirm: true`。**这个标志由 LLM 自己设置**，所以它只是减速带，依赖客户端和用户审查工具调用，并不是安全控制。请使用调用工具前会询问用户的客户端 |
| 提示注入诱导 CLI 启动进程 | 带进程或守护进程参数（`--agent-cmd`、`--daemon`、`--yolo` 等）的命令，以及钉钉 `dingtalk-tag connect*` / `manage login`，在工具目录中标记为不可用。企业微信返回结果中的 `extra_identity_context` 文本会被剥离 |
| Runtime 内的跨用户访问 | 每个用户会话一个 microVM。用户 ID 从不用于文件路径。单次调用的临时目录在调用后删除 |
| **企业微信 Runtime 角色可以读取所有企业微信用户的密钥**（已知限制） | 所有 microVM 共用一个执行角色，AgentCore 不会把会话级身份传给 IAM，因此无法把访问限定到单个用户的密钥。如果某个用户的 `wecom-cli` 调用出现代码执行漏洞，可能读取其他企业微信用户的凭证。缓解措施是上面收窄过的角色和进程参数禁用列表。飞书/Lark/钉钉的 Runtime 无权访问用户密钥（token 随请求传入） |
| 错误信息或日志中泄露 token | CLI 执行器从不把命令行放进错误文本（钉钉的 token 在 argv 中）。Lambda 只记录 `hashUserId` |
| 厂商 CLI 的供应链 | CLI 版本固定在 `shared/versions.ts`。解包前用 `container/build/cli-integrity.json` 校验每个 tarball 的 sha512，不会对传递依赖执行 `npm install`。基础镜像以 digest 固定。中国区的包来自第三方镜像 npmmirror，同样经过完整性校验 |
| 钉钉 refresh 出错导致用户凭证被清空 | 只有明确表示授权已撤销的错误才会删除用户凭证；应用凭证错误、429、5xx 和未知错误码都按临时错误处理 |
| 中国区公网端点 | 没有 ICP 备案时，从公网访问默认 URL 返回 403。请使用已备案的自定义域名 |

## 报告安全问题

见 [CONTRIBUTING.md](../../CONTRIBUTING.md#security-issue-notifications)。请不要创建公开的 GitHub issue。

简体中文 | [English](../en/testing.md)

# 测试

分三层：

1. **自动化测试**（不需要 AWS 和 IM）：`npm test`。
2. **基础设施端到端测试**，针对已部署的 Stack，不需要 IM 凭证：`npm run e2e`；没有 ICP 备案的 AWS 中国区用 `npm run e2e:internal`。
3. **真实租户手工检查清单**（G2b），由仓库所有者使用真实的 IM 应用和真实用户执行。

## 1. 自动化测试

```bash
npm ci
npm run build          # tsc 类型检查
npm test               # vitest：infra、lambda、container
npm run synth:matrix   # 只跑 synth 矩阵
```

| 测试套件 | 覆盖内容 |
|---|---|
| `test/infra/config.test.ts` | 每条配置校验规则、默认值、由 `region` 推导分区、拒绝看起来像密钥的配置项 |
| `test/infra/matrix.test.ts` | 合成 4 个 IM × 2 个分区（以及 CloudFront/WAF、自定义域名变体）并断言：AWS 中国区模板中没有 `arn:aws:` 字面量和 CloudFront/WAF、Runtime 信任主体、请求头允许列表、没有 `bedrock:InvokeModel`、MCP 协议、路由限流、只有重定向类 IM 才有 refresh Lambda 和 IM 应用密钥 |
| `test/infra/iam.test.ts`、`nag.test.ts`、`partition.test.ts` | IAM `*` 允许列表、cdk-nag AwsSolutions、分区工具函数 |
| `test/lambda/*` | OAuth 授权服务器（well-known、DCR、authorize、callback、token、refresh 轮换与重放）、企业微信扫码流程（审批、撤销、身份槽替换）、middleware、token 加密、DynamoDB 存储、IM 适配器、refresh Lambda、alarm Lambda |
| `test/container/*` | 使用假 CLI（`test/container/fakes/`）测试 MCP 服务：tools/list、discover/invoke、`_confirm` 确认、各 IM 的 argv、环境变量隔离、错误映射、企业微信凭证回写和授权流程、工具目录一致性 |
| `test/container/dws-isolation.test.ts` | 默认跳过。使用**真实**的 `dws` 程序，两个用户交替调用，每次都必须带上自己的 Bearer token。升级 `dws` 版本前必须通过 |

用真实 CLI 运行钉钉隔离测试（`npm run gen:catalog` 会把 CLI 安装到 `.cache/cli/`）：

```bash
DWS_REAL=1 DWS_BIN=.cache/cli/dingtalk/node_modules/dingtalk-workspace-cli/vendor/dws \
  npx vitest run test/container/dws-isolation.test.ts
```

## 2. 基础设施端到端测试（不需要 IM 凭证）

`npm run deploy` 之后执行：

```bash
npm run e2e -- -c config=config/deploy.yaml
# 或：npm run e2e -- --stack ImMcp-<slug> --region <region>
```

脚本读取 Stack 输出，执行 8 项检查，逐项打印 PASS/FAIL，任何一项失败都以非零码退出：

| # | 检查 | 预期 |
|---|---|---|
| 1 | `GET /.well-known/oauth-authorization-server` | 200，`issuer` = `BaseUrl` |
| 2 | `GET /.well-known/oauth-protected-resource/mcp` | 200，`resource` = `McpUrl` |
| 3 | 不带 token 的 `POST /mcp` | 401，带 `WWW-Authenticate: Bearer resource_metadata="…"` |
| 4 | `POST /register`（DCR，回环重定向） | 201，返回 `client_id` |
| 5 | 带 PKCE 的 `GET /authorize` | 飞书/Lark/钉钉：302 跳转到 IM 登录主机。企业微信：200 HTML，含二维码（验证 Lambda → Runtime 的控制 RPC） |
| 6 | 用签发的测试 token 调用 `initialize`、`tools/list` | 200；工具名 = `<im>_` + tier 1，再加 `<im>_discover` 和 `<im>_invoke` |
| 7 | 对一个 tier-1 工具执行 `tools/call` | `isError: true`，错误码 `im_not_authorized`（测试用户没有 IM 凭证） |
| 8 | 并发 40 个 `POST /register` | 至少一个 429（路由限流） |

第 6 步使用 `npm run mint-test-token` 的逻辑：从 Secrets Manager 读取根密钥，为固定的测试用户 `e2e00000000000000000000000000000` 签发 token。它只是测试辅助工具，不要分享它的输出。

**两次 e2e 之间请等待约 30 秒。**第 8 步会故意耗尽 `/register` 的令牌桶，`GET /authorize` 的限流也很严格（2 rps / 突发 5）。紧接着上一次运行时，第 4–5 步可能因 429 失败。

### 没有 ICP 备案的 AWS 中国区：`e2e:internal`

在没有 ICP 备案的 AWS 中国区账号中，默认 `execute-api` URL 的所有路由都返回 `403 {"message":"Forbidden"}`，Lambda 根本不会被调用，所以 `npm run e2e` 结果是 0/8。请改用：

```bash
AWS_PROFILE=<your-china-profile> AWS_REGION=cn-northwest-1 \
  npm run e2e:internal -- -c config=config/deploy.yaml
```

它用模拟的 API Gateway 事件直接调用 oauth 和 middleware Lambda，执行第 1–7 步。middleware 仍然用 SigV4 调用 AgentCore Runtime，所以完整覆盖了后端链路。第 8 步需要真实的入口，因此跳过。需要对这两个函数的 `lambda:InvokeFunction` 权限，以及根密钥的读取权限。

### 测试状态

| IM | 分区 / 区域 | `npm run e2e` | `npm run e2e:internal` |
|---|---|---|---|
| feishu | AWS Global / ap-northeast-1 | 8/8 | 不适用 |
| dingtalk | AWS Global / ap-northeast-1 | 8/8 | 不适用 |
| wecom | AWS Global / ap-northeast-1 | 8/8 | 不适用 |
| feishu | AWS 中国区 / cn-northwest-1 | 0/8（无 ICP 返回 403，符合预期） | 7/7 |
| lark | （仅 synth 矩阵） | 未部署 | 未部署 |
| dingtalk、wecom | AWS 中国区（仅 synth 矩阵） | 未部署 | 未部署 |

以上只是基础设施层面的测试，没有使用真实的 IM 应用凭证。第 3 节是真实租户测试。

### 可选：用 AgentCore CLI 直接冒烟测试 Runtime

可以用 [AgentCore CLI](https://github.com/aws/agentcore-cli)（`npm install -g @aws/agentcore`）绕过 API Gateway 和 Lambda 直接调用 Runtime。Runtime ID 是 Stack 输出 `RuntimeArn` 的最后一段。

```bash
agentcore runtime invoke --id <runtime-id> \
  --mcp-method tools/list \
  --payload '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

这只能检查容器能否启动并列出工具。调用工具需要 middleware 添加的自定义用户请求头，所以 `tools/list` 以外的检查请用 `npm run e2e`。这一步是可选的，不在上面的测试路径中，也没有验证它在 AWS 中国区是否可用。

## 3. 真实租户手工检查清单（G2b）

由仓库所有者使用真实的 IM 应用，在同一租户中至少准备**两个真实用户（A 和 B）**，针对一个 `npm run e2e`（或 `e2e:internal`）已通过的部署执行。每一行都记录日期、commit、区域、IM、客户端和结果。其中多步会写入真实的消息和文档，请使用测试租户或测试数据。

### 所有 IM 通用

| # | 步骤 | 通过条件 |
|---|---|---|
| C1 | 把 `McpUrl` 添加到 Claude Code（`claude mcp add --transport http <name> <McpUrl>`）和 Kiro | 客户端打开浏览器授权，不需要填写 client ID |
| C2 | 用户 A 授权 | 工具加载成功；`tools/list` 显示 tier 1 + `<im>_discover` + `<im>_invoke` |
| C3 | 用户 A 调用一个读工具（例如"列出我今天的日程"） | 返回 A 的真实数据 |
| C4 | 用户 A 给自己（或测试群）发一条消息 | 消息以 A 的身份出现在 IM 中 |
| C5 | 用户 A 要求删除或撤回某个内容 | 第一次调用返回 `user_approval_required`；只有用户确认、智能体带 `_confirm: true` 重试后才执行 |
| C6 | 用关键词调用 `<im>_discover`，再用 `<im>_invoke` 调用一个非 tier-1 工具 | 调用成功，或返回带 `authorize_url` 的 `missing_scope` |
| C7 | 用户 B 在第二个客户端中授权 | B 的读工具返回 B 的数据，绝不会返回 A 的 |
| C8 | `npm run users -- list` | A 和 B 都显示为 `active` |
| C9 | `npm run users -- revoke <A>` | 60 秒内 A 的工具调用失败；A 的 refresh 失败；1 小时内 A 现有的 access token 失效；A 重新授权被拒绝。B 不受影响 |
| C10 | 客户端闲置超过 1 小时后调用工具 | 客户端静默刷新 MCP token |
| C11 | 仅 Global：用 **Default OAuth app** 连接 Amazon Quick（[教程](client-amazon-quick.md)） | 授权成功并列出工具（已用飞书和钉钉在 ap-southeast-1 验证） |
| C12 | 中国区使用已备案的自定义域名：通过自定义域名重复 C1–C4 | 结果相同 |

### 飞书 / Lark

| # | 步骤 | 通过条件 |
|---|---|---|
| F1 | 从用户授权中去掉一个 scope（或设置较短的 `im.feishu.scopes`），调用需要它的工具 | 返回 `missing_scope`；打开 `authorize_url` 授予后重试成功 |
| F2 | 等待超过 2 小时（用户 token 有效期），再调用工具 | 无需重新授权即成功（refresh Lambda 每 30 分钟运行） |
| F3 | 创建文档、追加内容、搜索该文档 | 三步都以用户身份成功 |
| F4 | Lark：在 open.larksuite.com 上用 `im: lark` 重复 C2–C4 | 结果相同 |

### 钉钉

| # | 步骤 | 通过条件 |
|---|---|---|
| D1 | 管理员开通 CLI 访问之前调用工具 | 返回 `im_admin_action_required` |
| D2 | 开通后，用户 A 和 B **交替**各调用 10 次（例如 `contact_user_get_self`） | 每次结果都是调用者本人的资料（两个用户的 token 隔离） |
| D3 | 等待超过 2 小时后调用工具 | 成功（服务端刷新） |
| D4 | 调用一个应用缺少权限的工具 | 返回带 `required_scopes` 的 `missing_scope` |
| D5 | 通过 `dingtalk_invoke` 请求 `dingtalk-tag connect` | 被拒绝：该工具不可用 |

### 企业微信

| # | 步骤 | 通过条件 |
|---|---|---|
| W1 | 开启 `wecom.requireApproval: true`，用户 A 扫码并新建机器人 | 页面显示"正在等待管理员审批"；客户端拿不到 token |
| W2 | 执行 `npm run users -- list`，然后 `approve <A>`；A 重新连接 | A 的工具可用 |
| W3 | A 之后重新连接，选择**绑定已有机器人** | 不需要重新审批；之前创建的文档仍然可写 |
| W4 | A 对一个在企业微信客户端里（而非机器人）创建的文档调用 `doc_contents_append` | 返回 `im_object_permission`（851003） |
| W5 | 在成员超过 10 人的企业中读取聊天消息 | 返回 `im_policy_blocked`（853006） |
| W6 | 7 天后调用工具 | 返回 `im_grant_expired`（850003），`grant-expired` 告警触发（设置了 webhook 时也会发送）。A 在企业微信客户端续期后，无需扫码即可调用成功 |
| W7 | `revoke <A>`；A 再次扫码 | 页面提示访问已被撤销 |
| W8 | 同一 IP 打开 3 个以上授权页且都不扫码 | 第 4 个返回 429 |

## 测试后清理

```bash
npm run destroy -- -c config=config/deploy.yaml
npm run teardown:extras -- -c config=config/deploy.yaml
```

剩余资源见 [deploy.md](deploy.md#清理)。

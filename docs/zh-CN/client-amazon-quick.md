简体中文 | [English](../en/client-amazon-quick.md)

# 接入 Amazon Quick（仅 AWS Global 区域）

Amazon Quick 在 AWS 中国区不可用。中国区请使用 Kiro、Claude Code、Codex 或 Cursor。

## 准备工作

- Stack 已部署，并已用 `npm run secret:set-im-app` 写入 IM 应用密钥（见[部署指南](deploy.md)）。
- Stack 输出 `CallbackUrl` 已登记到 IM 开发者后台（飞书/Lark：**安全设置 → 重定向 URL**）。
- 你有 Amazon Quick Enterprise 订阅。

只需要 Stack 的一个输出值：**`McpUrl`**（`<base>/mcp`），获取方式：

```bash
aws cloudformation describe-stacks --stack-name ImMcp-<slug> --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='McpUrl'].OutputValue" --output text
```

## 认证原理

服务端自带 OAuth 2.1 授权服务器，支持**动态客户端注册（DCR）**，Amazon Quick 会自动发现：

1. Quick 向 `McpUrl` 发送未认证请求，收到 `401` 和 `WWW-Authenticate: Bearer resource_metadata=...`。
2. Quick 读取 `<base>/.well-known/oauth-protected-resource`，再读取 `<base>/.well-known/oauth-authorization-server`。
3. Quick 通过 `<base>/register`（DCR）自行注册。它的回调域名 `*.quicksight.aws.amazon.com` 在 AWS Global 区域默认放行。
4. 用户连接时，Quick 打开 `<base>/authorize`，再跳转到 IM 登录（飞书/Lark/钉钉 OAuth，或企业微信扫码页）。用户以**本人身份**登录。

你**不需要**填写 Client ID、Client Secret、Token URL 或 Authorization URL。因为支持 DCR，Quick 不会要求填写这些字段。

## 步骤

1. 在 Amazon Quick 控制台打开 **Connectors** → **Create for your team** → **Model Context Protocol (MCP)**。
2. 在 **Create Integration** 页面填写：
   - **Name**：例如 `Feishu`。
   - **Description**（可选）。
   - **MCP server endpoint**：`McpUrl` 的值。
   - **Connection type**：**Public network**。
   - **Auth server connection type**：**Public network**。
3. 点击 **Next**，选择 **User authentication (OAuth)**。Quick 会通过 DCR 自动注册。
4. 点击 **Create and continue**，Quick 会打开登录页。用你的 IM 账号登录并同意所申请的权限。
5. 检查自动发现的工具（actions），点击 **Next**。如有需要可以把集成共享给其他用户；每个使用者都用自己的 IM 账号登录。

## 说明与限制

| 项目 | 说明 |
|---|---|
| 工具数量 | Quick 每个连接最多注册 100 个工具。本服务列出 28–34 个工具（tier 1 加 `<im>_discover` / `<im>_invoke`）。 |
| 超时 | Quick 的 MCP 调用 5 分钟超时。本服务的工具调用约 25 秒超时。 |
| 新工具 | 自定义 connector 不会自动同步。升级服务端后，打开 connector 点击 **Sync**。 |
| 缺少 IM 权限 | 工具结果返回 `missing_scope` 和 `authorize_url`。在 IM 后台开通权限、发布新版本后，打开该链接（或重新连接 connector）。Quick 本身不支持增量授权。 |
| 会话 | MCP access token 有效期 1 小时，Quick 用轮换的 refresh token（90 天）自动续期。IM token 由服务端每 30 分钟刷新。 |

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| Quick 提示无法注册客户端 | 回调域名未放行（例如不在 `*.quicksight.aws.amazon.com` 下的 Quick 域名） | 把该域名加到 `oauth.extraRedirectHosts` 后重新部署 |
| IM 登录页提示重定向错误（飞书错误码 **20029**） | IM 后台未登记 `CallbackUrl` | 登记回调地址（见对应 IM 的配置指南） |
| 登录成功，但所有工具返回 `im_app_not_configured` | 从未写入 IM 应用密钥 | 执行 `npm run secret:set-im-app` |
| 发布时提示 `Creation failed` | 某个工具的 `inputSchema` 不合法 | 带上工具名提 issue；本服务的 schema 为 JSON Schema draft 7 |

官方文档：[MCP integration in Amazon Quick](https://docs.aws.amazon.com/quick/latest/userguide/mcp-integration.html)。

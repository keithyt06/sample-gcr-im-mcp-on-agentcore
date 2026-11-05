简体中文 | [English](../en/client-amazon-quick.md)

# 接入 Amazon Quick（仅 AWS Global 区域）

Amazon Quick 在 AWS 中国区不可用。中国区请使用 Kiro、Claude Code、Codex 或 Cursor。

## 准备工作

- Stack 已部署，并已用 `npm run secret:set-im-app` 写入 IM 应用密钥（见[部署指南](deploy.md)）。
- Stack 输出 `CallbackUrl` 已登记到 IM 开发者后台（飞书/Lark：**安全设置 → 重定向 URL**）。不登记的话 IM 登录会失败（飞书错误码 **20029**）。
- 你有 Amazon Quick Enterprise 订阅。

获取 MCP 端点（Stack 输出 `McpUrl`，即 `<base>/mcp`）：

```bash
aws cloudformation describe-stacks --stack-name ImMcp-<slug> --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='McpUrl'].OutputValue" --output text
```

## 认证原理

服务端自带 OAuth 2.1 授权服务器，Quick 从 MCP 端点自动发现：

1. `GET <base>/mcp` → `401`，响应头 `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<base>/.well-known/oauth-protected-resource"`。
2. `<base>/.well-known/oauth-protected-resource` → 授权服务器为 `<base>`，`scopes_supported: ["mcp", "offline_access"]`。
3. `<base>/.well-known/oauth-authorization-server` → `authorize`、`token` 和 `registration_endpoint`（`<base>/register`），`token_endpoint_auth_methods_supported: ["none", "client_secret_post"]`。
4. Quick 自动注册（动态客户端注册，DCR），或使用你填写的 Client ID。它的回调域名 `*.quicksight.aws.amazon.com` 在 AWS Global 区域默认放行。
5. 用户连接时，`<base>/authorize` 跳转到 IM 登录（飞书/Lark/钉钉 OAuth，或企业微信扫码页）。每个用户以**本人身份**登录。

Quick 只从元数据文档读取 scope，不读 401 响应里的 scope。因此两份元数据都声明了 `mcp` 和 `offline_access`，确保 Quick 申请的是服务端认识的 scope。

## 方式 A：动态注册（先试这个）

1. 在 Amazon Quick 打开 **Connectors** → **Create for your team** → **Model Context Protocol**。如果提示已有 MCP connector，选择 **No, create new**。
2. **Connect** 步骤：
   - **Name**：例如 `Feishu`。**Description**（可选）。
   - **MCP server endpoint**：`McpUrl` 的值。
   - **Connection type**：**Public network**。**Auth server connection type**（如果有）：**Public network**。
   - 点击 **Next**。
3. **Authenticate** 步骤：选择 **User authentication**。
   - 如果页面**没有**要求填写 Client ID / Client secret，说明 Quick 会自动注册。点击 **Create and continue**，进入第 4 步。
   - 如果表单**要求必填** Client ID / Client secret / Token URL / Authorization URL，改用下面的**方式 B** 填写。
4. 浏览器弹出 IM 登录页，登录并同意授权，页面显示 "Returning to Quick"。
5. **Review**：Quick 列出发现的工具（28–34 个），点击 **Next**。
6. **Publish**：选择谁可以使用该 connector（仅自己，或组织内所有人），点击 **Publish**。每个使用者第一次使用时都用自己的 IM 账号登录。

## 方式 B：手动客户端（表单要求填写 Client ID 时）

1. 在部署机上为 Quick 注册一个客户端：

   ```bash
   npm run register-client -- -c config=config/deploy.yaml
   ```

   输出（每行对应一个表单字段）：

   ```
   MCP server endpoint      https://<base>/mcp
   Client ID                c1.eyJ...
   Client secret            <secret>
   Token URL                https://<base>/token
   Authorization URL        https://<base>/authorize
   Redirect URL (allowed)   https://<region>.quicksight.aws.amazon.com/sn/oauthcallback
                            https://us-east-1.quicksight.aws.amazon.com/sn/oauthcallback
   ```

2. 对比 Quick 表单中的 **Redirect URL**（只读，通常是 `https://us-east-1.quicksight.aws.amazon.com/sn/oauthcallback`）与允许列表。如果不在列表中，加上 `--redirect-uri <Quick 显示的地址>` 重新执行（可重复，最多 5 个），并使用新输出的值。
3. 填写 Quick 表单：

   | Quick 字段 | 值 |
   |---|---|
   | Client ID | 输出中的 `Client ID` |
   | Public OAuth client | 不勾选 |
   | Client secret | 输出中的 `Client secret` |
   | Token URL | 输出中的 `Token URL` |
   | Authorization URL | 输出中的 `Authorization URL` |

4. 点击 **Create and continue**，之后按方式 A 的第 4–6 步继续。

说明：
- `--public` 注册公共客户端（在 Quick 中勾选 **Public OAuth client**，Client secret 留空）。
- Client secret 属于凭证：只粘贴到 Quick 中，不要提交或分享。它由 Stack 的根密钥派生，服务端不保存；轮换根密钥（`<slug>/root-key`）会使所有客户端和所有 MCP token 失效。
- 一个客户端可以给所有 Quick 用户共用，用户仍然各自登录。

## 说明与限制

| 项目 | 说明 |
|---|---|
| 工具数量 | Quick 每个连接最多注册 100 个工具。本服务列出 28–34 个工具（tier 1 加 `<im>_discover` / `<im>_invoke`）。 |
| 超时 | Quick 的 MCP 调用 5 分钟超时。本服务的工具调用约 25 秒超时。 |
| 新工具 | 自定义 connector 不会自动同步。升级服务端后，打开 connector 点击 **Sync**。 |
| 缺少 IM 权限 | 工具结果返回 `missing_scope` 和 `authorize_url`。在 IM 后台开通权限、发布新版本后，打开该链接（或重新连接 connector）。Quick 本身不支持增量授权。 |
| 会话 | MCP access token 有效期 1 小时，Quick 用轮换的 refresh token（90 天）续期。服务端每 30 分钟刷新一次 IM token。 |

## 常见问题

查看 API 访问日志（`/aws/apigateway/im-mcp-<slug>-access`）可以知道 Quick 走到了哪一步。一次 Quick 接入依次是：`GET /mcp 401` → 两份 `.well-known` 文档 → `POST /register`（仅方式 A）→ `GET /authorize` → `POST /token`。

| 现象 | 原因 | 处理 |
|---|---|---|
| 服务端已声明 DCR，表单仍要求 Client ID | 当前 Quick 控制台版本在该表单不使用 DCR | 使用方式 B |
| 换取 token 时报 `invalid_client` | Client secret 填错，或客户端是在另一个 Stack 上注册的 | 对当前 Stack 重新执行 `npm run register-client` 并重新粘贴 |
| 登录页提示 redirect URI 未注册 | Quick 的 Redirect URL 不在该客户端的列表中 | `npm run register-client -- --redirect-uri <Quick 的 Redirect URL>` |
| DCR 被拒绝 | Quick 的回调域名不在 `*.quicksight.aws.amazon.com` 下 | 把它加到 `oauth.extraRedirectHosts` 后重新部署 |
| IM 登录页提示重定向错误（飞书 **20029**） | IM 后台未登记 `CallbackUrl` | 登记回调地址（见对应 IM 的配置指南） |
| 登录成功，但所有工具返回 `im_app_not_configured` | 从未写入 IM 应用密钥 | 执行 `npm run secret:set-im-app` |
| 发布时提示 `Creation failed` | 某个工具的 `inputSchema` 不合法 | 带上工具名提 issue；本服务的 schema 为 JSON Schema draft 7 |

官方文档：[MCP integration in Amazon Quick](https://docs.aws.amazon.com/quick/latest/userguide/mcp-integration.html)。

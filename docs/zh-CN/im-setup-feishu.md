简体中文 | [English](../en/im-setup-feishu.md)

# 飞书应用配置（`im: feishu`）

飞书（国内版，open.feishu.cn）与 Lark（国际版，open.larksuite.com）是**两个独立的平台**，在一个平台创建的应用不能在另一个平台使用。如果你的租户在 Lark 上，请看 [im-setup-lark.md](im-setup-lark.md)。

部署不会替你创建应用。第 1–5 步在**部署前**完成，第 6 步在**首次部署后**完成，因为回调 URL 要等 Stack 部署出来才有。

开发者后台：https://open.feishu.cn/app

## 1. 创建企业自建应用

1. 用租户内有权限创建应用的账号登录开发者后台。
2. 点击**创建企业自建应用**，填写名称、描述和图标，点击**创建**。

## 2. 获取 App ID 和 App Secret

应用 → **凭证与基础信息**：
- **App ID**（形如 `cli_xxxxxxxx`）→ 配置项 `im.feishu.appId`
- **App Secret** → **不要**写进配置文件，执行：

```bash
npm run secret:set-im-app
# 提示输入密钥（不回显），写入 Secrets Manager <slug>/im-app = {"appId": "...", "appSecret": "..."}
```

## 3. 开通权限

应用 → **权限管理** → **批量导入/导出**（以控制台为准，界面可能变化）→ 粘贴 scope JSON。

- 本项目**只使用用户身份**，所有 scope 放在 `user` 下，`tenant` 留空。
- **建议一次性开通所有可能用到的权限。** 用户只能授予控制台里已经开通的权限。开通权限不会扩大用户首次授权时看到的范围，首次授权范围由 `im.feishu.scopes` 决定。
- **必须开通 `offline_access`**：服务端需要 refresh token 才能持续刷新用户 token。

Tier-1 工具依赖的最小集合（来自飞书参考样例）：

| 功能 | 权限 |
|---|---|
| token 刷新 | `offline_access` |
| 用户基本信息 | `contact:user.base:readonly` |
| 读取日历 | `calendar:calendar:read`、`calendar:calendar.event:read` |
| 搜索 / 读取消息 | `im:message:readonly`、`im:chat:read`、`search:message` |
| 以用户身份发消息 | `im:message.send_as_user` |
| 搜索文档 | `search:docs:read`、`space:document:retrieve` |
| 多维表格读写 | `base:record:read`、`base:record:create`、`base:record:update` |

覆盖全部工具的批量导入列表会放在仓库里（路径待定，见产品规格 OQ-4）。

配置项 `im.feishu.scopes`：**首次**授权时申请的 scope（尽量少）。低频工具在首次使用时，会通过增量授权链接申请更多权限。

## 4. 设置可用范围

应用 → **可用范围**：限定为需要使用本服务的部门或成员。**只有可用范围内的成员才能完成授权。**决定谁能接入的是可用范围，而不是任何密钥。

## 5. 发布版本

应用 → **版本管理与发布** → 创建版本 → 提交，由租户管理员审批。**之后每次修改权限都要重新发布版本。**

## 6. 部署后：登记回调 URL

部署输出会打印 `<base>/callback`，`<base>` 是 `https://<ingress.customDomain>` 或 API Gateway URL。

应用 → **安全设置** → **重定向 URL** → 粘贴 `<base>/callback` → **添加**。

- 填写完整路径，查询参数（`?…`）和锚点（`#…`）不用填。
- 之后如果新增或更改了 `ingress.customDomain`，也要登记新的回调 URL。

然后把 MCP 端点 `<base>/mcp` 发给用户。

## 配置与密钥对照

| 值 | 位置 |
|---|---|
| `im: feishu` | `config/deploy.yaml` |
| App ID | `im.feishu.appId` |
| 首次授权 scope | `im.feishu.scopes`（列表） |
| App Secret | `npm run secret:set-im-app` → Secrets Manager `<slug>/im-app` `{appId, appSecret}` |
| 回调 URL | 飞书后台 → 安全设置 → 重定向 URL |

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 授权页报 **20029**，或返回 `redirect_uri unmatch` | 回调 URL 没有登记，或登记在了错误的平台（Lark 而不是飞书） | 执行第 6 步，逐字核对 URL，包括 `https://` 和 `/callback` |
| 用户无法授权 / 提示"无权使用该应用" | 用户不在**可用范围**内，或版本还没审批通过 | 第 4–5 步 |
| 工具返回 "permission denied" 或缺少 scope | 控制台没开通该权限，或用户从未授予过 | 开通权限并发布新版本，用户打开工具结果里的增量授权链接（或重新连接） |
| 部署提示应用凭证无效 | App ID / App Secret 填错，或应用是在 Lark 上创建的 | 重新执行 `npm run secret:set-im-app`，并确认 `im` 与平台一致 |
| 用了几天后会话失效 | 没开通 `offline_access`，拿不到 refresh token | 开通并发布，用户重新连接 |

## 能力边界

- 只以已登录用户的身份操作，不提供机器人消息、群发或事件订阅。
- 权限变更要等新版本发布**并且**用户授予新权限后，才会对已接入的用户生效。
- 飞书应用不能服务 Lark 租户，反之亦然。

官方文档：[配置重定向 URL](https://open.feishu.cn/document/uYjL24iN/uYjN3QjL2YzN04iN2cDN)

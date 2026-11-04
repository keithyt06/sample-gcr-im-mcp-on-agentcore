简体中文 | [English](../en/im-setup-lark.md)

# Lark 应用配置（`im: lark`）

Lark（国际版，open.larksuite.com）与飞书（国内版，open.feishu.cn）是**两个独立的平台**，在一个平台创建的应用不能在另一个平台使用。如果你的租户在飞书上，请看 [im-setup-feishu.md](im-setup-feishu.md)。

第 1–5 步在**部署前**完成，第 6 步在**首次部署后**完成。

开发者后台：https://open.larksuite.com/app

## 1. 创建自建应用

登录开发者后台 → **Create Custom App** → 填写名称、描述和图标 → **Create**。

## 2. 获取 App ID 和 App Secret

应用 → **Credentials & Basic Info**：
- **App ID**（`cli_xxxxxxxx`）→ 配置项 `im.lark.appId`
- **App Secret** → 执行 `npm run secret:set-im-app`，写入 Secrets Manager `<slug>/im-app` = `{"appId": "...", "appSecret": "..."}`。不要写进配置文件。

## 3. 开通权限

应用 → **Permissions & Scopes** → **Import/Export**（以控制台为准，界面可能变化）→ 粘贴 scope JSON。

- 只使用用户身份：所有 scope 放在 `user` 下，`tenant` 留空。
- **必须开通 `offline_access`**（用于 refresh token）。
- scope 名称与飞书相同。部分 scope 在 Lark 上可能不存在，批量导入时会报"权限不存在"，删掉这些条目后重新导入即可（以控制台为准，界面可能变化）。

Tier-1 工具使用的最小集合：

| 功能 | 权限 |
|---|---|
| token 刷新 | `offline_access` |
| 用户基本信息 | `contact:user.base:readonly` |
| 读取日历 | `calendar:calendar:read`、`calendar:calendar.event:read` |
| 搜索 / 读取消息 | `im:message:readonly`、`im:chat:read`、`search:message` |
| 以用户身份发消息 | `im:message.send_as_user` |
| 搜索文档 | `search:docs:read`、`space:document:retrieve` |
| 多维表格读写 | `base:record:read`、`base:record:create`、`base:record:update` |

配置项 `im.lark.scopes`：首次授权时申请的 scope。

## 4. 设置可用范围

应用 → **Availability**：限定为需要使用本服务的成员。只有可用范围内的成员才能授权。

## 5. 发布版本

应用 → **Version Management & Release** → 创建 → 提交管理员审批。每次修改权限都要发布新版本。

## 6. 部署后：登记回调 URL

部署输出 → `<base>/callback`。应用 → **Security Settings** → **Redirect URLs** → 粘贴 → **Add**。填写完整路径，查询参数和锚点可以不填。

把 `<base>/mcp` 发给用户。

## 配置与密钥对照

| 值 | 位置 |
|---|---|
| `im: lark` | `config/deploy.yaml` |
| App ID | `im.lark.appId` |
| 首次授权 scope | `im.lark.scopes` |
| App Secret | `npm run secret:set-im-app` → `<slug>/im-app` `{appId, appSecret}` |
| 回调 URL | Lark 后台 → Security Settings → Redirect URLs |

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `redirect_uri unmatch` / 错误码 20029 | 回调 URL 没有登记，或登记在了飞书而不是 Lark | 在 open.larksuite.com 上执行第 6 步 |
| 批量导入失败："权限不存在" | Lark 上没有该 scope | 删掉这些条目后重新导入 |
| 用户无法授权 | 不在可用范围内，或版本还没审批通过 | 第 4–5 步 |
| 工具提示缺少 scope | 没开通该权限，或用户没有授予 | 开通并发布，用户通过链接重新授权 |

## 能力边界

- 只以用户身份操作，不提供机器人、群发或事件订阅。
- 支持把 `im: lark` 部署到 AWS 中国区，但从中国区访问 Lark 国际端点要跨境，延迟和可达性取决于你的网络环境（本样例不做优化）。

官方文档：[Configure redirect URLs](https://open.larksuite.com/document/server-docs/getting-started/authen-v1/redirect-urls)

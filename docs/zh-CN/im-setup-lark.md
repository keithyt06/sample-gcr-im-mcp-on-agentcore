简体中文 | [English](../en/im-setup-lark.md)

# Lark 应用配置（`im: lark`）

Lark（国际版，open.larksuite.com）与飞书（国内版，open.feishu.cn）是**两个独立的平台**，在一个平台创建的应用不能在另一个平台使用。如果你的租户在飞书上，请看 [im-setup-feishu.md](im-setup-feishu.md)。

第 1–5 步在**部署前**完成，第 6–7 步在**首次部署后**完成。

开发者后台：https://open.larksuite.com/app

> Lark 开发者后台的页面布局与飞书相同（界面为英文）。各步骤截图请参考[飞书配置指南](im-setup-feishu.md)。

## 1. 创建自建应用

登录开发者后台 → **Create Custom App** → 填写名称、描述和图标 → **Create**。

## 2. 获取 App ID（密钥稍后再填）

应用 → **Credentials & Basic Info**：
- **App ID**（`cli_` 加 8–32 位字母数字）→ 配置项 `im.lark.appId`，YAML 中写作 `lark: { appId: cli_xxxxxxxxxxxxxxxx }`。
- **App Secret** → 不要写进配置文件，留到第 6 步使用。

## 3. 开通权限

应用 → **Permissions & Scopes** → **Import/Export**（以控制台为准，界面可能变化）→ 粘贴 scope JSON。

- 使用仓库中生成好的列表 [`config/scopes/feishu.json`](../../config/scopes/feishu.json)（飞书与 Lark 共用，由 `npm run gen:catalog` 生成），覆盖 tier-1 工具和 `offline_access`。
- 只使用用户身份：所有 scope 放在 `user` 下，`tenant` 留空。
- **必须开通 `offline_access`**（用于 refresh token）。
- scope 名称与飞书相同。部分 scope 在 Lark 上可能不存在，批量导入时会报"权限不存在"，删掉这些条目后重新导入即可（以控制台为准，界面可能变化）。如果删掉了 scope，请同时把 `im.lark.scopes` 设为保留下来的列表，避免授权时申请应用没有的权限。

配置项 `im.lark.scopes`：授权时申请的 scope。**默认（不设置时）：`config/scopes/feishu.json` 中的全部 `user` scope。**需要用户尚未授予的权限时，工具会返回 `missing_scope` 和 `authorize_url`。

## 4. 设置可用范围

应用 → **Availability**：限定为需要使用本服务的成员。只有可用范围内的成员才能授权。

## 5. 发布版本

应用 → **Version Management & Release** → 创建 → 提交管理员审批。每次修改权限都要发布新版本。

## 6. 部署后：写入 App Secret

```bash
npm run secret:set-im-app -- -c config=config/deploy.yaml
```

脚本提示输入 App Secret（不回显），向 Lark 校验后写入 Secrets Manager `<slug>/im-app` = `{"appId": "...", "appSecret": "...", "configured": true}`。校验失败时打印 `lark rejected the credentials: …`，不写入任何内容。`--no-validate` 可跳过校验。

## 7. 部署后：登记回调 URL

Stack 输出 `CallbackUrl`（= `<base>/callback`；`ImConsoleCallbackHint` 是直达后台页面的链接）。应用 → **Security Settings** → **Redirect URLs** → 粘贴 → **Add**。填写完整路径，查询参数和锚点可以不填。

把 Stack 输出 `McpUrl`（= `<base>/mcp`）发给用户。

## 配置与密钥对照

| 值 | 位置 |
|---|---|
| `im: lark` | `config/deploy.yaml` |
| App ID | `im.lark.appId`（YAML：`lark: { appId: ... }`） |
| 授权 scope | `im.lark.scopes`（默认为 `config/scopes/feishu.json` 的 `scopes.user`） |
| App Secret | 部署后：`npm run secret:set-im-app` → `<slug>/im-app` `{appId, appSecret, configured: true}` |
| 回调 URL | Stack 输出 `CallbackUrl` → Lark 后台 → Security Settings → Redirect URLs |

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `redirect_uri unmatch` / 错误码 20029 | 回调 URL 没有登记，或登记在了飞书而不是 Lark | 在 open.larksuite.com 上执行第 7 步 |
| 批量导入失败："权限不存在" | Lark 上没有该 scope | 删掉这些条目后重新导入，并相应设置 `im.lark.scopes` |
| 用户无法授权 | 不在可用范围内，或版本还没审批通过 | 第 4–5 步 |
| 工具结果返回 `missing_scope` | 没开通该权限，或用户没有授予 | 开通并发布，用户打开 `authorize_url` |
| `secret:set-im-app` 打印 `lark rejected the credentials` | 密钥错误，或应用是在飞书上创建的 | 用正确的密钥重新执行，并确认 `im` |
| 工具结果返回 `im_app_not_configured` | 从未写入 App Secret | 第 6 步 |

## 能力边界

- 只以用户身份操作，不提供机器人、群发或事件订阅。
- 支持把 `im: lark` 部署到 AWS 中国区，但从中国区访问 Lark 国际端点要跨境，延迟和可达性取决于你的网络环境（本样例不做优化）。
- 需要服务端本地文件的工具标记为不可用。

官方文档：[Configure redirect URLs](https://open.larksuite.com/document/server-docs/getting-started/authen-v1/redirect-urls)

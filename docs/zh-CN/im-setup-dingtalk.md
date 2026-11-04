简体中文 | [English](../en/im-setup-dingtalk.md)

# 钉钉应用配置（`im: dingtalk`）

服务通过钉钉官方 `dws` CLI，以每个用户自己的身份、使用该用户的 OAuth token 调用钉钉。你需要准备：
1. 一个供用户做 OAuth 授权的**企业内部应用**；
2. 为组织**开通 CLI 访问**（管理员操作，只需一次）。

第 1–4 步在**部署前**完成，第 5 步在**首次部署后**完成。

开发者后台：https://open-dev.dingtalk.com

## 1. 为组织开通 CLI 访问（管理员）

https://open-dev.dingtalk.com → **CLI 访问管理** → **启用**（以控制台为准，界面可能变化）。

- 一次开通，对整个组织生效。
- 未开通时，`dws` 调用会报 `cli_not_enabled`（组织未开通）或 `user_forbidden`（用户不被允许）。用户也可能看到**立即申请**的提示，之后管理员会收到审批卡片，一键即可通过。

## 2. 创建企业内部应用

后台 → **应用开发** → **企业内部应用** → **创建应用**（以控制台为准，界面可能变化），填写名称和描述。

## 3. 获取 Client ID 和 Client Secret

应用 → **凭证与基础信息**：
- **Client ID**（原 **AppKey**）→ 配置项 `im.dingtalk.clientId`
- **Client Secret**（原 **AppSecret**）→ 不写进配置文件，执行：

```bash
npm run secret:set-im-app
# 写入 Secrets Manager <slug>/im-app = {"clientId": "...", "clientSecret": "..."}
```

## 4. 申请权限并发布

1. 应用 → **权限管理**：申请用户需要的权限（以控制台为准，界面可能变化）。至少要开通个人信息读权限（`Contact.User.Read`，以控制台为准，界面可能变化），服务端用它读取登录用户本人的资料并映射用户身份。再按需添加组织级权限（通讯录、日程、文档等），其中部分权限需要管理员审批。
2. **发布**应用版本（版本管理与发布），让成员可以使用。把可见范围限定为需要使用本服务的用户。

配置项 `im.dingtalk.scopes`：授权时申请的 OAuth scope，默认 `openid corpid`。`corpid` 让 token 带上组织上下文，请保留。

不要去猜每个工具需要的 scope 名称。调用缺少权限时，工具结果会返回 `permission_required` 错误和一个授权链接；在后台补上权限后，让用户打开该链接即可。

## 5. 部署后：登记重定向 URL

部署输出 → `<base>/callback`。

应用 → **安全设置** → **重定向 URL**（回调域名）→ 添加 `<base>/callback` → 保存（以控制台为准，界面可能变化）。

把 `<base>/mcp` 发给用户。

## 配置与密钥对照

| 值 | 位置 |
|---|---|
| `im: dingtalk` | `config/deploy.yaml` |
| Client ID（AppKey） | `im.dingtalk.clientId` |
| OAuth scope | `im.dingtalk.scopes`（默认 `openid`、`corpid`） |
| Client Secret（AppSecret） | `npm run secret:set-im-app` → `<slug>/im-app` `{clientId, clientSecret}` |
| 重定向 URL | 钉钉后台 → 安全设置 |
| CLI 访问 | 钉钉开发者平台 → CLI 访问管理（管理员） |

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 报错包含 `cli_not_enabled` | 组织没有开通 CLI 访问 | 第 1 步（管理员） |
| 报错包含 `user_forbidden` | 组织的 CLI 访问策略不允许该用户 | 管理员审批该用户的申请，或放宽策略 |
| 授权页提示重定向 URI 错误 | `<base>/callback` 没有登记，或登记的主机不一致（自定义域名和 API Gateway URL 混用） | 第 5 步，登记与部署时完全一致的 URL |
| 工具结果中出现 `permission_required` | 应用缺少该权限，或用户没有授予 | 补充权限（第 4 步），必要时重新发布，用户打开返回的链接 |
| 个人账号（非组织）调用报权限错误 | 组织级接口需要组织上下文 | 使用组织内的账号 |
| 部署提示应用凭证无效 | Client ID/Secret 不是同一对 | 重新执行 `npm run secret:set-im-app` |

## 能力边界

- 只以已登录用户的身份操作，消息显示用户本人的头像和昵称。
- **CLI 访问必须由组织管理员保持开通**，关闭后所有用户都无法使用。
- 服务端会自动刷新钉钉用户 token。用户长时间不使用，或管理员重置了其授权时，需要重新授权。
- 本版本不支持钉钉国际版（`dingtalk.io`）。

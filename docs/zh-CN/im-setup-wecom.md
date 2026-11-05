简体中文 | [English](../en/im-setup-wecom.md)

# 企业微信配置（`im: wecom`）

企业微信与飞书、Lark、钉钉的接入方式不同：

- **不需要创建应用，也没有应用密钥。**不用开发者后台应用，不用执行 `npm run secret:set-im-app`，也没有回调 URL。
- **每个用户用企业微信 App 扫码，创建属于自己的智能机器人。**服务用该用户的机器人凭证运行官方 `wecom-cli`，凭证加密保存。
- **由企业微信管理员决定谁可以创建 API 模式机器人，以及数据访问是否需要审批。**请先完成 A 部分。

| 部分 | 谁来做 | 什么时候 |
|---|---|---|
| [A. 管理员：允许使用智能机器人](#a-管理员在企业微信管理后台允许使用智能机器人) | 企业微信管理员 | 推广前 |
| [B. 部署 Stack](#b-部署) | 部署人员 | 推广前 |
| [C. 用户：连接并扫码](#c-用户连接并扫码) | 每个用户 | 首次使用 |
| [D. 用户：每 7 天续期](#d-用户每-7-天续期能力授权) | 每个用户 | 每周 |
| [E. 运维：审批新用户](#e-运维审批新用户) | 部署人员 | 有新用户时（开启审批时） |

本文用到的链接：

| 用途 | 链接 |
|---|---|
| 企业微信管理后台 | https://work.weixin.qq.com/wework_admin/ |
| CLI 概述（官方） | https://developer.work.weixin.qq.com/document/path/61944 |
| 能力与 7 天授权说明（官方） | https://developer.work.weixin.qq.com/document/path/61954 |
| 开发前必读：CLI/MCP 前置配置 | https://developer.work.weixin.qq.com/document/path/62131 |
| 帮助中心：审批与免审名单 | https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21676 |
| 帮助中心：长连接（API 模式）机器人创建权限 | https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21669 |
| 智能机器人更新日志 | https://work.weixin.qq.com/nl/index/openclaw |
| `wecom-cli` 源码 | https://github.com/WecomTeam/wecom-cli |

管理后台在 2026 年把智能机器人相关页面从「安全与管理」移到了「智能专区」。如果你的后台仍显示旧菜单，请在旧位置查找。

## A. 管理员：在企业微信管理后台允许使用智能机器人

用管理员身份登录 https://work.weixin.qq.com/wework_admin/ 。

### A1. 允许成员创建 API 模式机器人

**智能专区 → 智能机器人 → 权限管理 → API 模式管理** → **可配置长连接方式接入的成员** → 添加将使用本服务的成员、部门或整个企业。

- `wecom-cli` 创建的是 API 模式（长连接）机器人，不在这个名单里的成员无法完成扫码流程。他们可以在企业微信 App 中向超级管理员申请，审批通过后会被自动加入名单。（[文档 21669](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21669)）
- 长连接机器人不受企业可信域名、可信 IP 的限制，所以本服务不需要配置可信域名或可信IP。

### A2. 决定数据访问是否需要审批

仍在 **权限管理** 页面。如果企业设置了机器人数据访问需要审批，下列能力需要管理员按机器人逐个审批：

- 搜索与获取邮件内容
- 搜索与获取文档内容
- 搜索与获取会议信息
- 搜索与获取微盘文件内容
- 搜索企业成员

如需对部分或全部成员免审，把他们加入：

- **以下成员创建的机器人，获取数据访问权限无需审批**
- **以下成员创建的机器人，检索企业成员时无需审批**

选中企业根目录即全员免审。（[文档 21676](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21676)）写入类（如「新建与编辑文档」）、消息、日程、待办不在审批列表中。

### A3. 推广前告诉用户两条规则

1. **每 7 天续期一次**（D 部分），这是平台策略。
2. **重新授权时选择已有机器人，不要新建**（C 部分）。

## B. 部署

不需要任何企业微信凭证。最小的 `config/deploy.yaml`：

```yaml
region: ap-southeast-1      # 任一 AgentCore 区域，Global 或中国区均可
im: wecom
slug: wecom
wecom:
  requireApproval: true     # 建议开启，见 E 部分
  maxPendingQr: 20
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `wecom.requireApproval` | `false` | 运维审批之前，新的企业微信用户拿不到 MCP token。**建议设为 `true`**（E 部分） |
| `wecom.maxPendingQr` | `20` | 整个部署同时进行中的扫码登录上限。每个登录最长占用一个 AgentCore 会话 300 秒；每个来源 IP 最多同时 3 个。超过上限时页面返回 HTTP 429 |

```bash
npm run deploy -- -c config=config/deploy.yaml
npm run e2e -- -c config=config/deploy.yaml      # 第 5 步显示 "QR image"
```

然后把 Stack 输出 **`McpUrl`**（`<base>/mcp`）发给用户，这是用户唯一需要的信息。完整部署步骤见 [deploy.md](deploy.md)。

## C. 用户：连接并扫码

### C1. 在客户端中添加 MCP 服务器

| 客户端 | 操作 |
|---|---|
| Amazon Quick（AWS Global） | Connectors → Create for your team → Model Context Protocol → endpoint 填 `McpUrl` → **Auth configuration 选 Default OAuth app** → Create and continue（[教程](client-amazon-quick.md)） |
| Claude Code | `claude mcp add --transport http wecom <McpUrl>`，然后执行 `/mcp` |
| Kiro / Codex / Cursor | 把 `McpUrl` 添加为远程（streamable HTTP）MCP 服务器（见 [README](../../README.zh-CN.md#连接-mcp-客户端)） |

客户端会在浏览器中打开 `<base>/authorize`，页面显示一个二维码和"等待扫码（5 分钟内有效）"。

### C2. 用企业微信 App 扫码

打开企业微信手机 App，用扫一扫（右上角 + → 扫一扫），在 **5 分钟内**扫描二维码。

- **第一次：**企业微信会为你创建一个智能机器人（一键创建机器人），并请你授权。
- **之后每一次**（换设备、换客户端、被撤销后重新授权）：**选择已有机器人**。如果再次新建，会多出一个同名机器人，并且**永久失去**对旧机器人所创建的文档、表格、日程的编辑权限。

不同企业微信版本的手机端文案可能略有差异。

### C3. 授权能力

授权你需要使用的能力：消息、文档、表格、智能表格、日程、会议、待办、邮件、微盘、通讯录。如果管理员设置了审批（A2），数据读取类能力需要等管理员审批。

之后可以随时在企业微信客户端中授权或修改：**工作台 → 智能机器人 → 管理 → 你的机器人 → 编辑 → 可使用权限 → 去授权**。

### C4. 回到客户端

浏览器页面显示"授权成功"并返回客户端，工具随即加载（共 34 个：tier 1 工具加 `wecom_discover` / `wecom_invoke`）。

如果开启了审批（E 部分），页面显示"授权成功，正在等待管理员审批"。审批通过后，在客户端中重新连接 MCP 服务器即可。

## D. 用户：每 7 天续期能力授权

每项能力授权自授权之时起有效 **7 天**。读和写分别计时，持续使用也不会延长有效期。授权过期后，工具调用会返回企业微信错误码 **850003**，服务返回 `im_grant_expired`。

续期需要由**机器人的创建者**在企业微信客户端中操作：

**工作台 → 智能机器人 → 管理 → 该机器人 → 编辑 → 可使用权限** → 对已过期的能力重新授权。

- 已授权的能力会显示到期时间（已授权｜有效期至 …）。重新授权后重新计 7 天。也有用户在到期前先「取消授权」再重新授权来提前续期。
- 企业微信返回的 850003 错误信息中也附带一个链接，创建者点击即可重新授权。
- **不要重新扫码，也不要新建机器人**来解决授权过期。过期的只是能力授权，不是机器人身份。

服务遇到 850003 时会：

- 返回 `im_grant_expired`（`im_code: 850003`），其中的 `user_action` 提示 Agent 让用户去智能机器人页面续期，并说明不要重新扫码。
- 向 Stack 的 SNS topic 发出 CloudWatch 告警 `grant-expired`；如果设置了 `alarm.webhookUrlSsmParam`，同时推送到你的 webhook。
- 绝不会自动重新执行扫码授权。

## E. 运维：审批新用户

飞书、Lark、钉钉应用只允许你自己组织内的用户授权。**企业微信扫码流程不是这样：**任何组织中任何有企业微信账号的人，只要打开你的 `McpUrl` 并扫码，就能获得一个可用的 MCP 服务，费用记在你的 AWS 账号上。`wecom-cli` 不提供企业 ID，所以服务无法按组织过滤。

开启 `wecom.requireApproval: true` 后：

```bash
npm run users -- -c config=config/deploy.yaml list                # 找到状态为 pending_approval 的行
npm run users -- -c config=config/deploy.yaml approve <userId>
npm run users -- -c config=config/deploy.yaml revoke <userId>     # 对该企业微信身份永久生效
```

待审批用户永远拿不到 MCP access token。同一企业微信身份之后重新授权时，会保留已审批状态。

## 配置与密钥对照

| 值 | 位置 |
|---|---|
| `im: wecom` | `config/deploy.yaml` |
| 审批 / 扫码上限 | `wecom.requireApproval`、`wecom.maxPendingQr` |
| 应用凭证 | 无 |
| 每个用户的机器人凭证 | 由扫码流程生成，保存在 Secrets Manager `<slug>/users/<userId>`（每个用户一个 secret，专用 KMS 密钥） |
| 告警 webhook（建议配置，用于及时发现 850003） | `alarm.webhookUrlSsmParam` 中指定的 SSM 参数 |

## 常见错误

| 错误码 / 现象 | 含义 | 处理 |
|---|---|---|
| 扫码流程无法完成，企业微信提示没有权限创建机器人 | 用户不在可创建 API 模式机器人的名单中 | 管理员按 A1 操作；或用户在企业微信中申请，由超级管理员审批 |
| 数据类工具在审批前无法使用 | 企业设置了机器人数据访问需要审批 | 管理员审批，或把用户加入免审名单（A2） |
| `im_grant_expired`（**850003**） | 能力授权已过期（7 天） | D 部分 |
| 读取聊天记录返回 `im_policy_blocked`（**853006**） | 超过 10 人的企业不能读取聊天记录（平台策略） | 无法解决 |
| 写文档/表格返回 `im_object_permission`（**851003**） | 机器人对该对象没有权限；机器人不继承用户原有的文档权限 | 让机器人创建文档并把用户设为管理员，或把文档共享给机器人 |
| `im_rate_limited`（**850005**） | 每个机器人每分钟 50 次调用 | 稍等；服务已带退避自动重试两次 |
| `im_reauth_required`（893201） | 机器人授权已失效 | 重新连接并扫码，**选择已有机器人** |
| 二维码过期 | 5 分钟内没有扫码 | 刷新页面，或在客户端中重新连接 |
| "正在等待管理员审批" | 开启了 `wecom.requireApproval` 且用户是新用户 | E 部分 |
| "访问已被撤销" | 运维撤销了该企业微信身份 | 对该身份永久生效 |
| HTTP 429"当前进行中的登录过多" | 达到 `wecom.maxPendingQr` 或单 IP 3 个的上限 | 稍等一分钟再试 |
| 重新授权后失去旧文档的编辑权限 | 新建了机器人 | 无法恢复；务必选择已有机器人 |

## 能力边界

- **每项能力每 7 天需手动续期**（平台策略，本示例已接受）。
- **超过 10 人的企业不能读取聊天记录。**
- 机器人以自己的身份访问文档，不继承用户原有的文档权限。
- 消息只能发给用户本人，或发到机器人最近（24 小时内）互动过的会话，不能群发。每个会话每分钟最多 30 条。
- 需要本地文件路径的工具（从本地上传、页面导入）在远程不可用，工具说明中会给出替代方案。
- 每个机器人每分钟 50 次调用。
- 除非开启 `wecom.requireApproval`，否则没有租户边界（见 [security.md](security.md)）。
- 扫码流程使用的是 `wecom-cli` 的扫码接口，企业微信维护者表示它还不是正式接口，后续 `wecom-cli` 版本可能会有变化。

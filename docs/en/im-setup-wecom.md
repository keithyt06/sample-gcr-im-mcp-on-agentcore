[Chinese](../zh-CN/im-setup-wecom.md) | English

# WeCom setup (`im: wecom`)

WeCom works differently from Feishu, Lark, and DingTalk:

- **You don't create an app and there is no app secret.** No developer-console app, no `npm run secret:set-im-app`, no callback URL.
- **Each user creates their own smart bot (智能机器人) by scanning a QR code** with the WeCom app. The service runs the official `wecom-cli` with that user's bot credentials, which it stores encrypted.
- **The WeCom admin decides who may create API-mode bots and whether data access needs approval.** Do that first (part A).

| Part | Who | When |
|---|---|---|
| [A. Admin: allow smart bots](#a-admin-allow-smart-bots-in-the-wecom-admin-console) | WeCom admin | Before rollout |
| [B. Deploy the stack](#b-deploy) | Deployer | Before rollout |
| [C. User: connect and scan](#c-user-connect-and-scan-the-qr-code) | Each user | First use |
| [D. User: renew every 7 days](#d-user-renew-capability-grants-every-7-days) | Each user | Weekly |
| [E. Operator: approve users](#e-operator-approve-new-users) | Deployer | When users join (if approval is on) |

Links used in this guide:

| What | URL |
|---|---|
| WeCom admin console | https://work.weixin.qq.com/wework_admin/ |
| CLI overview (official) | https://developer.work.weixin.qq.com/document/path/61944 |
| Capabilities and 7-day authorization (official) | https://developer.work.weixin.qq.com/document/path/61954 |
| Before you develop: CLI/MCP prerequisites | https://developer.work.weixin.qq.com/document/path/62131 |
| Help: approval and free-review list | https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21676 |
| Help: who may create long-connection (API-mode) bots | https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21669 |
| Smart bot changelog | https://work.weixin.qq.com/nl/index/openclaw |
| `wecom-cli` source | https://github.com/WecomTeam/wecom-cli |

Console labels are given in Chinese exactly as they appear (the WeCom admin console has no English UI), followed by an English translation. The admin console moved the smart bot pages from 安全与管理 (Security & Management) to 智能专区 (AI Zone) in 2026; if your console still shows the old menu, look there.

## A. Admin: allow smart bots in the WeCom admin console

Sign in to https://work.weixin.qq.com/wework_admin/ as an admin.

### A1. Let members create API-mode bots

**智能专区 (AI Zone) → 智能机器人 (Smart Bots) → 权限管理 (Permission Management) → API 模式管理 (API Mode Management)** → **可配置长连接方式接入的成员** (members allowed to configure long-connection bots) → add the members, departments, or the whole organization who will use this service.

- `wecom-cli` creates an API-mode (long-connection) bot. A member who isn't on this list can't finish the QR flow. In the WeCom app they can apply to the super admin; once approved they are added to the list. ([doc 21669](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21669))
- Long-connection bots are not subject to WeCom trusted domains or trusted IPs, so you don't configure 可信域名 / 可信IP for this service.

### A2. Decide whether data access needs approval

Same page, **权限管理 (Permission Management)**. If your organization requires approval for bot data access, these capabilities need an admin approval per bot:

- 搜索与获取邮件内容 (search and read mail)
- 搜索与获取文档内容 (search and read documents)
- 搜索与获取会议信息 (search and read meetings)
- 搜索与获取微盘文件内容 (search and read WeDrive files)
- 搜索企业成员 (search members)

To skip approval for some or all members, add them to:

- **以下成员创建的机器人，获取数据访问权限无需审批** (bots created by these members get data access without approval), and
- **以下成员创建的机器人，检索企业成员时无需审批** (bots created by these members can search members without approval).

Selecting the organization root exempts everyone. ([doc 21676](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21676)) Writing (for example 新建与编辑文档, create and edit documents), messages, calendar, and to-dos are not on the approval list.

### A3. Tell users the two rules before rollout

1. **Renew every 7 days** (part D). This is platform policy.
2. **When re-authorizing, choose the existing bot, never create a new one** (part C).

## B. Deploy

There are no WeCom credentials. A minimal `config/deploy.yaml`:

```yaml
region: ap-southeast-1      # any AgentCore region, Global or China
im: wecom
slug: wecom
wecom:
  requireApproval: true     # recommended, see part E
  maxPendingQr: 20
```

| Key | Default | Meaning |
|---|---|---|
| `wecom.requireApproval` | `false` | New WeCom users get no MCP token until an operator approves them. **Recommended: `true`** (part E) |
| `wecom.maxPendingQr` | `20` | Concurrent pending QR logins for the deployment. Each holds an AgentCore session for up to 300 s; each source IP may hold at most 3. Over the cap the page returns HTTP 429 |

```bash
npm run deploy -- -c config=config/deploy.yaml
npm run e2e -- -c config=config/deploy.yaml      # step 5 reports "QR image"
```

Then give users the stack output **`McpUrl`** (`<base>/mcp`). That URL is the only thing they need. Full deploy steps: [deploy.md](deploy.md).

## C. User: connect and scan the QR code

### C1. Add the MCP server in your client

| Client | What to do |
|---|---|
| Amazon Quick (AWS Global) | Connectors → Create for your team → Model Context Protocol → endpoint `McpUrl` → **Auth configuration: Default OAuth app** → Create and continue ([tutorial](client-amazon-quick.md)) |
| Claude Code | `claude mcp add --transport http wecom <McpUrl>`, then `/mcp` |
| Kiro / Codex / Cursor | Add `McpUrl` as a remote (streamable HTTP) MCP server ([README](../../README.md#connect-an-mcp-client)) |

The client opens a browser tab at `<base>/authorize`. It shows a QR code and the text "Waiting for scan (valid for 5 minutes)".

### C2. Scan with the WeCom app

Open the WeCom mobile app, use its scanner (+ → 扫一扫, Scan), and scan the QR code within **5 minutes**.

- **First time:** WeCom creates a smart bot for you (一键创建机器人, one-click create) and asks you to authorize it.
- **Every later time** (new device, new client, after revocation): **choose the existing bot** (选择已有机器人). Choosing to create a new one again gives you a second bot with the same name, and you **permanently lose** write access to documents, sheets, and events the old bot created.

The exact wording on the phone may differ slightly by WeCom version.

### C3. Grant the capabilities

Authorize the capabilities you want to use (messages, documents, sheets, smart sheets, calendar, meetings, to-dos, mail, WeDrive, contacts). If your admin requires approval (A2), the data-read capabilities wait for the admin.

You can grant or change them any time in the WeCom client: **工作台 (Workplace) → 智能机器人 (Smart Bots) → 管理 (Manage) → your bot → 编辑 (Edit) → 可使用权限 (Available permissions) → 去授权 (Authorize)**.

### C4. Back in the client

The browser page says "Authorized" and returns to the client, and the tools load (34 tools: tier 1 plus `wecom_discover` / `wecom_invoke`).

If approval is on (part E), the page says "Authorized. Your access is waiting for operator approval". After the operator approves you, reconnect the server in your client.

## D. User: renew capability grants every 7 days

Each capability grant lasts **7 days** from the moment it is given. Read and write grants count separately, and using them does not extend them. When a grant expires, tools fail with WeCom error **850003** and the service returns `im_grant_expired`.

To renew, the **bot's creator** opens the WeCom client:

**工作台 (Workplace) → 智能机器人 (Smart Bots) → 管理 (Manage) → the bot → 编辑 (Edit) → 可使用权限 (Available permissions)** → authorize the expired capability again.

- An expired grant shows its end date (已授权｜有效期至 …, authorized, valid until …). Authorize it again to start a new 7 days. Some users renew early by cancelling the grant (取消授权) and authorizing again.
- The 850003 error message from WeCom also contains a link the creator can open to re-authorize.
- **Don't scan the QR code again** and don't create a new bot to fix an expired grant. The bot's identity hasn't expired, only the capability.

What the service does on 850003:

- Returns `im_grant_expired` (`im_code: 850003`) with a `user_action` telling the agent to ask the user to renew in the smart bot page and not to re-scan.
- Raises the CloudWatch alarm `grant-expired` to the stack's SNS topic, and to your webhook if `alarm.webhookUrlSsmParam` is set.
- Never re-runs the QR authorization on its own.

## E. Operator: approve new users

Feishu, Lark, and DingTalk apps only admit users of your own organization. **The WeCom QR flow doesn't:** anyone with a WeCom account in any organization who opens your `McpUrl` can scan and get a working MCP server billed to your AWS account. `wecom-cli` doesn't expose the corp ID, so the service can't filter by organization.

With `wecom.requireApproval: true`:

```bash
npm run users -- -c config=config/deploy.yaml list                # find rows with status pending_approval
npm run users -- -c config=config/deploy.yaml approve <userId>
npm run users -- -c config=config/deploy.yaml revoke <userId>     # permanent for that WeCom identity
```

Pending users never receive an MCP access token. A user who re-authorizes later with the same WeCom identity keeps their approved status.

## Config and secret mapping

| Value | Where |
|---|---|
| `im: wecom` | `config/deploy.yaml` |
| Approval / QR cap | `wecom.requireApproval`, `wecom.maxPendingQr` |
| App credentials | None |
| Per-user bot credentials | Created by the QR flow; stored in Secrets Manager `<slug>/users/<userId>` (one secret per user, dedicated KMS key) |
| Alarm webhook (recommended, to catch 850003) | SSM parameter named in `alarm.webhookUrlSsmParam` |

## Common errors

| Code / symptom | Meaning | Fix |
|---|---|---|
| QR flow doesn't finish; WeCom says you have no permission to create a bot | The user isn't allowed to create API-mode bots | Admin: A1. Or the user applies in WeCom and the super admin approves |
| Data tools fail until approved | The organization requires approval for bot data access | Admin approves, or adds the user to the free-review list (A2) |
| `im_grant_expired` (**850003**) | Capability grant expired (7 days) | Part D |
| `im_policy_blocked` (**853006**) on chat history | Reading chat history is blocked in organizations with more than 10 members (platform policy) | None |
| `im_object_permission` (**851003**) on doc/sheet write | The bot has no permission on that object; it doesn't inherit the user's document permissions | Let the bot create the doc and add the user as a manager, or share the doc with the bot |
| `im_rate_limited` (**850005**) | 50 calls / minute / bot | Wait; the service already retries twice with backoff |
| `im_reauth_required` (893201) | The bot authorization is no longer valid | Reconnect and scan again, **choosing the existing bot** |
| QR expired | Not scanned within 5 minutes | Reload the page, or reconnect in the client |
| "Waiting for operator approval" | `wecom.requireApproval: true` and the user is new | Part E |
| "Access revoked" | The operator revoked this WeCom identity | Permanent for that identity |
| HTTP 429 "Too many sign-ins are in progress" | `wecom.maxPendingQr` or the per-IP limit of 3 reached | Wait a minute and retry |
| Write access lost on old docs after re-authorizing | A new bot was created | Can't be undone; always choose the existing bot |

## Capability boundaries

- **7-day manual renewal per capability** (platform policy, accepted for this sample).
- **Chat history is unavailable in organizations with more than 10 members.**
- The bot accesses documents as itself and doesn't inherit the user's existing document permissions.
- Messages go only to the user or to conversations the bot interacted with recently (within 24 hours). No broadcast. 30 messages per minute per conversation.
- Tools that need a local file path (upload from disk, page import) are unavailable remotely; their descriptions suggest inline alternatives.
- 50 calls per minute per bot.
- No tenant boundary unless `wecom.requireApproval` is on ([security.md](security.md)).
- The QR flow uses `wecom-cli`'s scan endpoint, which WeCom maintainers describe as not yet a formal API. It may change in a future `wecom-cli` release.

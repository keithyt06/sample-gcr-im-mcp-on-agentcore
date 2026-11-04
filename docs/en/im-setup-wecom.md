[Chinese](../zh-CN/im-setup-wecom.md) | English

# WeCom setup (`im: wecom`)

WeCom works differently from the other three IMs. **There is no developer-console app to create and no app secret.** Each user authorizes by scanning a QR code with the WeCom mobile app. That creates (or binds) a **smart bot** tied to that user, and the official `wecom-cli` runs calls with it. Per-user credentials are stored encrypted by the service.

Config: set `im: wecom`. There are no WeCom credential keys, and you don't run `npm run secret:set-im-app`. The optional `wecom:` block has two keys:

```yaml
im: wecom
wecom:
  requireApproval: true   # recommended; default false
  maxPendingQr: 20        # default 20
```

| Key | Default | Meaning |
|---|---|---|
| `wecom.requireApproval` | `false` | New WeCom users are held as `pending_approval` and get no MCP token until an operator runs `npm run users -- approve <userId>`. **Recommended: `true`.** See [No tenant boundary](#no-tenant-boundary-turn-on-approval) |
| `wecom.maxPendingQr` | `20` | Cap on concurrent pending QR logins for the whole deployment (each one holds an AgentCore session for up to 300 s). Each source IP may also hold at most 3. Over the cap, the authorization page returns HTTP 429 "Too many sign-ins are in progress" |

## No tenant boundary: turn on approval

Feishu, Lark, and DingTalk apps only admit users of your own tenant. **The WeCom QR flow does not:** anyone with a WeCom account, in any organization, who opens your `<base>/mcp` in an MCP client can scan the QR code and get a working MCP server billed to your AWS account. `wecom-cli` does not expose the corp ID, so the service cannot filter by organization.

With `wecom.requireApproval: true`:
1. A new user scans, authorizes in WeCom, and the page says "Authorized. Your access is waiting for operator approval".
2. The operator runs `npm run users -- list`, finds the `pending_approval` row, checks who it is, and runs `npm run users -- approve <userId>`.
3. The user reconnects the MCP server in their client.

Pending users never receive an MCP access token. A user who re-authorizes later (same WeCom identity) keeps their approved status.

## Before deploying (admin)

1. Confirm your organization allows members to use smart bots / AI capabilities (CLI and MCP access). Since 2026-08 WeCom opens these capabilities to organizations of any size. If your org restricts bots, an admin must allow it in the WeCom admin console (verify in console — UI may change).
2. Tell users about the **7-day renewal** and the **bind existing bot** rule below **before** rollout.
3. Decide on `wecom.requireApproval` (above).

## User flow (after deploy)

1. The user adds `<base>/mcp` (stack output `McpUrl`) to their MCP client. The client opens the browser.
2. The authorization page shows a QR code. The user scans it with WeCom on their phone. It expires after 300 seconds.
3. In WeCom, the user chooses:
   - **First time:** create a new bot.
   - **Every later time:** **bind the existing bot**. Choosing "create new" again **permanently loses** write access to documents, sheets, and events created by the old bot.
4. The user grants the capabilities (docs, messages, calendar, mail, …) in WeCom.
5. Tools load in the client (or, with approval on, after the operator approves and the user reconnects).

There is no callback URL to register with WeCom.

## Renewing capability grants every 7 days (ACCEPTED limitation)

Each capability grant expires **7 days** after it is given. After that, calls fail with WeCom error **850003**. There is no API to renew it; the user must renew it **manually in the WeCom client**:

WeCom → smart bot management page → the bot → renew the expired capabilities (verify in console — UI may change).

What the service does:
- Returns a tool result with the error code `im_grant_expired` (`im_code: 850003`). Its `user_action` tells the agent that the grant expired after 7 days, that the user should renew it in the WeCom smart-bot management page, and that the user must not re-scan the QR code or create a new bot.
- Raises the CloudWatch alarm `grant-expired`, which goes to the stack's SNS topic and, if `alarm.webhookUrlSsmParam` is set, to your webhook.
- Never re-runs the QR authorization on its own. Re-authorizing with "create new bot" would lose object permissions.

## Config and secret mapping

| Value | Where |
|---|---|
| `im: wecom` | `config/deploy.yaml` |
| Approval / QR cap | `wecom.requireApproval`, `wecom.maxPendingQr` |
| App credentials | none |
| Per-user credentials | Created by the QR flow and stored by the service in Secrets Manager `<slug>/users/<userId>` (one secret per user, dedicated KMS key) |
| Alarm webhook (recommended, to catch 850003) | SSM parameter, name in `alarm.webhookUrlSsmParam` |

## Common errors

| Code / symptom | Meaning | Fix |
|---|---|---|
| `im_grant_expired` (**850003**) | Capability grant expired (7 days) | User renews it in the WeCom smart-bot management page |
| `im_policy_blocked` (**853006**) on chat history | Reading chat/message history is blocked in orgs with more than 10 members (platform policy) | None. Not available in larger orgs |
| `im_object_permission` (**851003**) on doc/sheet write | The bot lacks permission on that object. The bot does not inherit the user's document permissions | Let the bot create the doc and add the user as a manager, or share the doc with the bot |
| `im_rate_limited` (**850005**) | Rate limit: 50 calls / minute / bot | Wait and retry (the service already retries twice with backoff) |
| `im_reauth_required` (893201) | The WeCom authorization is no longer valid | User reconnects and scans again, choosing **bind existing bot** |
| QR expired / timeout | The QR code was not scanned within 300 seconds | Reload the authorization page |
| Page says "waiting for operator approval" | `wecom.requireApproval: true` and the user is new | Operator: `npm run users -- approve <userId>`; user reconnects |
| Page says access revoked | The operator revoked this WeCom identity | Revocation is permanent for that identity |
| HTTP 429 "Too many sign-ins are in progress" | `wecom.maxPendingQr` or the per-IP cap of 3 reached | Wait a minute and retry |
| Write access lost on old docs after re-authorizing | User chose "create new bot" | Cannot be undone. Always choose "bind existing bot" |
| Calls fail with a trusted-IP error | Your org enforces WeCom trusted IPs | Unverified whether this applies to the bot channel. Report the error. The NAT egress option is not in v1 |

## Capability boundaries

- **7-day manual renewal per capability.** This is platform policy and is accepted for this sample.
- **Chat history is unavailable in orgs with more than 10 members.**
- Messages can only go to the user themself or to conversations the bot recently interacted with. No broadcast.
- Tools that need a local file path (for example media/disk upload, page import) are unavailable remotely. Their tool descriptions say so and suggest inline alternatives.
- 50 calls per minute per bot.
- No tenant boundary unless you turn on `wecom.requireApproval` (see above and [security.md](security.md)).

[Chinese](../zh-CN/im-setup-wecom.md) | English

# WeCom setup (`im: wecom`)

WeCom works differently from the other three IMs. **There is no developer-console app to create and no app secret.** Each user authorizes by scanning a QR code with the WeCom mobile app. That creates (or binds) a **smart bot** tied to that user, and the official `wecom-cli` runs calls with it. Per-user credentials are stored encrypted by the service.

Config: set `im: wecom`. There are no `im.wecom.*` credential keys, and you don't run `npm run secret:set-im-app`.

## Before deploying (admin)

1. Confirm your organization allows members to use smart bots / AI capabilities (CLI and MCP access). Since 2026-08 WeCom opens these capabilities to organizations of any size. If your org restricts bots, an admin must allow it in the WeCom admin console (verify in console — UI may change).
2. Tell users about the **7-day renewal** and the **bind existing bot** rule below **before** rollout.

## User flow (after deploy)

1. The user adds `<base>/mcp` to their MCP client. The client opens the browser.
2. The authorization page shows a QR code. The user scans it with WeCom on their phone (it expires in about 5 minutes).
3. In WeCom, the user chooses:
   - **First time:** create a new bot.
   - **Every later time:** **bind the existing bot**. Choosing "create new" again **permanently loses** write access to documents, sheets, and events created by the old bot.
4. The user grants the capabilities (docs, messages, calendar, mail, …) in WeCom.
5. Tools load in the client.

There is no callback URL to register with WeCom.

## Renewing capability grants every 7 days (ACCEPTED limitation)

Each capability grant expires **7 days** after it is given. After that, calls fail with WeCom error **850003**. There is no API to renew it; the user must renew it **manually in the WeCom client**:

WeCom → smart bot management page → the bot → renew the expired capabilities (verify in console — UI may change).

What the service does:
- Returns a structured tool result: "WeCom authorization expired — renew it in the WeCom smart-bot management page, then retry."
- Sends an alarm to the webhook named by `alarm.webhookUrlSsmParam` (if set).
- Never re-runs the QR authorization on its own. Re-authorizing with "create new bot" would lose object permissions.

## Config and secret mapping

| Value | Where |
|---|---|
| `im: wecom` | `config/deploy.yaml` |
| App credentials | none |
| Per-user credentials | Created by the QR flow and stored by the service in Secrets Manager (per user, dedicated KMS key) |
| Alarm webhook (recommended, to catch 850003) | SSM parameter, name in `alarm.webhookUrlSsmParam` |

## Common errors

| Code / symptom | Meaning | Fix |
|---|---|---|
| **850003** | Capability grant expired (7 days) | User renews it in the WeCom smart-bot management page |
| **853006** on chat history | Reading chat/message history is blocked in orgs with more than 10 members (platform policy) | None. Not available in larger orgs |
| **851003** on doc/sheet write | The bot lacks permission on that object. The bot does not inherit the user's document permissions | Let the bot create the doc and add the user as a manager, or share the doc with the bot |
| **850005** | Rate limit: 50 calls / minute / bot | Wait and retry (the service backs off) |
| QR expired / timeout | The QR code was not scanned within about 5 minutes | Reload the authorization page |
| Write access lost on old docs after re-authorizing | User chose "create new bot" | Cannot be undone. Always choose "bind existing bot" |
| Calls fail with a trusted-IP error | Your org enforces WeCom trusted IPs | Unverified whether this applies to the bot channel. Report the error. The NAT egress option is not in v1 |

## Capability boundaries

- **7-day manual renewal per capability.** This is platform policy and is accepted for this sample.
- **Chat history is unavailable in orgs with more than 10 members.**
- Messages can only go to the user themself or to conversations the bot recently interacted with. No broadcast.
- Tools that need a local file path (for example media/disk upload, page import) are unavailable remotely. Their tool descriptions say so and suggest inline alternatives.
- 50 calls per minute per bot.

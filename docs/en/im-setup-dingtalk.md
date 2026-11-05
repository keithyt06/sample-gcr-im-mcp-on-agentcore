[Chinese](../zh-CN/im-setup-dingtalk.md) | English

# DingTalk app setup (`im: dingtalk`)

The service calls DingTalk through the official `dws` CLI, as each user, with that user's OAuth token. You need:
1. an **internal app** that users authorize through OAuth, and
2. **CLI access enabled** for your organization (an admin action, needed once).

Do steps 1–4 **before** deploying and steps 5–6 **after** the first deploy.

Developer console: https://open-dev.dingtalk.com

## 1. Enable CLI access for the organization (admin)

https://open-dev.dingtalk.com → **CLI Access Management** → **Enable** (verify in console — UI may change).

- This is enabled once for the whole organization.
- Without it, tool calls return the error code `im_admin_action_required` (the message from dws mentions `cli_not_enabled` when the org is not enabled, or `user_forbidden` / `user_not_allowed` when the user is not allowed). Users may also see a prompt to **Apply Now**. The admin then gets an approval card and can approve with one click.

## 2. Create an internal app

Console → **App Development** → **Internal Apps** → **Create App** (verify in console — UI may change). Enter a name and description.

## 3. Get the Client ID (the secret comes later)

App → **Credentials & Basic Info**:
- **Client ID** (formerly **AppKey**) → config key `im.dingtalk.clientId`, written in YAML as `dingtalk: { clientId: dingxxxxxxxxxxxx }` (8–64 letters, digits, `_` or `-`).
- **Client Secret** (formerly **AppSecret**) → never in the config file. Keep it for step 5.

## 4. Permissions and publish

1. App → **Permission Management**: apply for the permissions your users need (verify in console — UI may change). At minimum, enable the personal-info read permission, which the server uses to read the signed-in user's own profile and map their identity (`Contact.User.Read`; verify in console — UI may change). Add org-level permissions (contacts, calendar, docs, …) as needed. Some need admin approval.
2. **Publish** the app version so it is available to members. Limit the visible range to the users who should use the service.

Config key `im.dingtalk.scopes`: OAuth scopes requested at authorization. Default `[openid, corpid]`. `corpid` puts the token in the organization context; leave it in.

Don't guess scope names for individual tools. When a call lacks a permission, the tool result returns the error code `missing_scope` with `required_scopes` and an `authorize_url`. Add the permission in the console, then the user opens the link.

## 5. After deploy: store the Client Secret

```bash
npm run secret:set-im-app -- -c config=config/deploy.yaml
```

It prompts for the Client Secret (no echo), validates the pair against DingTalk (`oauth2/accessToken`), and writes Secrets Manager `<slug>/im-app` = `{"appId": "<Client ID>", "appSecret": "<Client Secret>", "configured": true}`. The keys are `appId`/`appSecret` for every IM; for DingTalk `appId` holds the Client ID. On failure it prints `dingtalk rejected the credentials: HTTP …` and stores nothing. `--no-validate` skips the check.

## 6. After deploy: register the redirect URL

Stack output `CallbackUrl` (= `<base>/callback`). `ImConsoleCallbackHint` links to the DingTalk app list.

App → **Security Settings** → **Redirect URL** (labelled "callback domain" in some console versions) → add `CallbackUrl` → save (verify in console — UI may change).

Give users the stack output `McpUrl` (= `<base>/mcp`).

## 7. Connect a client

- **Amazon Quick** (AWS Global): [client-amazon-quick.md](client-amazon-quick.md), with **Default OAuth app**. Only the sign-in page in step 4 is DingTalk's.
- **Kiro / Claude Code / Codex / Cursor**: see the [README](../../README.md#connect-an-mcp-client).

## Config and secret mapping

| Value | Where |
|---|---|
| `im: dingtalk` | `config/deploy.yaml` |
| Client ID (AppKey) | `im.dingtalk.clientId` (YAML: `dingtalk: { clientId: ... }`) |
| OAuth scopes | `im.dingtalk.scopes` (default `openid`, `corpid`) |
| Client Secret (AppSecret) | After deploy: `npm run secret:set-im-app` → `<slug>/im-app` `{appId: <Client ID>, appSecret, configured: true}` |
| Redirect URL | Stack output `CallbackUrl` → DingTalk console → Security Settings |
| CLI access | DingTalk developer platform → CLI Access Management (admin) |

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Tool result `im_admin_action_required`, message mentions `cli_not_enabled` | Org has not enabled CLI access | Step 1 (admin) |
| Tool result `im_admin_action_required`, message mentions `user_forbidden` | User is not allowed by the org's CLI access policy | Admin approves the user's request or widens the policy |
| Authorization page error about redirect URI | `CallbackUrl` not registered, or a different host (custom domain vs API Gateway URL) | Step 6. Register the exact URL you deployed with |
| Tool result `missing_scope` | App lacks that permission, or the user hasn't granted it | Add the permission (step 4), publish if required, user opens `authorize_url` |
| Tool result `im_reauth_required` | DingTalk rejected the user token (expired or revoked) | User disconnects and reconnects the MCP server |
| Personal (non-org) account gets permission errors | Org-level APIs need an org context | Use an account in the organization |
| `secret:set-im-app` prints `dingtalk rejected the credentials` | Wrong Client ID/Secret pair | Re-run with the right secret |
| Tool result `im_app_not_configured` | Client Secret never stored | Step 5 |

## Capability boundaries

- Acts only as the signed-in user. Messages appear with the user's own name and avatar.
- **CLI access must stay enabled by the org admin.** Disabling it breaks every user.
- The service refreshes DingTalk user tokens server-side every 30 minutes. A user who is inactive for a long period, or whose authorization the admin resets, must re-authorize.
- Commands that start local processes or daemons (for example `dingtalk-tag connect`) and tools that need a local file are marked unavailable.
- DingTalk international (`dingtalk.io`) is not supported in this version.

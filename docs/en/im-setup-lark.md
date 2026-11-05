[Chinese](../zh-CN/im-setup-lark.md) | English

# Lark app setup (`im: lark`)

Lark (international, open.larksuite.com) and Feishu (China, open.feishu.cn) are **separate platforms**. An app created on one does not work on the other. If your tenant is on Feishu, use [im-setup-feishu.md](im-setup-feishu.md).

Do steps 1–5 **before** deploying and steps 6–7 **after** the first deploy.

Developer console: https://open.larksuite.com/app

> The Lark developer console has the same layout as Feishu (English labels). For screenshots of each step, see the [Feishu guide](im-setup-feishu.md).

## 1. Create a custom app

Sign in to the developer console → **Create Custom App** → enter a name, description, and icon → **Create**.

## 2. Get the App ID (the secret comes later)

App → **Credentials & Basic Info**:
- **App ID** (`cli_` followed by 8–32 letters and digits) → config key `im.lark.appId`, written in YAML as `lark: { appId: cli_xxxxxxxxxxxxxxxx }`.
- **App Secret** → never in the config file. Keep it for step 6.

## 3. Enable permission scopes

App → **Permissions & Scopes** → **Import/Export** (verify in console — UI may change) → paste the scope JSON.

- Use the generated list in [`config/scopes/feishu.json`](../../config/scopes/feishu.json) (shared by Feishu and Lark; produced by `npm run gen:catalog`). It covers the tier-1 tools plus `offline_access`.
- User identity only: all scopes go under `user`, and `tenant` stays empty.
- `offline_access` is **required** (refresh token).
- Scope names are the same as on Feishu. Some scopes may not exist on Lark, and bulk import rejects them with "permission does not exist". Remove those entries and import again (verify in console — UI may change). If you remove scopes, also set `im.lark.scopes` to the list you kept, so authorization does not ask for a scope the app lacks.

Config key `im.lark.scopes`: scopes requested at authorization. **Default (key unset): every `user` scope in `config/scopes/feishu.json`.** Tools that need a scope the user has not granted return `missing_scope` with an `authorize_url`.

## 4. Set availability

App → **Availability**: limit it to the members who should use the service. Only members in scope can authorize.

## 5. Publish a version

App → **Version Management & Release** → create → submit for admin approval. Every scope change needs a new version.

## 6. After deploy: store the App Secret

```bash
npm run secret:set-im-app -- -c config=config/deploy.yaml
```

It prompts for the App Secret (no echo), validates it against Lark, and writes Secrets Manager `<slug>/im-app` = `{"appId": "...", "appSecret": "...", "configured": true}`. On failure it prints `lark rejected the credentials: …` and stores nothing. `--no-validate` skips the check.

## 7. After deploy: register the callback URL

Stack output `CallbackUrl` (= `<base>/callback`; `ImConsoleCallbackHint` links to the console page). App → **Security Settings** → **Redirect URLs** → paste → **Add**. Register the full path; query strings and fragments can be left off.

Give users the stack output `McpUrl` (= `<base>/mcp`).

## 8. Connect a client

- **Amazon Quick** (AWS Global): [client-amazon-quick.md](client-amazon-quick.md), with **Default OAuth app**. The screens are the same as for Feishu.
- **Kiro / Claude Code / Codex / Cursor**: see the [README](../../README.md#connect-an-mcp-client).

## Config and secret mapping

| Value | Where |
|---|---|
| `im: lark` | `config/deploy.yaml` |
| App ID | `im.lark.appId` (YAML: `lark: { appId: ... }`) |
| Authorization scopes | `im.lark.scopes` (default = `config/scopes/feishu.json` `scopes.user`) |
| App Secret | After deploy: `npm run secret:set-im-app` → `<slug>/im-app` `{appId, appSecret, configured: true}` |
| Callback URL | Stack output `CallbackUrl` → Lark console → Security Settings → Redirect URLs |

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `redirect_uri unmatch` / error 20029 | Callback not registered, or registered on Feishu instead of Lark | Step 7 on open.larksuite.com |
| Bulk import fails: "permission does not exist" | The scope is not offered on Lark | Remove those entries, re-import, and set `im.lark.scopes` to match |
| User can't authorize | Outside Availability, or the version is not approved | Steps 4–5 |
| Tool result `missing_scope` | Scope not enabled, or not granted by the user | Enable it, publish, user opens `authorize_url` |
| `secret:set-im-app` prints `lark rejected the credentials` | Wrong secret, or an app created on Feishu | Re-run with the right secret; check `im` |
| Tool result `im_app_not_configured` | App Secret never stored | Step 6 |

## Capability boundaries

- User identity only. No bot, broadcast, or events.
- Deploying `im: lark` to an AWS China region is supported, but traffic from China to Lark's international endpoints crosses the border. Latency and reachability depend on your network (no optimization in this sample).
- Tools that need a local file inside the server are marked unavailable.

Official docs: [Configure redirect URLs](https://open.larksuite.com/document/server-docs/getting-started/authen-v1/redirect-urls)

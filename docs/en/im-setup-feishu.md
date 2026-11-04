[Chinese](../zh-CN/im-setup-feishu.md) | English

# Feishu app setup (`im: feishu`)

Feishu (China, open.feishu.cn) and Lark (international, open.larksuite.com) are **separate platforms**. An app created on one does not work on the other. If your tenant is on Lark, use [im-setup-lark.md](im-setup-lark.md).

The deployment does not create the app. Do steps 1–5 **before** deploying. Do steps 6–7 **after** the first deploy: the deploy creates the secret that step 6 fills, and the callback URL for step 7 only exists once the stack is deployed.

Developer console: https://open.feishu.cn/app

## 1. Create a custom app

1. Sign in to the developer console with an account that is allowed to create apps in your tenant.
2. Choose **Create Custom App**. Enter a name, description, and icon, then click **Create**.

## 2. Get the App ID (the secret comes later)

App → **Credentials & Basic Info**:
- **App ID** (looks like `cli_` followed by 8–32 letters and digits) → config key `im.feishu.appId`, written in YAML as `feishu: { appId: cli_xxxxxxxxxxxxxxxx }`.
- **App Secret** → do **not** put it in the config. Keep it at hand for step 6.

## 3. Enable permission scopes

App → **Permissions & Scopes** → **Import/Export** (verify in console — UI may change) → paste the scope JSON.

- Use the generated list in [`config/scopes/feishu.json`](../../config/scopes/feishu.json). It has the shape `{"scopes": {"tenant": [], "user": [...]}}` and covers the tier-1 tools plus `offline_access`. It is produced by `npm run gen:catalog` from the pinned `lark-cli`, so it stays in step with the tools the server exposes. You can paste it into the bulk import as is.
- This project uses **user identity only**. All scopes are under `user`, and `tenant` stays empty.
- **Enable everything you might need now.** A user can only grant a scope that is already enabled in the console.
- `offline_access` is **required**: the server needs a refresh token to keep the user's token alive.
- Tools outside tier 1 (reached through `feishu_invoke`) may need more scopes. When a call lacks one, the tool result returns `missing_scope` with the scope names. Enable them, publish a new version, and the user opens the link in the result.

Config key `im.feishu.scopes`: the scopes requested at authorization. **Default (key unset): every `user` scope in `config/scopes/feishu.json`** (31 entries today). Set a shorter list to ask for less at first sign-in; tools that need more scopes then return `missing_scope` with an incremental-authorization link (`authorize_url`).

## 4. Set availability

App → **Availability**: limit it to the departments or members who should use the service. **Only members in scope can authorize.** This, not any secret, decides who can connect.

## 5. Publish a version

App → **Version Management & Release** → create a version → submit. The tenant admin approves it. **Every later scope change needs a new published version.**

## 6. After deploy: store the App Secret

```bash
npm run secret:set-im-app -- -c config=config/deploy.yaml
```

The script prompts for the App Secret without echo (or reads it from stdin), checks it against Feishu (`app_access_token`), and writes Secrets Manager `<slug>/im-app` = `{"appId": "...", "appSecret": "...", "configured": true}`. If validation fails, it prints `feishu rejected the credentials: code=… msg=…` and stores nothing. `--no-validate` skips the check (for example, from a network that cannot reach open.feishu.cn). The Lambdas pick up a new value within 5 minutes and the container within 30 minutes.

## 7. After deploy: register the callback URL

The deploy prints the stack output `CallbackUrl` (= `<base>/callback`) and `ImConsoleCallbackHint`, a direct link to this app's Security Settings page. `<base>` is the stack output `BaseUrl`: `https://<ingress.customDomain>`, the CloudFront domain when `ingress.edge: cloudfront`, or the API Gateway URL.

App → **Security Settings** → **Redirect URLs** → paste `CallbackUrl` → **Add**.

- Register the full path. Query strings (`?…`) and fragments (`#…`) don't need to be included.
- If you later add or change `ingress.customDomain` or `ingress.edge`, register the new callback URL too.

Then give users the MCP endpoint, stack output `McpUrl` (= `<base>/mcp`).

## Config and secret mapping

| Value | Where |
|---|---|
| `im: feishu` | `config/deploy.yaml` |
| App ID | `im.feishu.appId` (YAML: `feishu: { appId: ... }`) |
| Authorization scopes | `im.feishu.scopes` (list; default = `config/scopes/feishu.json` `scopes.user`) |
| App Secret | After deploy: `npm run secret:set-im-app` → Secrets Manager `<slug>/im-app` `{appId, appSecret, configured: true}` |
| Callback URL | Stack output `CallbackUrl` → Feishu console → Security Settings → Redirect URLs |

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Authorization page shows error **20029**, or `redirect_uri unmatch` | Callback URL not registered, or registered on the wrong platform (Lark instead of Feishu) | Step 7. Check the exact URL, including `https://` and `/callback` |
| User can't authorize / "no permission to use the app" | User is outside **Availability**, or the version isn't approved | Steps 4–5 |
| Tool result `missing_scope` | Scope not enabled in the console, or the user never granted it | Enable the scope, publish a new version, then the user opens `authorize_url` from the tool result (or reconnects) |
| `secret:set-im-app` prints `feishu rejected the credentials` | Wrong App ID / App Secret, or an app created on Lark | Re-run with the right secret. Check that `im` matches the platform |
| `secret:set-im-app` fails with `ResourceNotFoundException` | Run before the first deploy | Deploy first, then run it |
| Tool result `im_app_not_configured` | The App Secret was never stored (the secret still holds its placeholder) | Step 6 |
| Sessions stop after some days | `offline_access` not enabled, so there is no refresh token | Enable it, publish, and users reconnect |

## Capability boundaries

- Acts only as the signed-in user. No bot messages, broadcast, or event subscriptions.
- Scope changes reach existing users only after a new version is published **and** the user grants the new scope.
- A Feishu app can't serve a Lark tenant, and vice versa.
- Tools that need a local file inside the server (upload from or download to a path) are marked unavailable, because a remote MCP client cannot pass files into the microVM.

Official docs: [Configure redirect URLs](https://open.feishu.cn/document/uYjL24iN/uYjN3QjL2YzN04iN2cDN)

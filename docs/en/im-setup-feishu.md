[Chinese](../zh-CN/im-setup-feishu.md) | English

# Feishu app setup (`im: feishu`)

Feishu (China, open.feishu.cn) and Lark (international, open.larksuite.com) are **separate platforms**. An app created on one does not work on the other. If your tenant is on Lark, use [im-setup-lark.md](im-setup-lark.md).

The deployment does not create the app. Do steps 1–5 **before** deploying and step 6 **after** the first deploy, because the callback URL only exists once the stack is deployed.

Developer console: https://open.feishu.cn/app

## 1. Create a custom app

1. Sign in to the developer console with an account that is allowed to create apps in your tenant.
2. Choose **Create Custom App**. Enter a name, description, and icon, then click **Create**.

## 2. Get App ID and App Secret

App → **Credentials & Basic Info**:
- **App ID** (looks like `cli_xxxxxxxx`) → config key `im.feishu.appId`
- **App Secret** → do **not** put it in the config. Run:

```bash
npm run secret:set-im-app
# prompts for the secret (no echo) and writes Secrets Manager <slug>/im-app = {"appId": "...", "appSecret": "..."}
```

## 3. Enable permission scopes

App → **Permissions & Scopes** → **Import/Export** (verify in console — UI may change) → paste a JSON list of scopes.

- This project uses **user identity only**. Put all scopes under `user` and leave `tenant` empty.
- **Enable everything you might need now.** A user can only grant a scope that is already enabled in the console. Enabling a scope does not widen what users are asked at first sign-in, because that is controlled by `im.feishu.scopes`.
- `offline_access` is **required**: the server needs a refresh token to keep the user's token alive.

Minimum set that the tier-1 tools rely on (sourced from the Feishu reference sample):

| Feature | Scopes |
|---|---|
| Token refresh | `offline_access` |
| User profile | `contact:user.base:readonly` |
| Calendar read | `calendar:calendar:read`, `calendar:calendar.event:read` |
| Message search / read | `im:message:readonly`, `im:chat:read`, `search:message` |
| Send message as user | `im:message.send_as_user` |
| Doc search | `search:docs:read`, `space:document:retrieve` |
| Base (Bitable) read/write | `base:record:read`, `base:record:create`, `base:record:update` |

The full bulk-import list for all tools ships in the repo (path TBD, see spec OQ-4).

Config key `im.feishu.scopes`: the scopes requested at **first** authorization (keep it small). Lower-frequency tools ask for more scopes on first use through an incremental-authorization link.

## 4. Set availability

App → **Availability**: limit it to the departments or members who should use the service. **Only members in scope can authorize.** This, not any secret, decides who can connect.

## 5. Publish a version

App → **Version Management & Release** → create a version → submit. The tenant admin approves it. **Every later scope change needs a new published version.**

## 6. After deploy: register the callback URL

The deploy output prints `<base>/callback`, where `<base>` is `https://<ingress.customDomain>` or the API Gateway URL.

App → **Security Settings** → **Redirect URLs** → paste `<base>/callback` → **Add**.

- Register the full path. Query strings (`?…`) and fragments (`#…`) don't need to be included.
- If you later add or change `ingress.customDomain`, register the new callback URL too.

Then give users the MCP endpoint `<base>/mcp`.

## Config and secret mapping

| Value | Where |
|---|---|
| `im: feishu` | `config/deploy.yaml` |
| App ID | `im.feishu.appId` |
| First-authorization scopes | `im.feishu.scopes` (list) |
| App Secret | `npm run secret:set-im-app` → Secrets Manager `<slug>/im-app` `{appId, appSecret}` |
| Callback URL | Feishu console → Security Settings → Redirect URLs |

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Authorization page shows error **20029**, or `redirect_uri unmatch` | Callback URL not registered, or registered on the wrong platform (Lark instead of Feishu) | Step 6. Check the exact URL, including `https://` and `/callback` |
| User can't authorize / "no permission to use the app" | User is outside **Availability**, or the version isn't approved | Steps 4–5 |
| Tool returns "permission denied" or a missing-scope error | Scope not enabled in the console, or the user never granted it | Enable the scope, publish a new version, then the user opens the incremental-authorization link in the tool result (or reconnects) |
| Deploy says the app credentials are invalid | Wrong App ID / App Secret, or an app created on Lark | Re-run `npm run secret:set-im-app`. Check that `im` matches the platform |
| Sessions stop after some days | `offline_access` not enabled, so there is no refresh token | Enable it, publish, and users reconnect |

## Capability boundaries

- Acts only as the signed-in user. No bot messages, broadcast, or event subscriptions.
- Scope changes reach existing users only after a new version is published **and** the user grants the new scope.
- A Feishu app can't serve a Lark tenant, and vice versa.

Official docs: [Configure redirect URLs](https://open.feishu.cn/document/uYjL24iN/uYjN3QjL2YzN04iN2cDN)

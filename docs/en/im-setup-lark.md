[Chinese](../zh-CN/im-setup-lark.md) | English

# Lark app setup (`im: lark`)

Lark (international, open.larksuite.com) and Feishu (China, open.feishu.cn) are **separate platforms**. An app created on one does not work on the other. If your tenant is on Feishu, use [im-setup-feishu.md](im-setup-feishu.md).

Do steps 1–5 **before** deploying and step 6 **after** the first deploy.

Developer console: https://open.larksuite.com/app

## 1. Create a custom app

Sign in to the developer console → **Create Custom App** → enter a name, description, and icon → **Create**.

## 2. Get App ID and App Secret

App → **Credentials & Basic Info**:
- **App ID** (`cli_xxxxxxxx`) → config key `im.lark.appId`
- **App Secret** → run `npm run secret:set-im-app`, which writes Secrets Manager `<slug>/im-app` = `{"appId": "...", "appSecret": "..."}`. Never put it in the config file.

## 3. Enable permission scopes

App → **Permissions & Scopes** → **Import/Export** (verify in console — UI may change) → paste the scope JSON.

- User identity only: all scopes go under `user`, and `tenant` stays empty.
- `offline_access` is **required** (refresh token).
- Scope names are the same as on Feishu. Some scopes may not exist on Lark, and bulk import rejects them with "permission does not exist". Remove those entries and import again (verify in console — UI may change).

Minimum set used by tier-1 tools:

| Feature | Scopes |
|---|---|
| Token refresh | `offline_access` |
| User profile | `contact:user.base:readonly` |
| Calendar read | `calendar:calendar:read`, `calendar:calendar.event:read` |
| Message search / read | `im:message:readonly`, `im:chat:read`, `search:message` |
| Send message as user | `im:message.send_as_user` |
| Doc search | `search:docs:read`, `space:document:retrieve` |
| Base read/write | `base:record:read`, `base:record:create`, `base:record:update` |

Config key `im.lark.scopes` = scopes requested at first authorization.

## 4. Set availability

App → **Availability**: limit it to the members who should use the service. Only members in scope can authorize.

## 5. Publish a version

App → **Version Management & Release** → create → submit for admin approval. Every scope change needs a new version.

## 6. After deploy: register the callback URL

Deploy output → `<base>/callback`. App → **Security Settings** → **Redirect URLs** → paste → **Add**. Register the full path; query strings and fragments can be left off.

Give users `<base>/mcp`.

## Config and secret mapping

| Value | Where |
|---|---|
| `im: lark` | `config/deploy.yaml` |
| App ID | `im.lark.appId` |
| First-authorization scopes | `im.lark.scopes` |
| App Secret | `npm run secret:set-im-app` → `<slug>/im-app` `{appId, appSecret}` |
| Callback URL | Lark console → Security Settings → Redirect URLs |

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `redirect_uri unmatch` / error 20029 | Callback not registered, or registered on Feishu instead of Lark | Step 6 on open.larksuite.com |
| Bulk import fails: "permission does not exist" | The scope is not offered on Lark | Remove those entries and re-import |
| User can't authorize | Outside Availability, or the version is not approved | Steps 4–5 |
| Missing-scope error in a tool | Scope not enabled, or not granted by the user | Enable it, publish, user re-authorizes via the link |

## Capability boundaries

- User identity only. No bot, broadcast, or events.
- Deploying `im: lark` to an AWS China region is supported, but traffic from China to Lark's international endpoints crosses the border. Latency and reachability depend on your network (no optimization in this sample).

Official docs: [Configure redirect URLs](https://open.larksuite.com/document/server-docs/getting-started/authen-v1/redirect-urls)

[Chinese](../zh-CN/im-setup-dingtalk.md) | English

# DingTalk app setup (`im: dingtalk`)

The service calls DingTalk through the official `dws` CLI, as each user, with that user's OAuth token. You need:
1. an **internal app** that users authorize through OAuth, and
2. **CLI access enabled** for your organization (an admin action, needed once).

Do steps 1–4 **before** deploying and step 5 **after** the first deploy.

Developer console: https://open-dev.dingtalk.com

## 1. Enable CLI access for the organization (admin)

https://open-dev.dingtalk.com → **CLI Access Management** → **Enable** (verify in console — UI may change).

- This is enabled once for the whole organization.
- Without it, `dws` calls fail with `cli_not_enabled` (org not enabled) or `user_forbidden` (user not allowed). Users may also see a prompt to **Apply Now**. The admin then gets an approval card and can approve with one click.

## 2. Create an internal app

Console → **App Development** → **Internal Apps** → **Create App** (verify in console — UI may change). Enter a name and description.

## 3. Get Client ID and Client Secret

App → **Credentials & Basic Info**:
- **Client ID** (formerly **AppKey**) → config key `im.dingtalk.clientId`
- **Client Secret** (formerly **AppSecret**) → never in the config file. Run:

```bash
npm run secret:set-im-app
# writes Secrets Manager <slug>/im-app = {"clientId": "...", "clientSecret": "..."}
```

## 4. Permissions and publish

1. App → **Permission Management**: apply for the permissions your users need (verify in console — UI may change). At minimum, enable the personal-info read permission, which the server uses to read the signed-in user's own profile and map their identity (`Contact.User.Read`; verify in console — UI may change). Add org-level permissions (contacts, calendar, docs, …) as needed. Some need admin approval.
2. **Publish** the app version so it is available to members. Limit the visible range to the users who should use the service.

Config key `im.dingtalk.scopes`: OAuth scopes requested at authorization. Default `openid corpid`. `corpid` puts the token in the organization context; leave it in.

Don't guess scope names for individual tools. When a call lacks a permission, the tool result returns a `permission_required` error with an authorization link. Add the permission in the console, then the user opens the link.

## 5. After deploy: register the redirect URL

Deploy output → `<base>/callback`.

App → **Security Settings** → **Redirect URL** (labelled "callback domain" in some console versions) → add `<base>/callback` → save (verify in console — UI may change).

Give users `<base>/mcp`.

## Config and secret mapping

| Value | Where |
|---|---|
| `im: dingtalk` | `config/deploy.yaml` |
| Client ID (AppKey) | `im.dingtalk.clientId` |
| OAuth scopes | `im.dingtalk.scopes` (default `openid`, `corpid`) |
| Client Secret (AppSecret) | `npm run secret:set-im-app` → `<slug>/im-app` `{clientId, clientSecret}` |
| Redirect URL | DingTalk console → Security Settings |
| CLI access | DingTalk developer platform → CLI Access Management (admin) |

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Error mentions `cli_not_enabled` | Org has not enabled CLI access | Step 1 (admin) |
| Error mentions `user_forbidden` | User is not allowed by the org's CLI access policy | Admin approves the user's request or widens the policy |
| Authorization page error about redirect URI | `<base>/callback` not registered, or a different host (custom domain vs API Gateway URL) | Step 5. Register the exact URL you deployed with |
| `permission_required` in a tool result | App lacks that permission, or the user hasn't granted it | Add the permission (step 4), publish if required, user opens the returned link |
| Personal (non-org) account gets permission errors | Org-level APIs need an org context | Use an account in the organization |
| Deploy reports invalid app credentials | Wrong Client ID/Secret pair | Re-run `npm run secret:set-im-app` |

## Capability boundaries

- Acts only as the signed-in user. Messages appear with the user's own name and avatar.
- **CLI access must stay enabled by the org admin.** Disabling it breaks every user.
- The service refreshes DingTalk user tokens server-side. A user who is inactive for a long period, or whose authorization the admin resets, must re-authorize.
- DingTalk international (`dingtalk.io`) is not supported in this version.

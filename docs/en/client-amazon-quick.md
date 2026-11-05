[Chinese](../zh-CN/client-amazon-quick.md) | English

# Connect Amazon Quick (AWS Global regions only)

Amazon Quick is not available in AWS China. In China, use Kiro, Claude Code, Codex, or Cursor.

## Before you start

- The stack is deployed and `npm run secret:set-im-app` has stored the IM app secret ([deploy guide](deploy.md)).
- The stack output `CallbackUrl` is registered in the IM developer console (for Feishu/Lark: **Security Settings → Redirect URLs**).
- You have an Amazon Quick Enterprise subscription.

You only need one value from the stack: **`McpUrl`** (`<base>/mcp`). Get it with:

```bash
aws cloudformation describe-stacks --stack-name ImMcp-<slug> --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='McpUrl'].OutputValue" --output text
```

## How authentication works

The server is its own OAuth 2.1 authorization server and supports **Dynamic Client Registration (DCR)**. Amazon Quick discovers it automatically:

1. Quick sends an unauthenticated request to `McpUrl` and receives `401` with `WWW-Authenticate: Bearer resource_metadata=...`.
2. Quick reads `<base>/.well-known/oauth-protected-resource`, then `<base>/.well-known/oauth-authorization-server`.
3. Quick registers itself at `<base>/register` (DCR). Its callback host `*.quicksight.aws.amazon.com` is allowed automatically in AWS Global regions.
4. When a user connects, Quick opens `<base>/authorize`, which forwards to the IM sign-in (Feishu/Lark/DingTalk OAuth, or the WeCom QR page). The user signs in **as themselves**.

You do **not** need to type a Client ID, Client Secret, Token URL, or Authorization URL. Because DCR is supported, Quick does not ask for them.

## Steps

1. In the Amazon Quick console, open **Connectors** → **Create for your team** → **Model Context Protocol (MCP)**.
2. On **Create Integration**:
   - **Name**: for example `Feishu`.
   - **Description** (optional).
   - **MCP server endpoint**: the `McpUrl` value.
   - **Connection type**: **Public network**.
   - **Auth server connection type**: **Public network**.
3. Choose **Next**. Choose **User authentication (OAuth)**. Quick registers itself through DCR.
4. Choose **Create and continue**. Quick opens the sign-in page. Sign in with your IM account and approve the requested permissions.
5. Review the discovered tools (actions) and choose **Next**. Share the integration with other users if needed. Each user who uses it signs in with their own IM account.

## Notes and limits

| Item | Detail |
|---|---|
| Tool count | Quick registers at most 100 tools per connection. This server lists 28–34 tools (tier 1 plus `<im>_discover` / `<im>_invoke`). |
| Timeout | Quick fails MCP calls after 5 minutes. Tool calls here time out at about 25 seconds. |
| New tools | Custom connectors don't auto-sync. After you upgrade the server, open the connector and choose **Sync**. |
| Missing IM permission | The tool result returns `missing_scope` with an `authorize_url`. Enable the scope in the IM console, publish a new app version, then open the link (or reconnect the connector). Quick itself does not do step-up authorization. |
| Sessions | MCP access tokens last 1 hour and are refreshed by Quick with a rotating refresh token (90 days). The IM token is refreshed by the server every 30 minutes. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Quick reports it can't register a client | Redirect host not allowed (for example, a Quick domain outside `*.quicksight.aws.amazon.com`) | Add the host to `oauth.extraRedirectHosts` and redeploy |
| IM sign-in page shows a redirect error (Feishu error **20029**) | `CallbackUrl` not registered in the IM console | Register it (see the IM setup guide) |
| Sign-in works, then every tool returns `im_app_not_configured` | The IM app secret was never stored | `npm run secret:set-im-app` |
| `Creation failed` at publish | A tool `inputSchema` is invalid | Report it as a bug with the tool name; schemas here are JSON Schema draft 7 |

Official reference: [MCP integration in Amazon Quick](https://docs.aws.amazon.com/quick/latest/userguide/mcp-integration.html).

[Chinese](../zh-CN/client-amazon-quick.md) | English

# Connect Amazon Quick (AWS Global regions only)

Amazon Quick is not available in AWS China. In China, use Kiro, Claude Code, Codex, or Cursor.

## Before you start

- The stack is deployed and `npm run secret:set-im-app` has stored the IM app secret ([deploy guide](deploy.md)).
- The stack output `CallbackUrl` is registered in the IM developer console (for Feishu/Lark: **Security Settings → Redirect URLs**). Without it, IM sign-in fails (Feishu error **20029**).
- You have an Amazon Quick Enterprise subscription.

Get the MCP endpoint (stack output `McpUrl`, `<base>/mcp`):

```bash
aws cloudformation describe-stacks --stack-name ImMcp-<slug> --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='McpUrl'].OutputValue" --output text
```

## How authentication works

The server is its own OAuth 2.1 authorization server. Quick discovers it from the MCP endpoint:

1. `GET <base>/mcp` → `401` with `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<base>/.well-known/oauth-protected-resource"`.
2. `<base>/.well-known/oauth-protected-resource` → authorization server = `<base>`, `scopes_supported: ["mcp", "offline_access"]`.
3. `<base>/.well-known/oauth-authorization-server` → `authorize`, `token`, and `registration_endpoint` (`<base>/register`), `token_endpoint_auth_methods_supported: ["none", "client_secret_post"]`.
4. Quick registers itself (Dynamic Client Registration) or uses a Client ID you entered. Its callback host `*.quicksight.aws.amazon.com` is allowed automatically in AWS Global regions.
5. When a user connects, `<base>/authorize` forwards to the IM sign-in (Feishu/Lark/DingTalk OAuth, or the WeCom QR page). Each user signs in **as themselves**.

Quick reads scopes only from the metadata documents, never from the 401 challenge. Both documents therefore declare `mcp` and `offline_access`, so Quick asks for scopes the server recognizes.

## Path A: dynamic registration (try first)

1. In Amazon Quick, open **Connectors** → **Create for your team** → **Model Context Protocol**. If asked about an existing MCP connector, choose **No, create new**.
2. **Connect** step:
   - **Name**: for example `Feishu`. **Description** (optional).
   - **MCP server endpoint**: the `McpUrl` value.
   - **Connection type**: **Public network**. **Auth server connection type** (if shown): **Public network**.
   - Choose **Next**.
3. **Authenticate** step: choose **User authentication**.
   - If the page does **not** ask for Client ID / Client secret, Quick registers itself. Choose **Create and continue** and go to step 4.
   - If the form **requires** Client ID / Client secret / Token URL / Authorization URL, use **Path B** below and fill the fields there.
4. A browser window opens the IM sign-in page. Sign in and approve. Quick shows "Returning to Quick".
5. **Review**: Quick lists the discovered tools (28–34). Choose **Next**.
6. **Publish**: choose who can use the connector (only you, or everyone in your organization), then **Publish**. Each user who uses it signs in with their own IM account the first time.

## Path B: manual client (when the form requires Client ID)

1. On your deploy machine, register a client for Quick:

   ```bash
   npm run register-client -- -c config=config/deploy.yaml
   ```

   Output (one line per form field):

   ```
   MCP server endpoint      https://<base>/mcp
   Client ID                c1.eyJ...
   Client secret            <secret>
   Token URL                https://<base>/token
   Authorization URL        https://<base>/authorize
   Redirect URL (allowed)   https://<region>.quicksight.aws.amazon.com/sn/oauthcallback
                            https://us-east-1.quicksight.aws.amazon.com/sn/oauthcallback
   ```

2. Compare **Redirect URL** in the Quick form (read-only, usually `https://us-east-1.quicksight.aws.amazon.com/sn/oauthcallback`) with the allowed list. If it is not listed, run the command again with `--redirect-uri <the URL Quick shows>` (repeatable, up to 5) and use the new values.
3. Fill the Quick form:

   | Quick field | Value |
   |---|---|
   | Client ID | `Client ID` from the output |
   | Public OAuth client | Leave unticked |
   | Client secret | `Client secret` from the output |
   | Token URL | `Token URL` from the output |
   | Authorization URL | `Authorization URL` from the output |

4. Choose **Create and continue**, then continue with Path A steps 4–6.

Notes:
- `--public` registers a public client instead (tick **Public OAuth client**, leave Client secret empty).
- The client secret is a credential: paste it into Quick, don't commit or share it. It is derived from the stack's root key and not stored; rotating the root key (`<slug>/root-key`) revokes every client and every MCP token.
- One client can be shared by every Quick user. Users still sign in individually.

## Notes and limits

| Item | Detail |
|---|---|
| Tool count | Quick registers at most 100 tools per connection. This server lists 28–34 tools (tier 1 plus `<im>_discover` / `<im>_invoke`). |
| Timeout | Quick fails MCP calls after 5 minutes. Tool calls here time out at about 25 seconds. |
| New tools | Custom connectors don't auto-sync. After you upgrade the server, open the connector and choose **Sync**. |
| Missing IM permission | The tool result returns `missing_scope` with an `authorize_url`. Enable the scope in the IM console, publish a new app version, then open the link (or reconnect the connector). Quick itself does not do step-up authorization. |
| Sessions | MCP access tokens last 1 hour; Quick renews them with a rotating refresh token (90 days). The server refreshes the IM token every 30 minutes. |

## Troubleshooting

Check the API access log (`/aws/apigateway/im-mcp-<slug>-access`) to see how far Quick got. A Quick attempt shows `GET /mcp 401`, then both `.well-known` documents, then `POST /register` (Path A only), `GET /authorize`, `POST /token`.

| Symptom | Cause | Fix |
|---|---|---|
| Form requires Client ID even though DCR is advertised | This Quick console version doesn't use DCR for this form | Path B |
| Token exchange fails with `invalid_client` | Client secret mistyped, or the client was registered against another stack | Run `npm run register-client` for this stack and paste again |
| Sign-in page says the redirect URI is not registered | Quick's Redirect URL is not in the client's list | `npm run register-client -- --redirect-uri <Quick's Redirect URL>` |
| DCR is rejected | Quick's callback host is outside `*.quicksight.aws.amazon.com` | Add it to `oauth.extraRedirectHosts` and redeploy |
| IM sign-in page shows a redirect error (Feishu **20029**) | `CallbackUrl` not registered in the IM console | Register it (see the IM setup guide) |
| Sign-in works, then every tool returns `im_app_not_configured` | The IM app secret was never stored | `npm run secret:set-im-app` |
| `Creation failed` at publish | A tool `inputSchema` is invalid | Report it with the tool name; schemas here are JSON Schema draft 7 |

Official reference: [MCP integration in Amazon Quick](https://docs.aws.amazon.com/quick/latest/userguide/mcp-integration.html).

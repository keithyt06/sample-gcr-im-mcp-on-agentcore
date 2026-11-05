[Chinese](../zh-CN/testing.md) | English

# Testing

Three layers:

1. **Automated tests** (no AWS, no IM): `npm test`.
2. **Infra end-to-end** against a deployed stack, with no IM credentials: `npm run e2e`, or `npm run e2e:internal` for AWS China without ICP.
3. **Real-tenant manual checklist** (G2b), run by the repo owner with a real IM app and real users.

## 1. Automated tests

```bash
npm ci
npm run build          # tsc type check
npm test               # vitest: infra, lambda, container
npm run synth:matrix   # only the synth matrix
```

| Suite | What it covers |
|---|---|
| `test/infra/config.test.ts` | Every config validation rule, defaults, partition derived from `region`, secret-looking keys rejected |
| `test/infra/matrix.test.ts` | Synthesizes 4 IMs × 2 partitions (plus CloudFront/WAF and custom-domain variants) and asserts: no `arn:aws:` literal and no CloudFront/WAF in AWS China templates, Runtime trust principal, header allowlist, no `bedrock:InvokeModel`, MCP protocol, route throttles, refresh Lambda and IM app secret only for redirect IMs |
| `test/infra/iam.test.ts`, `nag.test.ts`, `partition.test.ts` | IAM `*` allowlist, cdk-nag AwsSolutions, partition helpers |
| `test/lambda/*` | OAuth AS (well-known, DCR, authorize, callback, token, refresh rotation and replay), WeCom QR flow (approval, revocation, slot replacement), middleware, token crypto, DynamoDB store, IM adapters, refresh Lambda, alarm Lambda |
| `test/container/*` | MCP server with fake CLIs (`test/container/fakes/`): tools/list, discover/invoke, `_confirm` gate, argv per IM, environment isolation, error mapping, WeCom credential write-back and auth flow, catalog consistency |
| `test/container/dws-isolation.test.ts` | Skipped by default. With the **real** `dws` binary, two users alternate calls and each must send their own Bearer token. Must pass before any `dws` version bump |

Run the DingTalk isolation test with the real CLI (installed by `npm run gen:catalog` into `.cache/cli/`):

```bash
DWS_REAL=1 DWS_BIN=.cache/cli/dingtalk/node_modules/dingtalk-workspace-cli/vendor/dws \
  npx vitest run test/container/dws-isolation.test.ts
```

## 2. Infra end-to-end (no IM credentials)

After `npm run deploy`:

```bash
npm run e2e -- -c config=config/deploy.yaml
# or: npm run e2e -- --stack ImMcp-<slug> --region <region>
```

It reads the stack outputs and runs 8 checks, printing PASS/FAIL for each, and exits non-zero on any failure:

| # | Check | Expected |
|---|---|---|
| 1 | `GET /.well-known/oauth-authorization-server` | 200, `issuer` = `BaseUrl` |
| 2 | `GET /.well-known/oauth-protected-resource/mcp` | 200, `resource` = `McpUrl` |
| 3 | `POST /mcp` without a token | 401 with `WWW-Authenticate: Bearer resource_metadata="…"` |
| 4 | `POST /register` (DCR, loopback redirect) | 201 with `client_id` |
| 5 | `GET /authorize` with PKCE | Feishu/Lark/DingTalk: 302 to the IM login host. WeCom: 200 HTML with a QR code (exercises Lambda → Runtime control RPC) |
| 6 | Minted test token → `initialize`, `tools/list` | 200; tool names = `<im>_` + tier 1, plus `<im>_discover` and `<im>_invoke` |
| 7 | `tools/call` on a tier-1 tool | `isError: true`, code `im_not_authorized` (no IM credential for the test user) |
| 8 | 40 parallel `POST /register` | At least one 429 (route throttle) |

Step 6 uses `npm run mint-test-token` logic: it reads the root key from Secrets Manager and signs a token for the fixed test user `e2e00000000000000000000000000000`. It is a test helper only; never share its output.

**Wait about 30 seconds between two e2e runs.** Step 8 empties the `/register` token bucket on purpose, and `GET /authorize` has a tight throttle (2 rps / burst 5). A run started right after another can fail steps 4–5 with 429.

### AWS China without ICP: `e2e:internal`

In an AWS China account without ICP filing, every route on the default `execute-api` URL returns `403 {"message":"Forbidden"}` and the Lambdas are never invoked, so `npm run e2e` fails 0/8. Use:

```bash
AWS_PROFILE=<your-china-profile> AWS_REGION=cn-northwest-1 \
  npm run e2e:internal -- -c config=config/deploy.yaml
```

It invokes the oauth and middleware Lambdas directly with synthetic API Gateway events and runs steps 1–7. The middleware still calls AgentCore Runtime with SigV4, so the full backend path is covered. Step 8 needs the real ingress and is skipped. It needs `lambda:InvokeFunction` on the two functions plus read access to the root-key secret.

### Tested status

| IM | Partition / region | `npm run e2e` | `npm run e2e:internal` |
|---|---|---|---|
| feishu | AWS Global / ap-northeast-1 | 8/8 | n/a |
| dingtalk | AWS Global / ap-northeast-1 | 8/8 | n/a |
| wecom | AWS Global / ap-northeast-1 | 8/8 | n/a |
| feishu | AWS China / cn-northwest-1 | 0/8 (403, no ICP; expected) | 7/7 |
| lark | (synth matrix only) | not deployed | not deployed |
| dingtalk, wecom | AWS China (synth matrix only) | not deployed | not deployed |

Infra-level only: no real IM app credentials were used. Section 3 is the real-tenant test.

### Optional: smoke-test the Runtime directly with the AgentCore CLI

You can call the Runtime directly, without going through API Gateway or the Lambdas, with the [AgentCore CLI](https://github.com/aws/agentcore-cli) (`npm install -g @aws/agentcore`). The runtime ID is the last segment of the `RuntimeArn` stack output.

```bash
agentcore runtime invoke --id <runtime-id> \
  --mcp-method tools/list \
  --payload '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

This only checks that the container starts and lists tools. Tool calls need the custom user headers that the middleware adds, so use `npm run e2e` for anything beyond `tools/list`. This step is optional, was not part of the tested path above, and its availability in AWS China regions was not verified.

## 3. Real-tenant manual checklist (G2b)

The repo owner runs this with a real IM app and at least **two real users (A and B)** in the same tenant, against a deployment whose `npm run e2e` (or `e2e:internal`) passes. Record date, commit, region, IM, client and result for each row. Use a test tenant or test data, because several steps write real messages and documents.

### Common to all IMs

| # | Step | Pass when |
|---|---|---|
| C1 | Add `McpUrl` to Claude Code (`claude mcp add --transport http <name> <McpUrl>`) and Kiro | The client opens a browser to authorize; no client ID needed |
| C2 | User A authorizes | Tools load; `tools/list` shows tier 1 + `<im>_discover` + `<im>_invoke` |
| C3 | User A calls a read tool (for example "list my calendar events today") | Real data for A |
| C4 | User A sends a message to themself (or a test chat) | Message appears as A in the IM |
| C5 | User A asks to delete or recall something | The first call returns `user_approval_required`; it runs only after the user confirms and the agent retries with `_confirm: true` |
| C6 | `<im>_discover` with a keyword, then `<im>_invoke` on a non-tier-1 tool | Works, or returns `missing_scope` with an `authorize_url` |
| C7 | User B authorizes in a second client | B's read tools return B's data, never A's |
| C8 | `npm run users -- list` | A and B listed as `active` |
| C9 | `npm run users -- revoke <A>` | Within 60 s A's tool calls fail; A's refresh fails; within 1 hour A's existing access token stops working; re-authorizing as A is refused. B is unaffected |
| C10 | Leave the client idle over 1 hour, then call a tool | The client refreshes its MCP token silently |
| C11 | Global only: connect Amazon Quick with **Default OAuth app** ([tutorial](client-amazon-quick.md)) | Authorizes and lists tools (verified with Feishu, ap-southeast-1) |
| C12 | China with ICP-filed custom domain: repeat C1–C4 via the custom domain | Same results |

### Feishu / Lark

| # | Step | Pass when |
|---|---|---|
| F1 | Remove one scope from the user's grant (or set a short `im.feishu.scopes`), call a tool that needs it | `missing_scope`; opening `authorize_url` grants it; retry succeeds |
| F2 | Wait more than 2 hours (user token lifetime), call a tool | Succeeds without re-authorization (refresh Lambda, every 30 min) |
| F3 | Create a doc, append content, search for it | All three succeed as the user |
| F4 | Lark: repeat C2–C4 on open.larksuite.com with `im: lark` | Same results |

### DingTalk

| # | Step | Pass when |
|---|---|---|
| D1 | Before the admin enables CLI access, call a tool | `im_admin_action_required` |
| D2 | After enabling, users A and B **alternate** 10 calls each (for example `contact_user_get_self`) | Every result is the caller's own profile (two-user token isolation) |
| D3 | Wait more than 2 hours, call a tool | Succeeds (server-side refresh) |
| D4 | Call a tool whose permission the app lacks | `missing_scope` with `required_scopes` |
| D5 | Ask for `dingtalk-tag connect` through `dingtalk_invoke` | Refused: tool is unavailable |

### WeCom

| # | Step | Pass when |
|---|---|---|
| W1 | With `wecom.requireApproval: true`, user A scans and creates a new bot | Page says "waiting for operator approval"; client gets no token |
| W2 | `npm run users -- list`, then `approve <A>`; A reconnects | A's tools work |
| W3 | A reconnects later and chooses **bind existing bot** | No new approval needed; documents created earlier are still writable |
| W4 | A calls `doc_contents_append` on a doc A created in the WeCom client (not by the bot) | `im_object_permission` (851003) |
| W5 | In an org with more than 10 members, list chat messages | `im_policy_blocked` (853006) |
| W6 | After 7 days, call a tool | `im_grant_expired` (850003), `grant-expired` alarm fires (and webhook, if set). After A renews in the WeCom client, calls succeed without a QR scan |
| W7 | `revoke <A>`; A scans again | Page says access revoked |
| W8 | Open more than 3 authorization pages from one IP without scanning | The 4th returns 429 |

## Teardown after testing

```bash
npm run destroy -- -c config=config/deploy.yaml
npm run teardown:extras -- -c config=config/deploy.yaml
```

See [deploy.md](deploy.md#cleanup) for what remains.

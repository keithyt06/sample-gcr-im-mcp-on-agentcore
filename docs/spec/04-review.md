# 04 — Engineering review: sample-gcr-im-mcp-on-agentcore

Status: v1 (2026-11-04) · Reviewer: Engineering Manager · Code reviewed at HEAD `03bc9ba` (`a79f564` plus the Ops e2e commit).
Scope:
- An independent correctness and security review against `02-technical-design.md`.
- The aws-samples readiness check (`aws-samples-publish` §[1]).
- A docs-vs-code consistency check.

Every finding below was verified by reading the code, or by running it where noted. I made no source edits. Owners: dev-a = infra/config/scripts, dev-b = lambda, dev-c = container/catalogs, pm = docs and publishing, cto = contract change.

## 0. Verification run

| Check | Result |
|---|---|
| `npx vitest run` | 20 files passed, 1 skipped. 511 tests passed, 1 skipped (the skip is `dws-isolation`, which needs `DWS_REAL=1`) |
| `DWS_REAL=1 DWS_BIN=.cache/.../vendor/dws npx vitest run test/container/dws-isolation.test.ts` (real dws 1.0.67) | **passed**: two alternating users each send their own Bearer (D11) |
| `npm run build` (`tsc`) | passed |
| Partition grep (`arn:aws`, `amazonaws.com`, `us-east-1`) outside `partition.ts`/`regions.ts` | Clean. Remaining hits are allowed: the `lambda.amazonaws.com` / `bedrock-agentcore.amazonaws.com` principals, the Quick hosts in `derive()`, the WAF `us-east-1` stack, the ACM ARN regex, the `.com.cn` registry in `mirror-base-image.sh` (China-only script), and test fixtures |
| Leak scan on `git archive HEAD` | No credentials. No `@amazon.com` / internal hosts. No customer names. One 12-digit vendor example ID (see L-9). `Keith Yu` appears only in the required MIT attribution |
| Tracked artifacts | None (`cdk.out/`, `coverage/`, `.cache/`, `container/dist/`, `config/*.local.yaml` are all gitignored and untracked) |

## 1. Findings (severity-ranked)

Severity key:
- **Critical**: blocks publication, or is exploitable with serious impact.
- **High**: fix before external users.
- **Medium**: fix before P4.
- **Low**: hygiene.

### Critical

| # | File:line | Issue | Recommended fix | Owner |
|---|---|---|---|---|
| C-1 | repo root | The aws-samples required files are **absent**: `README.md`, `README.zh-CN.md`, `LICENSE` (MIT-0), `NOTICE`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `THIRD-PARTY-LICENSES`. There is also no explicit non-production disclaimer anywhere. `02-technical-design.md:46` lists all of them; `git ls-files` has none. This is a hard blocker for PCSR/OpenSourcerer (D15) | Add all seven files. README (EN): deployer + user views, a non-production disclaimer in explicit wording, a link to the docs. THIRD-PARTY-LICENSES must cover: quick-dingtalk-mcp MIT © 2026 Keith Yu (ported in `lambda/shared/adapters/dingtalk.ts`, `container/src/adapters/dingtalk.ts`); Lark sample MIT-0; WeCom sample MIT-0; and the vendor CLIs whose help text is committed in `container/tools/*/catalog.json`: `dingtalk-workspace-cli` **Apache-2.0**, `@larksuite/cli` MIT, `@wecom/cli` MIT. Licenses were checked from the installed `package.json`s | pm |

### High

| # | File:line | Issue | Recommended fix | Owner |
|---|---|---|---|---|
| H-1 | `lambda/oauth/authorize.ts:81-96`, `infra/lib/constructs/ingress.ts:77-78` | **Unauthenticated microVM amplification (wecom).** Every `GET /authorize` from any DCR client (DCR is open; loopback is always allowed) mints a fresh random `userId`. It then calls `im/auth.start`, which creates a **new AgentCore session/microVM** that runs `wecom-cli auth init` for up to 300 s. `/ping` reports `HealthyBusy` throughout, so the microVM isn't reaped. Only `/register` has a route throttle; `/authorize` gets the stage default of 50 rps / burst 100. At 50 rps × 300 s, one anonymous client can hold thousands of concurrent sessions. That is a cost attack and exhausts the AgentCore session quota (a DoS for real users). China has no WAF, so throttling is the only control | (1) Add a `GET /authorize` route throttle, e.g. `authorizeRps` 2 / burst 5 (new config key, default on). (2) For wecom, refuse a new QR start when too many QR flows are already pending. A cheap version: a DynamoDB counter item `qrpending` with TTL and a cap of N (default 20). (3) Document the WAF rate rule for `edge: cloudfront` on Global. Needs CTO sign-off (new config key) | dev-a, dev-b, cto |
| H-2 | `container/tools/dingtalk/catalog.json:50624` (`dingtalk_tag_connect`), `scripts/gen-catalog.ts:258` | **The LLM can make dws spawn a local process / daemon.** `dingtalk_invoke` exposes `dws dingtalk-tag connect` with `--agent-cmd` ("custom command; the question is the last arg, stdout is the reply"), `--agent-workdir`, `--daemon`, `--alwayson` and `--yolo`. The only gate is `_confirm:true`, which the LLM sets itself, so a prompt injection in IM content can ask for it. The blast radius is the user's own microVM: their DingTalk token is in argv, and the dingtalk runtime role only has ECR pull + logs. It is still command execution reachable from untrusted content, and Guardian will flag it | Add a denylist to `gen-catalog.ts` that marks these `unavailable` with a reason: `dingtalk-tag connect*`, `dingtalk-tag manage login`, and any command with `--daemon` / `--agent-cmd` / `--agent-workdir` / `--yolo`. Add a `catalog.test.ts` assertion that no available tool has those flags. Run the same "spawns local processes / long-running" sweep over the lark and wecom catalogs (lark `mail_watch` is long-running, but the 24 s cap kills it) | dev-c |
| H-3 | `docs/en/prerequisites.md:42-43` (+ zh-CN), `im-setup-feishu.md:22-25`, `im-setup-lark.md:19`, `im-setup-dingtalk.md:30-33` | The docs tell operators to run `npm run secret:set-im-app` **before** deploying. The script only calls `PutSecretValue` on the CDK-created `<slug>/im-app` (`scripts/secret-set-im-app.ts:92`, `infra/lib/constructs/storage.ts:49-57`), so following the docs fails with `ResourceNotFoundException` on first use | Reorder to: fill config → deploy → set the secret → register the callback. This matches the `ImAppSecretName` output text (`infra/lib/stack.ts:71`) | pm |

### Medium

| # | File:line | Issue | Recommended fix | Owner |
|---|---|---|---|---|
| M-1 | `container/src/cli-runner.ts:33`, `container/src/adapters/dingtalk.ts:38,75` | **DingTalk user token can leak into the tool result.** When a CLI dies from a signal other than the timeout SIGTERM (OOM SIGKILL, SIGSEGV), `runCli` appends Node's `e.message` to stderr. That message is `Command failed: dws --token <USER_TOKEN> …`; I reproduced the format with `execFile`. `mapResult` then returns `text.trim()` (up to 2000 chars) in a `cli_failed` envelope, so the token reaches the LLM/client transcript | In `runCli`, append only `e.signal` / `e.code`, never `e.message`. Or redact any argv element that follows `--token`. Add a test with a fake CLI that kills itself with SIGKILL | dev-c |
| M-2 | `lambda/oauth/qr.ts:25-47` | **`users revoke` doesn't stick for WeCom.** A revoked WeCom person rescans and gets a new random `userId`. `resolveSlot` then repoints `ident#wecom#<id>` to it and never checks whether the previous slot was operator-disabled (as opposed to `replacedBy`). Redirect IMs do block this (`callback.ts:56-60`). This undermines US-D6 | In `resolveSlot`: if `prev` exists and `user#prev.disabled && !replacedBy` → refuse (403-style `status:'failed', reason:'access_revoked'`) and delete the new blob. Add a test | dev-b |
| M-3 | `lambda/oauth/authorize.ts:81-96` (design §4.4) | **WeCom has no tenant boundary.** Feishu/Lark custom apps and DingTalk internal apps only admit users of the operator's tenant. The WeCom QR flow accepts anyone with a WeCom account from any organization: there is no corp/bot allowlist anywhere (grep `corp` = none). Any internet user gets a working MCP server on the operator's AWS bill. It also amplifies H-1 | Add an optional `wecom.allowedCorpIds` (or an operator-approve step), plus a doc statement in the WeCom guide and the security doc. Needs CTO sign-off | cto, dev-b, dev-c |
| M-4 | `lambda/shared/adapters/dingtalk.ts:68` | Refresh maps **every** HTTP 4xx to `revoked:true`, so the refresh Lambda deletes the user secret (`lambda/refresh/index.ts:66-75`). That includes 429 (DingTalk throttling) and 401/403 from a wrong or rotated app secret. A bad `secret:set-im-app` would wipe every user's credential in one cycle. They are recoverable for 7 days, but every user must re-authorize. This follows design §5.1 literally, but the rule is unsafe | Treat only 400 with a refresh-token-specific error code as revoked. Treat 401/403/429/408 as `failed`. Add a circuit breaker: if more than 50 % of a cycle's attempts come back revoked, stop deleting and alarm | dev-b, cto |
| M-5 | `scripts/gen-catalog.ts:160-166` | The risk heuristic lets the CLI's declared `Risk:` override name-based detection. That leaves destructive tools as `write`, so they skip the `_confirm` gate. Lark: `docs_resource_delete`, `slides_delete_slide`, `wiki_member_remove`, `apps_git_credential_remove`, `im_flag_cancel`. DingTalk (30): `chat_group_transfer_owner`, `chat_message_recall`, `chat_group_role_remove_user`, … | After the vendor risk is resolved, escalate to `high-risk-write` any tool whose name matches `delete|remove|recall|transfer_owner|revoke|clear|disband|kick`, unless an explicit allow-override applies. Regenerate the catalogs | dev-c |
| M-6 | `container/tools/lark/catalog.json` (0 `unavailable`), `container/tools/dingtalk/catalog.json` (0 `unavailable`) | **Local-file tools are exposed.** About 80 lark and about 30 dingtalk tools take local file paths (`--file`, `--output`, `--output-dir`, `--local-dir`, `@file`), but there is no way to get a file into the microVM. Only wecom marks these `unavailable` (`gen-catalog.ts:326`). The CLIs do sandbox paths (I tested lark-cli: `/proc` and `/etc` are denylisted; cwd, `/tmp` and `~/files` are allowed; dws stays under cwd), and each microVM holds one user, so this is not a cross-user leak. Still, the LLM gets tools that cannot work, and the upload tools are a needless read-and-upload channel | Apply the wecom file-path rule to lark and dingtalk in `gen-catalog.ts`, or document the deviation from §5.3 | dev-c |
| M-7 | `container/build/install-cli.sh:39,45,51` | **Supply chain.** CLI packages are installed with `npm i -g <pkg>@<ver>` and no integrity pin. In China the source is npmmirror, a third-party mirror. The lark binary is checked against `checksums.txt` from the same unverified tarball. lark-cli also pulls `@clack/prompts ^1.2.0` unpinned at build time. The resulting image handles every user's IM token | Pin each CLI tarball's `sha512` integrity (and the wecom platform package's) in `shared/versions.ts`. In `install-cli.sh`, `npm pack` and verify the hash before installing, or install from a committed lockfile (`.cache/cli/*/package-lock.json` already exists) with `npm ci --prefix` | dev-c |
| M-8 | `infra/lib/constructs/runtime.ts:60-66` | The wecom Runtime role has `GetSecretValue`/`PutSecretValue`/`CreateSecret` on **all** `<slug>/users/*`. Any code execution inside one user's wecom microVM (through a CLI bug) could read every user's WeCom credentials. This is inherent: there is one execution role and no per-session scoping | Accept and document it in `docs/en/security.md` as a known limitation. Keep the H-2 style denylist sweep for wecom as well | pm, dev-c |
| M-9 | `docs/en/` | `docs/en/security.md` (trust boundary required by design §4.6) and `docs/en/testing.md` (G2b manual checklist, design §7.4) don't exist. There are also no `docs/en/deploy.md` / operations docs (revoke, rotate root key, teardown: the KMS CMK is `RETAIN`, and runtime-created `<slug>/users/*` secrets outlive the stack) | Write them. `security.md` must cover: SigV4-only container trust; LLM-set `_confirm`; the WeCom QR phishing model (anyone you send a QR to authorizes as themselves for *your* client); M-3/M-8; access tokens staying valid ≤ 1 h after revoke; the 60 s middleware credential cache | pm |
| M-10 | `docs/spec/01..03-*.md` | Internal process docs are in the public tree: WP-A/B/C, "team lead", CTO sign-offs, CLI profile names (`gcr`), and real deploy logs (`03-ops-plan.md` §10). The skill §[1] says internal runbooks and checklists live outside the repo | Before the final commit, move `docs/spec/` to the side `*-publish/` folder. If an architecture doc is wanted, write a public `docs/en/architecture.md` (+ zh-CN) | pm |
| M-11 | git history | All 4 commits carry `Co-Authored-By: Claude …`. The skill §[1] requires a clean first commit with a personal GitHub email and no AI attribution | At publish time, create a fresh single-commit repo (`git archive` → new repo). Ops/human runs it | pm |
| M-12 | `container/tools/{dingtalk,wecom}/catalog.json` | CJK: 6,627 lines (dingtalk) and 2,660 (wecom) of vendor CLI help text, which falls outside the D15 CJK-allowed paths. **Assessment: acceptable.** It is generated third-party data that the LLM needs (the vendor CLIs only ship Chinese help), and translating it would drift from the CLI. It must be declared, though | Note in README + THIRD-PARTY-LICENSES that `container/tools/*/catalog.json` is generated by `npm run gen:catalog` from the vendor CLIs' help output, in the vendors' language, under their licenses (dws Apache-2.0 → NOTICE attribution required). Add this to the PCSR leak/CJK-scan disposition | pm, dev-c |

### Low

| # | File:line | Issue | Recommended fix | Owner |
|---|---|---|---|---|
| L-1 | `lambda/shared/store.ts:150-156` | On rotation, `putRefresh` extends `rfam#<family>` with `UpdateItem`, which **upserts**. If a replay deletes the family between `consumeRefresh`'s family check (`:184-186`) and this update, the revoked family is recreated | Add `ConditionExpression: 'attribute_exists(pk)'`. On a conditional failure, return `invalid_grant` | dev-b |
| L-2 | `lambda/oauth/qr.ts:87-92` | The authorized branch is not single-use: `getFlow` … `deleteFlow`. Two concurrent polls can each issue a code. Both go to the same client, so the impact is low | Use `consumeFlow` (DeleteItem ALL_OLD) on the authorized branch. If nothing is returned, report `expired` | dev-b |
| L-3 | `container/src/secrets.ts:39-46` | `getUserSecret` only maps `ResourceNotFoundException` to null. A secret pending deletion (after a WeCom slot replacement or a refresh revoke) throws `InvalidRequestException`, so callers get `cli_failed` "Internal error" instead of `im_not_authorized`. Write-back to such a secret logs `CRITICAL` | Treat `InvalidRequestException` containing "deletion" as null, matching `lambda/shared/user-secrets.ts:33-37` | dev-c |
| L-4 | `container/src/wecom/credentials.ts:102`, `container/src/wecom/auth-flow.ts:169,174,179` | The container logs the raw `userId`. The Lambdas log `hashUserId()` (`lambda/shared/log.ts:13`). It isn't a secret, but the two sides are inconsistent | Log a hash in the container as well | dev-c |
| L-5 | `container/build/install-cli.sh` + `.cache/cli/*` | `gen:catalog` uses the **host-platform** CLI while the image uses linux-arm64. Help output is normally identical, but this isn't verified | In the Ops build check, diff `<bin> --version` and one `--help` inside the image against the catalog | dev-c |
| L-6 | `scripts/users.ts:49-68` | `revoke` is permanent and there is no `unrevoke`. For redirect IMs it doesn't delete `ident#`/refresh families (the `disabled` flag covers them) | Document this. Optionally add `users -- enable <id>` | dev-a |
| L-7 | `infra/lib/constructs/storage.ts:25-31` | The CMK is `RETAIN`, so every deploy/destroy cycle (e.g. the E2E runs) leaves a KMS key costing $1/month | Add it to the Ops teardown checklist (`schedule-key-deletion`) | dev-a / ops |
| L-8 | `lambda/shared/redirects.ts:37-45`, `infra/lib/config.ts:251` | The Quick allowlist accepts **any path** on `quicksight.aws.amazon.com` / `*.quicksight.aws.amazon.com`. This is per design. Codes can't reach a third party unless Quick has an open redirect | Optionally restrict it to the Quick OAuth callback path | dev-b |
| L-9 | `container/tools/dingtalk/catalog.json:21162` | The leak-scan regex hits a 12-digit vendor example ID (`948964045503`, an attendance record ID in dws help text). There is also a sample phone-like number `17888832000` from vendor help | Record a PCSR disposition: vendor example, not an AWS account | pm |
| L-10 | `container/src/server.ts:108` | A missing `User-Id` header falls back to `'anonymous'`. That's unreachable behind the middleware, but it would silently share one slot | Return a JSON-RPC error when the header is absent and the method is `tools/call` or a control method | dev-c |

## 2. Security review: what was checked and is correct

These hold at HEAD, so they don't need re-review:

- **Tokens:** HMAC-SHA256 with domain-separated keys (`tokens.ts:23-26`). Verification uses `timingSafeEqual` on equal-length buffers. A strict charset/length/regex runs before decoding. Malformed input never throws. Access tokens and incremental tokens use different keys (cross-use is impossible). `userId` is 128-bit random. Session id = HMAC(`K_session`, userId).
- **PKCE:** mandatory, S256 only, challenge 43–128 chars, verifier regex. Codes are stored hashed, consumed by DeleteItem before any check (so they're burned on failure), and bound to client_id + redirect_uri + challenge. TTL is 120 s.
- **redirect_uri:**
  - The allowlist is enforced at DCR **and** again at `/authorize` (removing a host invalidates old clients).
  - userinfo, fragments, and custom schemes are rejected.
  - Non-loopback hosts must use https.
  - `*.x.y` matches strict subdomains only.
  - Errors before the redirect_uri is validated are HTML, never a redirect.
  - There is **no open redirect**: every `Location` is either a verified client URI or the IM authorize URL. The QR page's `location.replace` takes a same-origin JSON value.
- **CSRF/state:** the AS `state` is server-generated (128-bit), stored, and consumed once. The client `state` is passed through. Login-CSRF via a forwarded IM link only delivers a code to the victim's own loopback.
- **Incremental scope:** `identity_mismatch` is checked **before** any credential write (`callback.ts:52-55`), so someone else's IM account can't be attached to a user. `t` + `redirect_uri` is rejected.
- **Refresh:**
  - Rotation is atomic: a conditional `usedAt` set.
  - Replay deletes the family.
  - `disabled` is checked at both grants.
  - Client binding is checked.
  - The only gap is the L-1 race.
- **DCR:** stateless signed client_id (no storage growth), body ≤ 8 KB, 1–5 URIs, `client_name` is never rendered. There is a route throttle of 5/10.
- **Middleware:**
  - Client headers are never forwarded; only the raw body is.
  - `Mcp-Session-Id` is derived server-side, and the client value is ignored.
  - `im/*` methods are blocked, and the container additionally requires `Caller: control`.
  - Batches, notifications, and size limits are handled.
  - 401 is returned with `resource_metadata`.
  - Per-user microVMs give process/filesystem isolation between users.
- **Container:**
  - `execFile`, no shell.
  - Flag names come only from the catalog. Values go in a separate argv slot, and pflag consumes the next arg as the value, so values can't inject flags.
  - No catalog flag collides with the dws root `--token`/`--profile`.
  - WeCom args go as a single `--json` arg.
  - CLI env is `PATH/HOME/LANG/NO_COLOR` plus adapter vars only (no `AWS_*`).
  - Per-call `mkdtemp` dirs are removed in `finally`.
  - WeCom config lives under `$HOME/.wc` (0700/0600, outside the CLI sandbox).
  - `userId` is never used in a filesystem path, so there is no traversal.
  - `extra_identity_context` is stripped (anti prompt-injection).
- **IAM:**
  - `Resource:"*"` appears only for `ecr:GetAuthorizationToken` and `secretsmanager:ListSecrets` (checked in the synthesized template).
  - The Runtime trust has `aws:SourceAccount` + `aws:SourceArn`.
  - There is no `bedrock:InvokeModel`.
  - Every Lambda has its own role scoped to its own log group, the base-url param ARN, and `<slug>/users/*`.
- **Partition:** derived only from `RegionInfo` (`partition.ts`). China rejects CloudFront/WAF in config and again in the construct. The Quick hosts are empty on aws-cn. Ops confirmed a real cn-northwest-1 deploy (03-ops-plan §10).
- **HTML:** every dynamic value is escaped. There is a per-response nonce CSP, and `JSON.stringify(...).replace(/</g,'\\u003c')` is used inside the script.
- **Logs:** the Lambdas log `hashUserId` only. No token, code, or secret appears in any Lambda log line. Upstream errors log `code=`/`http_` only.

## 3. aws-samples readiness (skill §[1])

| Item | Status |
|---|---|
| LICENSE MIT-0 / NOTICE / CODE_OF_CONDUCT / CONTRIBUTING / THIRD-PARTY-LICENSES | **Missing** (C-1) |
| README.md (EN) + README.zh-CN.md | **Missing** (C-1) |
| Explicit non-production disclaimer | **Missing** (C-1) |
| `.gitignore` excludes dist, cdk.out, local configs, caches | OK |
| Leak scan (12-digit, `@amazon.com`, internal hosts, customer names, credentials) | OK. Two dispositions are needed: the vendor example IDs (L-9) and the required `Keith Yu` MIT attribution |
| CJK outside allowed paths | Only `container/tools/{lark,dingtalk,wecom}/catalog.json` (generated vendor help). Acceptable with a declaration (M-12). `container/src/wecom/identity.ts` correctly uses `\u` escapes |
| Pinned deps + lockfile | Root `package.json` is all exact, and `package-lock.json` v3 is committed (21 entries without `resolved` are `inBundle` deps of aws-cdk-lib, which is normal). Base image is digest-pinned. **Vendor CLI install is not integrity-pinned** (M-7) |
| Vendored upstream code keeps its license/header | OK in the file headers. The THIRD-PARTY-LICENSES file is still missing (C-1) |
| Internal docs out of the public tree | No: `docs/spec/` (M-10) |
| Clean first commit, no AI attribution | No (M-11) |
| Docs-vs-code pass | Done. See §4 |

## 4. Docs-vs-code mismatches (`docs/en` ≡ `docs/zh-CN`; the two languages agree with each other)

All are owned by **pm**. Line numbers are the same in en and zh-CN.

| # | Doc:line | Doc says | Code says | Fix |
|---|---|---|---|---|
| D-1 | `prerequisites.md:42-43`, `im-setup-feishu.md:22-25`, `im-setup-lark.md:19`, `im-setup-dingtalk.md:30-33` | Set the secret before deploying | The secret only exists after the deploy (H-3) | Reorder |
| D-2 | `im-setup-feishu.md:24,77`, `im-setup-lark.md:19,64`, `prerequisites.md:26-28`, `im-setup-dingtalk.md:32,59` | `{appId, appSecret}`; DingTalk `{clientId, clientSecret}` | Every IM stores `{appId, appSecret, configured:true}`. For DingTalk, `appId` = Client ID (`scripts/secret-set-im-app.ts:92`) | Correct the shape |
| D-3 | `im-setup-feishu.md:87`, `im-setup-dingtalk.md:72` | "Deploy reports invalid app credentials" | Validation happens in `secret:set-im-app` (`… rejected the credentials`, skippable with `--no-validate`). At runtime the failure surfaces as `im_app_not_configured` | Fix the symptom text |
| D-4 | `prerequisites.md:32`, `im-setup-feishu.md:61` | `<base>` = custom domain or API Gateway URL | Also the CloudFront domain when `edge: cloudfront` (`ingress.ts:121`). The outputs are named `BaseUrl`, `McpUrl`, `CallbackUrl`, `ImConsoleCallbackHint`, `CustomDomainTarget` | Add these |
| D-5 | `prerequisites.md:15` | Node 22 LTS or later | `engines.node >=20.19` | "≥ 20.19 (22 recommended)" |
| D-6 | `prerequisites.md:14` | Slug "short, lowercase" | 3–20 chars, `^[a-z][a-z0-9-]{1,18}[a-z0-9]$` (`config.ts:21`) | State the rule |
| D-7 | `prerequisites.md:20` | The mirror pulls from Docker Hub, needs credentials for both partitions, and the script isn't named | `scripts/mirror-base-image.sh <cn-region>` pulls from `public.ecr.aws` (no login) and only needs China credentials. Run it once per China region. Pin the printed digest in `shared/versions.ts` or `build.baseImage` | Rewrite the row |
| D-8 | `prerequisites.md:21` | `build.mirror: cn` for Global | Also requires a digest-pinned `build.baseImage` (`config.ts:130-134`) | Add this |
| D-9 | `prerequisites.md:24` | DNS target unnamed | Output `CustomDomainTarget` | Name it |
| D-10 | `prerequisites.md:36` | `feishu: { appId: cli_xxx }` | Fails the regex `^cli_[A-Za-z0-9]{8,32}$` | Use `cli_xxxxxxxxxxxxxxxx` |
| D-11 | `im-setup-feishu.md:37-45`, `im-setup-lark.md:31-39` | Minimum scope table | `contact:user.base:readonly`, `calendar:calendar:read`, `space:document:retrieve` don't exist in the catalog (the code uses `contact:user.basic_profile:readonly`). `im:message:readonly` and `base:record:update` aren't in `config/scopes/feishu.json`. Tier-1 scopes (`im:message`, `docx:*`, `sheets:*`, `mail:*`, `task:*`, `wiki:node:retrieve`, …) are missing | Point to `config/scopes/feishu.json` (generated) instead of a hand-written table |
| D-12 | `im-setup-feishu.md:47` | "Path TBD, see spec OQ-4" | `config/scopes/feishu.json` (`{scopes:{tenant:[],user:[…]}}`, tier-1 + `offline_access`, made by `npm run gen:catalog`) | Give the path, drop the spec link |
| D-13 | `im-setup-feishu.md:49`, `im-setup-lark.md:41` | First authorization asks for few scopes | The default when `scopes` is unset is all 31 entries of `config/scopes/feishu.json` (`config.ts:256-261`) | State the real default |
| D-14 | `im-setup-dingtalk.md:42,70` | `permission_required` error | The tool result code is `missing_scope` with `required_scopes` + `authorize_url` (`container/src/adapters/dingtalk.ts:64-71`) | Rename |
| D-15 | `im-setup-dingtalk.md:67-68` | Admin errors listed by dws name | They surface as `im_admin_action_required` (`dingtalk.ts:10,73`) | Mention the code |
| D-16 | `im-setup-wecom.md:33` | The quoted tool result text | Code `im_grant_expired`; actual wording in `container/src/errors.ts:34-35` | Quote the code, paraphrase the message |
| D-17 | `02-technical-design.md:158`, `03-ops-plan.md:160` | `config/cn.local.yaml`, `scripts/set-im-secret.sh` | They don't exist. The real script is `npm run secret:set-im-app -- [-c config=<path>] [--no-validate]` | Fix (moot if M-10 moves the specs) |
| D-18 | `prerequisites.md:3` | Region links only | The allowlist is `infra/lib/regions.ts` (23 regions), and validation errors list them | Reference the file |

The rest of the WeCom guide matches the code: the 300 s QR timeout, the 850005 backoff, 853006/851003, per-user CMK secrets, and the grant-expired alarm.

## 5. Recommended order

1. **dev-c:** H-2 (denylist), M-1 (token-in-error), M-5, M-6, M-7, L-3, L-4, L-10. Then regenerate the catalogs.
2. **dev-b:** M-2, M-4, L-1, L-2. **dev-a:** H-1 route throttle, after CTO sign-off on the config key and on M-3/M-4.
3. **pm:** C-1, H-3 + D-1…D-18, M-9 (`security.md`, `testing.md`, operations), M-12 declaration, M-10/M-11 at the final commit.
4. Re-run `vitest`, `DWS_REAL=1` isolation, `synth:matrix`, the leak scan on `git archive`, then freeze the final SHA for PCSR.

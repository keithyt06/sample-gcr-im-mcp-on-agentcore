# 01 — Product Spec: sample-gcr-im-mcp-on-agentcore

Status: draft v1 (2026-11-04) · Owner: PM · Inputs: team brief (D1–D16), feasibility research v2

## 1. Problem and one-line goal

Teams in Greater China use Feishu, Lark, DingTalk, or WeCom. They want AI clients (Kiro, Claude Code, Codex, Cursor, Amazon Quick) to act in that IM **as the individual user**, not as a shared bot, and they want it hosted in their own AWS account, either in AWS Global or in AWS China.

**Goal:** one codebase, one typed config file (`config/deploy.yaml`), and one CDK app that deploy a remote MCP server for **exactly one** of {feishu, lark, dingtalk, wecom}. It runs on Amazon Bedrock AgentCore Runtime in an AWS Global region or an AWS China region (`cn-north-1` / `cn-northwest-1`). The repo is published as an aws-samples sample: non-production, MIT-0.

## 2. Personas

| Persona | Who | Wants | Touches |
|---|---|---|---|
| **Deployer / operator** | IT or platform engineer with AWS admin rights in one account, often also an IM org admin (or works with one) | Deploy in under 60 minutes, with one config file and no partition-specific edits. Operate it: rotate secrets, revoke users, get alarms, upgrade | AWS account, CDK, `config/deploy.yaml`, `npm run secret:set-im-app`, IM developer console |
| **IM org admin** (may be the same person) | Feishu/Lark/DingTalk/WeCom tenant admin | Approve the app and its scopes, limit who can use it, keep audit at user level | IM admin console |
| **End user** | Employee using an MCP client | Paste one URL, authorize once in the IM, then use IM tools under their own identity. Never sees a secret | MCP client, browser, IM app (QR scan for WeCom) |

## 3. User stories

Deployer
- **US-D1** As a deployer, I fill `region`, `im`, `slug`, and the IM app ID in `config/deploy.yaml`, run one deploy command, and get the MCP endpoint `<base>/mcp` and the callback URL `<base>/callback`.
- **US-D2** As a deployer, I switch from AWS Global to AWS China by changing only `region`. Partition, ARNs, DNS suffixes, ingress shape, and build mirrors are derived from it.
- **US-D3** As a deployer, I store the IM app secret with `npm run secret:set-im-app`. It never appears in the config file, the CDK context, the shell history, or the CloudFormation template.
- **US-D4** As a deployer in China, I attach an ICP-filed custom domain (`ingress.customDomain` + `ingress.certificateArn`) so the service is publicly reachable.
- **US-D5** As a deployer, I get a webhook alarm when user credentials can't be refreshed or stored, and when WeCom capability authorization expires (850003).
- **US-D6** As an operator, I can list authorized users, revoke one user, and rotate the token-signing root key (which invalidates all sessions), using documented commands.
- **US-D7** As a deployer, I can destroy the stack. Resources kept on purpose (KMS CMK, user secrets) are listed in the docs.

End user
- **US-U1** As an end user, I add `<base>/mcp` to my MCP client. The client discovers OAuth (RFC 9728/8414), registers itself (RFC 7591 DCR), opens the browser, I approve in the IM (or scan a QR for WeCom), and tools load. I don't type any client ID or secret.
- **US-U2** As an end user, every call runs as **me**: messages show my name, and reads return only what I can see.
- **US-U3** As an end user, my session keeps working without re-authorizing in normal use (refresh tokens; server-side IM token refresh every 30 min for redirect-mode IMs).
- **US-U4** As an end user, when a call fails because of a missing scope, an expired WeCom capability grant, or an org policy, the tool result tells me what to do in plain text (re-authorize link, "renew in WeCom", "ask admin to enable CLI access").

## 4. Scope and non-goals

In scope (P1–P4)
- One IM per deployment. A second IM means a second deployment with a different `slug`.
- Per-user delegated identity only (user token / per-user bot binding). Each user's credentials are isolated (Secrets Manager + dedicated KMS CMK).
- Curated tier-1 tools per IM, plus the meta tools `<im>_discover` / `<im>_invoke` (D13).
- Ingress: API Gateway HTTP API with route throttling in both partitions. Optional custom domain. Optional CloudFront + WAF (Global only).
- English and Simplified Chinese docs.

Non-goals
- Bot / app-identity features: broadcast, event subscription, auto-reply, scheduled unattended jobs.
- Multi-IM in one deployment; multi-tenant SaaS hosting for external orgs.
- WAF or CloudFront in AWS China (accepted; API Gateway throttling only).
- Automatic ICP check or ICP filing. ICP is documented only.
- Workarounds for platform policy: WeCom 7-day capability renewal, WeCom chat history limit, DingTalk CLI-access gate.
- Local-file tools in remote MCP (e.g. WeCom `media.upload`): they are marked unavailable.
- AWS GovCloud (`aws-us-gov`), DingTalk international (`dingtalk.io`). See open questions.
- Production SLA. This is a sample with an explicit non-production disclaimer.

## 5. Supported matrix

### 5.1 IM × partition

| IM | AWS Global (`aws`) | AWS China (`aws-cn`) | Tenant / console | User auth mode |
|---|---|---|---|---|
| feishu | Supported | Supported (primary fit) | open.feishu.cn | redirect (OAuth) |
| lark | Supported (primary fit) | Supported (synth + infra E2E; cross-border latency not optimized) | open.larksuite.com | redirect (OAuth) |
| dingtalk | Supported | Supported (primary fit) | open-dev.dingtalk.com | redirect (OAuth) + org CLI access |
| wecom | Supported | Supported (primary fit) | WeCom client (smart bot) | in-container QR scan |

All 8 combinations must pass `cdk synth` with assertions (G1).

### 5.2 Regions

The rule: `region` must be a region where **AgentCore Runtime** is available. Partition is derived from it (D2). The source of truth is the official page, re-checked at each release: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html (Global) and https://docs.amazonaws.cn/en_us/aws/latest/userguide/bedrock-agentcore.html (China).

| Partition | Regions with AgentCore Runtime (as listed 2026-11-04) | Tested by the team |
|---|---|---|
| aws | us-east-1, us-east-2, us-west-1, us-west-2, ca-central-1, sa-east-1, eu-central-1, eu-west-1, eu-west-2, eu-west-3, eu-south-1, eu-south-2, eu-north-1, ap-northeast-1, ap-northeast-2, ap-south-1, ap-south-2, ap-southeast-1, ap-southeast-2, ap-southeast-5, ap-southeast-7 | ap-northeast-1 or us-west-2 |
| aws-cn | cn-north-1 (Beijing), cn-northwest-1 (Ningxia) | both, or at least one |

- Regions not in the code's allowlist fail config validation with a clear message. The list lives in code, not in config.
- `ingress.edge: cloudfront` with `ingress.waf: true` creates a stack in us-east-1, so that region needs a CDK bootstrap.

### 5.3 MCP clients per partition

| Client | Global | China | How it connects |
|---|---|---|---|
| Amazon Quick (web + Desktop) | Yes | **No** (not offered in AWS China) | OAuth with DCR; the Quick callback host (`<region>.quicksight.aws.amazon.com`) must be in the AS redirect allowlist |
| Kiro (IDE/CLI) | Yes | Yes | OAuth DCR, loopback redirect |
| Claude Code | Yes | Yes | OAuth DCR, loopback redirect |
| Codex (CLI/Desktop) | Yes | Yes | OAuth DCR, loopback redirect |
| Cursor | Yes | Yes | OAuth DCR. Its redirect may use a custom URI scheme; the AS must accept it (see OQ-3) |

Clients must reach `<base>` over the public internet. China endpoints need ICP (§7).

## 6. Capability boundaries per IM (must appear in user-facing docs)

| IM | Boundary | Handling |
|---|---|---|
| all | Acts only as the authorizing user; no bot broadcast or events | Non-goal |
| feishu / lark | Feishu and Lark are separate platforms; an app works on one only | Separate `im` values and console links |
| feishu / lark | A scope must be enabled in the console **and** a new app version published before any user can grant it. Already-connected users must re-authorize for scopes they never granted | Incremental-authorize link in the error result |
| feishu / lark | Only members inside the app's **Availability** scope can authorize | Admin limits Availability |
| dingtalk | The org admin must enable **CLI access** (open-dev.dingtalk.com → CLI access management). Otherwise calls fail with `cli_not_enabled` / `user_forbidden` | Structured error saying "ask your DingTalk admin to enable CLI access" |
| dingtalk | Org-level APIs need the app permission granted by the admin; personal accounts get permission errors | Error result includes the permission hint |
| wecom | **Each capability grant (docs, messages, mail, …) expires after 7 days. The user must renew it manually in the WeCom client. There is no API to refresh it. ACCEPTED.** | 850003 → structured "renew authorization in the WeCom smart-bot management page" plus a webhook alarm. Never auto-run `auth init` |
| wecom | Reading chat/message history fails in orgs with **more than 10 members** (853006, platform policy) | Tool marked "may be unavailable"; error explained |
| wecom | Authorization binds a smart bot. On re-authorization, the user must choose **bind existing bot**. Creating a new bot loses write access to objects the old bot created | Called out on the QR page and in docs |
| wecom | The bot does not inherit the user's existing document permissions (851003 = object permission insufficient) | Pattern: the bot creates the doc, then adds the user as manager |
| wecom | 50 calls / minute / bot (850005) | Backoff + cache |
| wecom | File-path tools are unusable remotely (1.3.x sandbox) | Tool description says unavailable, suggests inline alternatives |
| wecom | Whether WeCom trusted-IP rules affect the bot channel is unknown | Record the egress IP during E2E (R8) |

## 7. AWS China prerequisites (docs only; no code checks)

1. **ICP filing.** Public access to API Gateway in AWS China needs ICP filing, and so does any custom domain. Prepare an ICP-filed domain and set `ingress.customDomain` + `ingress.certificateArn` (ACM certificate in the same region).
2. China accounts and credentials are separate from Global. Always set `AWS_REGION` (or `region` in config plus a profile); otherwise STS calls go to the global endpoint and fail.
3. Amazon Quick is not available. Use Kiro, Claude Code, Codex, or Cursor.
4. No WAF or CloudFront. API Gateway throttling only (default 50 rps / burst 100; `/register` 5 / 10).
5. Image build: `build.mirror=auto` switches to the npm mirror and a China-ECR base image. The base image must be mirrored into China ECR once with the provided mirror script. Building a Global stack from inside mainland China needs `build.mirror: cn`.

## 8. Acceptance criteria

### 8.1 Release gates G1–G5 (made testable)

| # | Criterion | Test (pass condition) |
|---|---|---|
| **G1** Synth matrix | All 4 IM × 2 partitions synthesize | CI job runs `cdk synth` for 8 fixture configs (region `ap-northeast-1` and `cn-northwest-1`). Pass = exit 0 for all 8, and assertions hold: (a) no `arn:aws:` literal and no `amazonaws.com"` endpoint literal in aws-cn templates (only `${AWS::Partition}` / `${AWS::URLSuffix}`); (b) no `AWS::CloudFront::*` and no `AWS::WAFv2::*` in aws-cn; (c) Runtime role trust principal = `bedrock-agentcore.amazonaws.com` in both; (d) Runtime `requestHeaderAllowlist` contains only `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*` entries; (e) Runtime execution role has no `bedrock:InvokeModel`; (f) no IAM `Resource: "*"` except documented exceptions; (g) no Runtime env var references the API URL (D7) |
| **G2a** Infra E2E (team-owned) | Each IM deployed to ≥1 Global region and ≥1 China region | Script against `<base>`. Pass = `GET /.well-known/oauth-authorization-server` → 200; `GET /.well-known/oauth-protected-resource` → 200; `POST /mcp` without token → 401 with `WWW-Authenticate: Bearer resource_metadata="…"`; `POST /register` → 201 with a `client_id`; a test MCP token minted by an ops script → `tools/list` returns the tier-1 + meta tools for that IM; route throttling returns 429 above the limit. Runs for 4 IM × 2 partitions = 8 deployments (sequential is fine) |
| **G2b** IM E2E (needs a real tenant) | Real user flow per IM | With a real IM test tenant: authorize from one DCR client, then `tools/list` + 1 read (e.g. self profile / calendar list) + 1 write (e.g. create a todo or send a message to self). Pass = all three succeed as the authorizing user. DingTalk adds the two-user isolation check: two users alternate and each call carries its own token. **Owner and tenant TBD (OQ-1)** |
| **G3** One config file | Only `config/deploy.yaml` changes between deployments | Schema (zod) has no partition, ARN, or endpoint field. Test: the same config with only `region` changed synthesizes for both partitions. Config containing a secret-looking key (`*Secret`, `*Token`, `*Password`) fails validation |
| **G4** China build | Image builds in China with no manual steps beyond the one-time base-image mirror | On an ARM64 build host inside mainland China, with `build.mirror=auto` and region `cn-*`: deploy builds and pushes the image. Pass = no GitHub, Docker Hub, or registry.npmjs.org fetch in the build log; each of the 3 CLIs installs at its pinned version |
| **G5** Publishable | Passes the aws-samples publish flow | Leak scan: 0 hits for 12-digit account IDs, keys, customer names; no CJK characters outside `*.zh-CN.*`, `docs/zh-CN/`, i18n json. cdk-nag / cfn-lint / Probe: no Critical, every suppression has a reason. STRIDE doc present. Required files present: LICENSE (MIT-0), NOTICE, CODE_OF_CONDUCT, CONTRIBUTING, THIRD-PARTY-LICENSES (with the DingTalk MIT notice), English README + README.zh-CN.md with non-production disclaimer. All deps pinned with a committed lock file; base image pinned by digest |

### 8.2 Product acceptance (per story)

- **US-D1 / US-D2:** A fresh clone plus the documented prerequisites produces a working deployment with ≤ 3 commands (install, set secret, deploy). Deploy output prints `<base>/mcp`, `<base>/callback`, and the console link for registering the callback.
- **US-D3:** `grep` of the synthesized template, `cdk.context.json`, and `config/` for the app secret value returns nothing. The helper prompts with no echo and does not take the secret as a CLI argument.
- **US-D4:** With `ingress.customDomain` set, `<base>` = `https://<customDomain>`, and DCR and well-known work at the domain root.
- **US-D5:** A forced 850003 from a fake CLI produces (a) a tool result containing the renewal instruction, and (b) one webhook POST to the URL read from `alarm.webhookUrlSsmParam`.
- **US-U1:** Kiro and Claude Code connect with only the URL (no manual client ID). Verified in G2a with DCR plus a scripted PKCE flow.
- **US-U4:** Every boundary in §6 that has an error code maps to a structured message. Unit test per mapping.

## 9. Roadmap

| Phase | Content | Exit criteria |
|---|---|---|
| **P0 Verify** (≈1 wk) | Open items from research v2 §9: China full-stack deploy + `agentcore invoke` smoke; in-China ARM build with `build.mirror=cn`; dws `--token` two-user regression; wecom-cli 1.3.4 egress IP and 850003 behaviour; how a non-ICP `execute-api.*.amazonaws.com.cn` endpoint behaves | Each item has a written result. Any blocker raises a decision to PM |
| **P1 Core + Feishu/Lark** (2–3 wk) | Config schema, partition derivation, HTTP API ingress, OAuth AS, middleware, Runtime via `CfnRuntime`, `build.mirror`, secret helper, feishu/lark adapter. Publishing skeleton files. Docs in this folder | G1 for feishu + lark (4 combos); G2a for feishu in 1 Global + 1 China; G3 |
| **P2 DingTalk** (1–2 wk) | dws 1.0.67 via npm, per-call `--token`, isolation regression test, CLI-access error mapping | G1 for dingtalk; G2a dingtalk ×2 partitions; isolation test green in CI |
| **P3 WeCom** (2 wk) | wecom-cli 1.3.4, in-container QR auth driven by Lambda, per-call temp workdir, 850003/853006/851003/850005 mapping + alarm | G1 for wecom; G2a wecom ×2 partitions; error-mapping unit tests |
| **P4 Release** | 8-combo CI, E2E script, optional CloudFront+WAF path, leak scan, STRIDE, aws-samples flow | G1–G5 all green (G2b as far as tenants allow; gaps listed in README) |

## 10. Open product questions

- **OQ-1** G2b needs real IM tenants (4 platforms). Who provides test tenants, or do we ship with G2a only and label G2b "community-verified"? Recommendation: ship on G2a and document G2b as a manual checklist.
- **OQ-2** Amazon Quick: DCR only (allowlist the Quick callback host per Quick region), or also keep a pre-registered `quick` client as the DingTalk sample does? Recommendation: DCR only. Allowlist hosts through a config key such as `oauth.extraRedirectHosts`, to be added to the contract by the CTO.
- **OQ-3** Cursor may register a custom-scheme redirect URI. The Feishu sample rejects non-https / non-loopback schemes. Should we allowlist Cursor's exact scheme, or document Cursor as "loopback mode only"?
- **OQ-4** Feishu/Lark scope sets: `im.<brand>.scopes` sets the scopes requested at first authorization. The full bulk-import list (≈237 entries in the Feishu sample) should ship as a file in the repo for console import. Its path needs to be agreed with the CTO.
- **OQ-5** DingTalk international (`dingtalk.io`, `dws --intl`): out of scope for v1. Confirm.
- **OQ-6** `ingress.waf: true` in China (REST API + custom domain, research v2 §4.3): keep it out of the contract (current), or reserve the key and fail validation?
- **OQ-7** Alarm webhook: should it support only Feishu/DingTalk/WeCom bot webhooks, or also SNS email? The current contract has only `alarm.webhookUrlSsmParam`.

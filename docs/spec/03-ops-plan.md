# 03 — Ops / SRE plan

Status: draft (2026-11-04). Owner: Ops/SRE lead. Scope: environment readiness, deploy/destroy
runbooks, China base-image mirroring, observability, cost, teardown, go/no-go for real deploy tests.

All findings below came from read-only checks (list/describe calls, unsigned curl, `docker login`).
No AWS resources were created or modified. Account IDs are masked as `<ACCT_GLOBAL>` / `<ACCT_CN>`.

## 1. Environments

| | Global A | Global B | China A | China B |
|-|-|-|-|-|
| CLI profile | `default` | `default` | `gcr` | `gcr` |
| Account | `<ACCT_GLOBAL>` | `<ACCT_GLOBAL>` | `<ACCT_CN>` | `<ACCT_CN>` |
| Region | ap-northeast-1 | us-west-2 | cn-north-1 | cn-northwest-1 |
| Partition / suffix | aws / amazonaws.com | aws / amazonaws.com | aws-cn / amazonaws.com.cn | aws-cn / amazonaws.com.cn |
| `bedrock-agentcore-control list-agent-runtimes` | OK | OK | OK | OK |
| `AWS::BedrockAgentCore::Runtime` CFN type | PUBLIC, FULLY_MUTABLE | same | PUBLIC, FULLY_MUTABLE | same |
| CFN schema: ProtocolConfiguration `MCP`, RequestHeaderAllowlist | present | present | present | present |
| Existing AgentCore runtimes | 1 (unrelated name) | 1 (unrelated name) | 0 | 0 |
| Existing `ImMcp-*` stacks | none | none | none | none |
| CDK bootstrap (`CDKToolkit`) | yes, UPDATE_COMPLETE, BootstrapVersion **30** | yes, v**30** | **NO** | yes, v**32** (bootstrapped 2026-11-04, CDK CLI 2.1147.0) |
| AgentCore quotas (visible) | session creation 25/s, data plane 1000/s, control mutations 50/s, image max 2048 MB | same | same | same |
| Lambda account concurrency | 1000 | 1000 | 1000 | 1000 |
| ECR pull-through cache / replication | n/a | n/a | none | none |
| API GW custom domains / ACM certs | n/a | n/a | 0 / 0 | 0 / 0 |

Recommended test regions: **Global = ap-northeast-1** (us-west-2 as fallback), **China =
cn-northwest-1** (Ningxia; the Lark reference sample was verified there on 2026-10-30), with
cn-north-1 as the second China check. Runtime names must stay unique per account+region; our
prefix (`im_mcp_<slug>`) does not collide with anything that exists today.

### China service API smoke (profile `gcr`, both regions)

All of these returned successfully (no AccessDenied, no "unknown endpoint"): ECR
`describe-repositories`, Secrets Manager `list-secrets`, KMS `list-keys`, DynamoDB `list-tables`,
API Gateway v2 `get-apis` / `get-domain-names`, EventBridge Scheduler `list-schedules`, EventBridge
`list-rules`, Lambda `list-functions`, SSM `describe-parameters`, CloudWatch Logs, CloudWatch
alarms, ACM, AgentCore `list-workload-identities`.

Not verifiable read-only:
- **Lambda `nodejs22.x` + `arm64` in aws-cn.** No existing function in the China account uses
  either (only nodejs18.x / python3.9 on x86_64), and there is no list-runtimes API. Both are
  expected to be supported; the Lark sample shipped with NODEJS_20_X. Verify on the first China
  deploy; fallback is `nodejs20.x` (one-line change in a shared construct default).
- **ICP filing.** Not visible via any API. Unfiled accounts get API Gateway public access blocked
  in China. Treat infra-level E2E against the default `execute-api` URL as "best effort" and record
  the HTTP status we actually get. A real user-facing deployment needs an ICP-filed custom domain.

### Build host / network

| Check | Result |
|-|-|
| Host | x86_64, Ubuntu 24.04, Docker 29.1.3, buildx 0.30.1, BuildKit 0.26.2 |
| arm64 emulation | qemu-aarch64 binfmt registered; buildx default builder lists linux/arm64 |
| `docker run --platform linux/arm64 node:22-bookworm-slim` | OK, prints `arm64 v22.23.4` |
| AWS CLI | 2.34.48 (has `bedrock-agentcore-control` and `bedrock-agentcore`) |
| Node / npm on host | v20.20.2 / 10.8.2 (CDK CLI not installed globally; use repo-local `npx cdk`) |
| registry.npmmirror.com | 200 (~0.2 s) |
| registry.npmjs.org | 200 (~0.03 s) |
| bedrock-agentcore.cn-north-1 / cn-northwest-1 (unsigned) | 404 (reachable) |
| bedrock-agentcore-control.cn-north-1 (unsigned) | 403 (reachable) |
| China ECR `docker login` (cn-north-1, cn-northwest-1) | Login Succeeded |
| skopeo | not installed; `apt install skopeo` candidate 1.13.3 available |
| crane | not installed; Go 1.22.2 present (`go install github.com/google/go-containerregistry/cmd/crane@latest`), or apt `golang-github-google-go-containerregistry-dev` |

Decision: mirror with plain `docker pull/tag/push` (no extra tooling). skopeo/crane are optional
and only matter if we want to copy the full multi-arch index byte-for-byte.

### Base image pin (recorded 2026-11-04)

`public.ecr.aws/docker/library/node:22-bookworm-slim` (Node v22.23.4)

| Ref | Digest |
|-|-|
| Multi-arch index | `sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da` |
| linux/arm64 manifest | `sha256:9a422d62743ffb1e6eb282549f4eae7ab89f7b926db1f136f4cba8be60e4ecbc` |
| linux/amd64 manifest | `sha256:9f0dde62d10e7ff7a310ecaebd66225f6b46c17e6cb778449a77b05d3541bea2` |

Global default `BASE_IMAGE` = `public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:4b15…79da`
(index digest; BuildKit selects arm64). For China, a `docker push` of a single-platform pull
produces a **new** digest (the arm64 manifest only, re-pushed). Record the digest that `docker push`
prints and pin China `BASE_IMAGE` to that. Verified 2026-11-04 in cn-northwest-1: the pushed digest
equals the upstream arm64 manifest digest (`sha256:9a422d62…c4ecbc`, 79.9 MB compressed).

## 2. Bootstrap

- Global ap-northeast-1 / us-west-2: already bootstrapped (v30). Nothing to do. Do not re-bootstrap
  with a different qualifier.
- Global us-east-1: needed only if `edge: cloudfront` + WAF stack is enabled. Not checked; check
  before the first WAF test.
- China cn-north-1 / cn-northwest-1: **bootstrap required** (operator action, needs approval):
  ```bash
  AWS_PROFILE=gcr npx cdk bootstrap aws://<ACCT_CN>/cn-northwest-1
  AWS_PROFILE=gcr npx cdk bootstrap aws://<ACCT_CN>/cn-north-1
  ```
  China does not need a us-east-1 bootstrap.

## 3. Mirror base image for China (one-time per region, per base-image bump)

```bash
REGION=cn-northwest-1                     # or cn-north-1
ACCT=$(aws sts get-caller-identity --profile gcr --region $REGION --query Account --output text)
REG=$ACCT.dkr.ecr.$REGION.amazonaws.com.cn
SRC=public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
DST=$REG/gcr-im-mcp/base/node:22-bookworm-slim

aws ecr create-repository --profile gcr --region $REGION \
  --repository-name gcr-im-mcp/base/node \
  --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true
aws ecr get-login-password --profile gcr --region $REGION | docker login -u AWS --password-stdin $REG

docker pull --platform linux/arm64 "$SRC"
docker tag "$SRC" "$DST"
docker push "$DST"                        # note the printed digest -> config build.baseImageCn
```

The pull must run where public.ecr.aws is reachable (this build host is fine).

**Repo policy (required).** `cdk-assets` logs in to the account's ECR registry with the CDK
image-publishing role *before* `docker build`, which replaces the operator's Docker credentials for
that registry host. The `FROM` pull of the mirrored base then runs as that role, so the base repo
must let the role pull:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "CdkImagePublishingPull",
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws-cn:iam::<ACCT_CN>:role/cdk-hnb659fds-image-publishing-role-<ACCT_CN>-<REGION>" },
    "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
  }]
}
```

```bash
aws ecr set-repository-policy --profile gcr --region $REGION \
  --repository-name gcr-im-mcp/base/node --policy-text file://base-repo-policy.json
```

Ship this as `scripts/mirror-base-image.sh` (idempotent: skip create if exists, skip push if the tag
exists) with the policy rendered from the region. The repo lives **outside** the CDK stack on
purpose, so `cdk destroy` does not delete a base image other deployments share.

## 4. Deploy runbook (outline)

Preconditions: section 9 checklist is green for the target.

1. `npm ci` at repo root. `npx cdk --version` matches the pinned CLI.
2. Create `config/<slug>.json` (im, region, prefix, `build.mirror`, optional customDomain / edge).
   No secrets.
3. China only: section 3 done for the region; config `build.mirror=auto` resolves to npmmirror +
   mirrored base digest.
4. `npx cdk synth -c config=config/<slug>.json`. Check: no `arn:aws:` in aws-cn templates, no
   CloudFront in aws-cn.
5. `AWS_PROFILE=<p> AWS_REGION=<r> npx cdk deploy ImMcp-<slug> -c config=...`
   (and `ImMcp-<slug>-Waf` in us-east-1 if enabled, Global only). Always set `AWS_REGION` with
   China creds, because otherwise STS goes to the global endpoint and fails with `InvalidClientTokenId`.
6. Post-deploy: `scripts/set-im-secret.sh` fills the IM app secret placeholder (skipped in our
   tests because we have no real IM app).
7. Infra E2E smoke (base URL from stack output):
   - `GET /.well-known/oauth-authorization-server` → 200
   - `GET /.well-known/oauth-protected-resource` → 200
   - `POST /mcp` without token → 401 + `WWW-Authenticate: Bearer resource_metadata=...`
   - `POST /register` (DCR) → 201 with client_id
   - Mint a test MCP token (test-only helper using the HMAC root key) → `tools/list` returns the
     tier1 + meta tools (exercises middleware → SigV4 → InvokeAgentRuntime → container).
8. Record: stack outputs (masked), runtime status READY, cold start time, image size (< 2048 MB quota).

Failures to watch for: 409 on runtime endpoint creation (avoid custom endpoint, use DEFAULT);
`MalformedPolicyDocument` if the trust principal is written as `.com.cn`; dashboard name collision
when two regions share an account (include region in the name).

## 5. Destroy runbook (outline)

1. `AWS_PROFILE=<p> AWS_REGION=<r> npx cdk destroy ImMcp-<slug> [ImMcp-<slug>-Waf]`.
2. Run the teardown checklist (section 8) to clean up whatever CFN retains or schedules for deletion.
3. Leave CDKToolkit and the base-image mirror repo in place unless you are decommissioning the region.

## 6. Observability

Log groups (all created by CDK with explicit retention, default 30 days, `RemovalPolicy.DESTROY`
in sample mode):
- `/aws/lambda/<prefix>-oauth` (AS: well-known, DCR, authorize, token)
- `/aws/lambda/<prefix>-middleware` (MCP proxy → InvokeAgentRuntime)
- `/aws/lambda/<prefix>-im-callback` (redirect-mode IMs)
- `/aws/lambda/<prefix>-token-refresher` (scheduled 30-min refresh)
- `/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT` (service-created container stdout; not owned
  by CFN, so delete it in teardown)
- API Gateway HTTP API access log `/aws/apigateway/<prefix>-access`

Alarms (CloudWatch, optional SNS topic from config; none exist today in either China region):
- Middleware Lambda Errors > 0 over 5 min; Duration p99 near timeout
- OAuth Lambda Errors > 0; DCR 4xx spike (`/register` throttled count)
- API GW 5xx > 1% over 5 min; 4xx anomaly (informational)
- Token refresher Errors ≥ 1 (refresh failures mean users silently lose IM access)
- Metric filter on container log: WeCom `850003` (renew authorization) ≥ 1 → alarm (D12)
- Metric filter: InvokeAgentRuntime `ThrottlingException` (session creation quota 25/s)
- Dashboard `<prefix>-<region>` (region suffix avoids per-account name collision)

## 7. Cost notes (sample scale, idle most of the time)

- AgentCore Runtime: billed on active session CPU/memory; idle timeout 600 s keeps it low. Main
  variable cost.
- KMS CMK: ~USD 1 / CNY ~7 per month per key, plus requests. Charged until deletion completes
  (the 7-day pending window is not billed).
- Secrets Manager: ~USD 0.40 per secret-month (root key + IM app secret + one per user).
- API GW HTTP API, Lambda (arm64), DynamoDB on-demand, EventBridge Scheduler (48 invocations/day):
  close to zero at test volume.
- ECR: CDK asset images accumulate per deploy (each image several hundred MB) in
  `cdk-hnb659fds-container-assets-*`; storage ~USD 0.10/GB-month. Prune after tests.
- CloudWatch Logs ingestion/storage; keep retention short.
- China is billed in CNY on a separate bill; prices differ from Global.

## 8. Teardown checklist

- [ ] `cdk destroy` completed with no `DELETE_FAILED` resources.
- [ ] Secrets Manager: delete user secrets and any retained secrets immediately:
      `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`
      (otherwise the name stays reserved for 7–30 days and the next deploy with the same prefix fails).
      List with `list-secrets --filters Key=name,Values=<prefix>/`.
- [ ] KMS: confirm the CMK is `PendingDeletion` (minimum 7-day window; set
      `pendingWindow: 7` in CDK). Do not reuse the alias until deletion completes, or use a new prefix.
- [ ] ECR: delete the image tags/digests this deployment pushed to the CDK assets repo
      (`aws ecr batch-delete-image`); keep the shared `gcr-im-mcp/base/node` mirror.
- [ ] AgentCore: `list-agent-runtimes` shows none of ours; delete leftover workload identities.
- [ ] CloudWatch: delete the runtime log group (not CFN-owned) and any retained log groups.
- [ ] DynamoDB tables gone (or deleted manually if `RETAIN`).
- [ ] EventBridge Scheduler schedules/groups gone.
- [ ] API GW custom domain + ACM cert (if used) removed; DNS record removed.
- [ ] Global WAF stack in us-east-1 destroyed (if deployed).
- [ ] No `ImMcp-*` stacks in `list-stacks` (active statuses).

## 9. Go / no-go for real deploy tests

Global (ap-northeast-1, profile `default`):
- [x] AgentCore Runtime API available; CFN resource type public
- [x] CDK bootstrapped (v30)
- [x] No name collision (no `ImMcp-*` stacks, unrelated runtimes only)
- [x] arm64 build works on host (qemu); public.ecr.aws + npmjs reachable
- [ ] 8-combo synth matrix + unit tests green
- [ ] Explicit approval to run `cdk deploy` (brief: no deploys unless the task says so)
- [ ] us-east-1 bootstrap checked (only if testing WAF)

China (cn-northwest-1 then cn-north-1, profile `gcr`):
- [x] AgentCore Runtime API available; CFN resource type public; MCP protocol + header allowlist in schema
- [x] ECR / Secrets Manager / KMS / DynamoDB / API GW v2 / Scheduler / Lambda / SSM APIs callable
- [x] China ECR login works; npmmirror reachable
- [x] **CDK bootstrap** cn-northwest-1 (v32, 2026-11-04); cn-north-1 still pending
- [x] Base image mirrored to cn-northwest-1 `gcr-im-mcp/base/node:22-bookworm-slim` (digest `sha256:9a422d62…c4ecbc` = arm64 manifest = CN_BASE_DIGEST; IMMUTABLE, scanOnPush) + repo policy for the CDK image-publishing role; cn-north-1 still pending
- [ ] Lambda nodejs22.x/arm64 confirmed (first deploy; fallback nodejs20.x)
- [ ] ICP status known. Without ICP, the default execute-api URL may be blocked; record the observed
      behavior and still count control-plane success (stack CREATE_COMPLETE, runtime READY,
      SigV4 InvokeAgentRuntime from the host with a minted token) as passing
- [ ] 8-combo synth matrix green; aws-cn template has no `arn:aws:` / CloudFront
- [ ] Explicit approval to run `cdk deploy`

Verdict today: **Global = GO** once code and synth tests are ready and deploy is approved.
**China = CONDITIONAL GO**: needs bootstrap and base-image mirror (both approved resource
creations) first, and has two first-deploy unknowns (nodejs22.x/arm64, ICP effect on the
execute-api URL).

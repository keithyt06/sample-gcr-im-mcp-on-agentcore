简体中文 | [English](../en/prerequisites.md)

# 部署前提：部署前需要准备的内容

下表中的所有项都要在**首次部署之前**准备好。密钥一律不写进 `config/deploy.yaml`，而是用辅助脚本写入 AWS Secrets Manager。

**适用范围说明：** `all` 表示所有部署都需要；`china` 表示 `region` 为 `cn-north-1` 或 `cn-northwest-1`；`global` 表示其他受支持区域。

| # | 项目 | 适用范围 | 获取方式 | 填写位置 |
|---|---|---|---|---|
| 1 | 目标区域内具有管理员（或 CDK 部署）权限的 AWS 账号 | all | AWS Global：你的 AWS 账号。AWS 中国区：单独的中国区账号（北京区由光环新网运营，宁夏区由西云数据运营）。Global 与中国区的账号、凭证不能混用 | 不保存，仅在本机 shell 中使用 |
| 2 | 对应分区的 AWS 凭证 profile | all | `aws configure --profile <名称>`（或 SSO）。中国区请单独建一个 profile | 环境变量 `AWS_PROFILE`，同时设置 `AWS_REGION`（中国区不设置的话，STS 会请求 Global 端点，报 `InvalidClientTokenId`） |
| 3 | 已上线 AgentCore Runtime 的目标区域 | all | [Global 区域列表](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html) · [中国区](https://docs.amazonaws.cn/en_us/aws/latest/userguide/bedrock-agentcore.html) | 配置项 `region`。分区由它推导，没有单独的分区配置项 |
| 4 | 部署标识 slug（简短、小写，同一账号同一区域内唯一） | all | 自行指定，例如 `team-a` | 配置项 `slug`，用于 Stack 名（`ImMcp-<slug>`）和密钥名（`<slug>/im-app`） |
| 5 | Node.js 22 LTS 或更高版本 + npm | all | https://nodejs.org（或 nvm） | 本机工具链（以 `package.json` 的 `engines` 为准） |
| 6 | 能构建 **linux/arm64** 镜像的 Docker：ARM64 主机，或 x86 上的 Docker `buildx` + QEMU | all | Docker Desktop / Docker Engine。中国区建议使用 ARM64 主机（QEMU/binfmt 镜像来自 Docker Hub，国内经常无法访问） | 本机工具链 |
| 7 | AWS CLI v2 | all | https://aws.amazon.com/cli/ | 本机工具链 |
| 8 | 目标账号、目标区域完成 CDK bootstrap | all | `npx cdk bootstrap aws://<账号>/<区域>`（每个账号每个区域执行一次） | AWS 账号（CDKToolkit Stack） |
| 9 | `us-east-1` 完成 CDK bootstrap | global，仅当 `ingress.edge: cloudfront` 且 `ingress.waf: true` | 同上命令，区域换成 `us-east-1` | AWS 账号 |
| 10 | 基础镜像预置到中国区 ECR（每次升级 Node 基础镜像时执行一次） | china | 在一台能同时访问 Docker Hub 和中国区 ECR、并持有两个分区凭证的机器上运行镜像同步脚本 | 中国区 ECR 仓库（`build.mirror` 解析为 `cn` 时，构建会自动从这里拉取） |
| 11 | 构建镜像源 | all（默认值即可） | `auto`：中国区自动使用国内镜像源，其他区域使用默认源。**在中国大陆境内构建 Global Stack** 时请设为 `cn` | 配置项 `build.mirror`（`auto` \| `cn` \| `global`） |
| 12 | **已完成 ICP 备案的域名** | china（实际必需） | 通过中国区账号的 ICP 备案流程办理。未备案时，公网无法访问服务端点 | 配置项 `ingress.customDomain` |
| 13 | 该域名的 TLS 证书，放在 ACM 中，且与 Stack **同一区域** | china；Global 使用自定义域名时也需要 | 在目标区域的 ACM 中申请或导入 | 配置项 `ingress.certificateArn` |
| 14 | 自定义域名的 DNS 记录 | 使用自定义域名时 | 你的 DNS 服务商。首次部署后创建，指向部署输出中的 API Gateway 区域域名 | DNS（AWS 外部或 Route 53） |
| 15 | IM 租户，以及能创建、审批应用的管理员 | all | 你的飞书 / Lark / 钉钉 / 企业微信组织 | 见各 IM 配置指南 |
| 16 | 飞书企业自建应用的 **App ID** + **App Secret** | feishu | [open.feishu.cn/app](https://open.feishu.cn/app)，见 [im-setup-feishu.md](im-setup-feishu.md) | App ID → 配置项 `im.feishu.appId`；Secret → `npm run secret:set-im-app` → Secrets Manager `<slug>/im-app` `{appId, appSecret}` |
| 17 | Lark 自建应用的 **App ID** + **App Secret** | lark | [open.larksuite.com/app](https://open.larksuite.com/app)，见 [im-setup-lark.md](im-setup-lark.md) | App ID → `im.lark.appId`；Secret → `npm run secret:set-im-app` → `<slug>/im-app` `{appId, appSecret}` |
| 18 | 钉钉企业内部应用的 **Client ID（原 AppKey）** + **Client Secret（原 AppSecret）** | dingtalk | [open-dev.dingtalk.com](https://open-dev.dingtalk.com)，见 [im-setup-dingtalk.md](im-setup-dingtalk.md) | Client ID → `im.dingtalk.clientId`；Secret → `npm run secret:set-im-app` → `<slug>/im-app` `{clientId, clientSecret}` |
| 19 | 用户授权时申请的 scope（可选，有默认值） | feishu / lark / dingtalk | 见各 IM 配置指南 | 配置项 `im.feishu.scopes` / `im.lark.scopes` / `im.dingtalk.scopes` |
| 20 | 企业微信：不需要在开发者后台创建任何应用 | wecom | 部署后，每个用户在企业微信客户端扫码，创建或绑定自己的智能机器人。见 [im-setup-wecom.md](im-setup-wecom.md) | 无应用凭证。每个用户的凭证由服务自动保存 |
| 21 | **管理员审批** | feishu / lark：发布应用版本并审批通过。dingtalk：发布应用，并为组织**开通 CLI 访问**。wecom：用户（以及限制机器人的组织的管理员）同意智能机器人的能力授权 | IM 管理后台（见各 IM 配置指南） | 在 IM 后台完成，无需保存 |
| 22 | **重定向（回调）URL 登记**，在**首次部署之后**进行 | feishu / lark / dingtalk | 部署输出会打印 `<base>/callback` | 粘贴到 IM 后台（飞书/Lark：安全设置 → 重定向 URL；钉钉：见指南）。`<base>` 是 `https://<ingress.customDomain>` 或 API Gateway URL |
| 23 | 告警 webhook URL（可选） | all | IM 群机器人 webhook（或任意 HTTPS 端点） | 先自行把 URL 存入一个 **SSM 参数**，配置项 `alarm.webhookUrlSsmParam` 只填**参数名** |
| 24 | MCP 客户端 | all | Global：Amazon Quick、Kiro、Claude Code、Codex、Cursor。中国区：Kiro、Claude Code、Codex、Cursor（AWS 中国区没有 Amazon Quick） | 终端用户只需要 `<base>/mcp` |

> **关于 `im.<im>.*` 配置项：** 在 `config/deploy.yaml` 里，这些配置项写成与 `im: feishu` 并列的顶层 `feishu:`（或 `lark:`、`dingtalk:`、`wecom:`）块。例如 `im.feishu.appId` 写作 `feishu: { appId: cli_xxx }`。只保留与 `im` 对应的那一个块。示例见 `config/deploy.example.yaml`。

## 操作顺序

1. 准备第 1–11 项（AWS 侧）；中国区还要准备第 12–13 项。
2. 创建 IM 应用（第 15–19 项）；企业微信不需要。
3. 填写 `config/deploy.yaml`，执行 `npm run secret:set-im-app`（企业微信不需要）。
4. 部署，从输出中复制 `<base>/callback`。
5. 在 IM 后台登记回调 URL（第 22 项），发布或审批（第 21 项），创建 DNS 记录（第 14 项）。
6. 把 `<base>/mcp` 发给终端用户。

## 以下内容不得放进仓库或配置文件

应用密钥、用户 token、AWS 访问密钥、账号 ID、`.aws/` 文件、私钥、带 token 的 webhook URL。配置文件里**只放标识和名称**（应用 ID、SSM 参数名、证书 ARN）。

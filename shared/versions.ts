// Pinned CLI versions and base image references (technical design §3.6, Ops plan §1).

export const CLI = {
  lark: { pkg: '@larksuite/cli', version: '1.0.99' },
  dingtalk: { pkg: 'dingtalk-workspace-cli', version: '1.0.67' },
  wecom: { pkg: '@wecom/cli', version: '1.3.4', platformPkg: '@wecom/cli-linux-arm64' },
} as const;

export const GLOBAL_BASE_IMAGE =
  'public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da';
export const CN_BASE_REPO = 'gcr-im-mcp/base/node';
export const CN_BASE_DIGEST = 'sha256:9a422d62743ffb1e6eb282549f4eae7ab89f7b926db1f136f4cba8be60e4ecbc'; // arm64 manifest; re-verify after mirror (Ops §3)
export const LARK_BINARY_BASE = 'https://registry.npmmirror.com/-/binary/lark-cli';

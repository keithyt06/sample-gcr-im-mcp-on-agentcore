// Frozen cross-component names (technical design §4.9).
// Changes here need approval from all three work-package owners.

export const HDR_PREFIX = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-';

export const H = {
  userId: `${HDR_PREFIX}User-Id`,
  userToken: `${HDR_PREFIX}User-Token`,
  authorizeUrl: `${HDR_PREFIX}Authorize-Url`,
  requestId: `${HDR_PREFIX}Request-Id`,
  caller: `${HDR_PREFIX}Caller`,
} as const;

export type RuntimeHeader = (typeof H)[keyof typeof H];

export const RUNTIME_HEADERS: RuntimeHeader[] = Object.values(H);

export const CONTROL_METHODS = ['im/auth.start', 'im/auth.status'] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

export const ERROR_CODES = [
  'im_not_authorized',
  'missing_scope',
  'im_reauth_required',
  'im_admin_action_required',
  'im_grant_expired',
  'im_rate_limited',
  'im_policy_blocked',
  'im_object_permission',
  'im_app_not_configured',
  'user_approval_required',
  'invalid_argument',
  'unknown_tool',
  'timeout',
  'output_too_large',
  'server_busy',
  'cli_failed',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every environment variable name used by the Runtime (§3.5), the Lambdas (§6.2) and the image. */
export const ENV = {
  // Runtime + Lambdas
  IM: 'IM',
  SLUG: 'SLUG',
  METRIC_NAMESPACE: 'METRIC_NAMESPACE',
  MAX_CONCURRENT: 'MAX_CONCURRENT',
  AWS_REGION: 'AWS_REGION',
  IM_APP_ID: 'IM_APP_ID',
  IM_APP_SECRET_ID: 'IM_APP_SECRET_ID',
  DINGTALK_DWS_AGENTCODE: 'DINGTALK_DWS_AGENTCODE',
  USER_SECRET_PREFIX: 'USER_SECRET_PREFIX',
  USER_SECRET_KMS_KEY_ARN: 'USER_SECRET_KMS_KEY_ARN',
  // Lambdas only
  BASE_URL_PARAM: 'BASE_URL_PARAM',
  ROOT_KEY_SECRET_ID: 'ROOT_KEY_SECRET_ID',
  TABLE_NAME: 'TABLE_NAME',
  IM_SCOPES: 'IM_SCOPES',
  RUNTIME_ARN: 'RUNTIME_ARN',
  AGENTCORE_ENDPOINT: 'AGENTCORE_ENDPOINT',
  EXTRA_REDIRECT_HOSTS: 'EXTRA_REDIRECT_HOSTS',
  QUICK_REDIRECT_HOSTS: 'QUICK_REDIRECT_HOSTS',
  NEEDS_USER_TOKEN: 'NEEDS_USER_TOKEN',
  WEBHOOK_URL_PARAM: 'WEBHOOK_URL_PARAM',
  WECOM_MAX_PENDING_QR: 'WECOM_MAX_PENDING_QR',
  WECOM_REQUIRE_APPROVAL: 'WECOM_REQUIRE_APPROVAL',
  // Container image (Dockerfile ENV)
  IM_TOOLS_DIR: 'IM_TOOLS_DIR',
  PORT: 'PORT',
} as const;
export type EnvName = (typeof ENV)[keyof typeof ENV];

export type Im = 'feishu' | 'lark' | 'dingtalk' | 'wecom';
export const IMS: readonly Im[] = ['feishu', 'lark', 'dingtalk', 'wecom'] as const;

export const METRICS = [
  'TokenStoreFailed',
  'TokenLost',
  'RefreshFailed',
  'RefreshRevoked',
  'ImGrantExpired',
  'ImRateLimited',
] as const;
export type MetricName = (typeof METRICS)[number];

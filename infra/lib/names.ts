// Every physical name derived from the slug (technical design §3.2).
export interface Names {
  stack: string;
  wafStack: string;
  runtime: string;
  imAppSecret: string;
  rootKeySecret: string;
  userSecretPrefix: string;
  baseUrlParam: string;
  fn: (f: LambdaName) => string;
  fnLogGroup: (f: LambdaName) => string;
  accessLogGroup: string;
  httpApi: string;
  alarmTopic: string;
  alarm: (name: string) => string;
  metricNamespace: string;
  kmsAlias: string;
  wafAcl: string;
}

export type LambdaName = 'oauth' | 'middleware' | 'refresh' | 'alarm';

export function namesFor(slug: string, region: string): Names {
  const fn = (f: LambdaName) => `im-mcp-${slug}-${f}`;
  return {
    stack: `ImMcp-${slug}`,
    wafStack: `ImMcp-${slug}-Waf`,
    runtime: `im_mcp_${slug.replace(/-/g, '_')}`,
    imAppSecret: `${slug}/im-app`,
    rootKeySecret: `${slug}/root-key`,
    userSecretPrefix: `${slug}/users`,
    baseUrlParam: `/im-mcp/${slug}/base-url`,
    fn,
    fnLogGroup: (f) => `/aws/lambda/${fn(f)}`,
    accessLogGroup: `/aws/apigateway/im-mcp-${slug}-access`,
    httpApi: `im-mcp-${slug}`,
    alarmTopic: `im-mcp-${slug}-alarms`,
    alarm: (name) => `im-mcp-${slug}-${region}-${name}`,
    metricNamespace: `ImMcp/${slug}`,
    kmsAlias: `alias/im-mcp-${slug}-users`,
    wafAcl: `im-mcp-${slug}-waf`,
  };
}

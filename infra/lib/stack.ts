import { CfnOutput, Stack, Tags, type App, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { getInfraAdapter, type InfraAdapter } from './adapters/index.js';
import { derive, type Config, type Derived } from './config.js';
import { Alarms } from './constructs/alarms.js';
import { Image } from './constructs/image.js';
import { Ingress } from './constructs/ingress.js';
import { MiddlewareFunction } from './constructs/middleware.js';
import { OauthFunction } from './constructs/oauth.js';
import { RefreshFunction } from './constructs/refresh.js';
import { Runtime } from './constructs/runtime.js';
import { Storage } from './constructs/storage.js';
import { namesFor, type Names } from './names.js';
import { applyNag } from './nag.js';
import { ImMcpWafStack } from './waf-stack.js';

export interface ImMcpStackProps extends StackProps {
  cfg: Config;
  d: Derived;
  webAclArn?: string;
}

/** The one stack per deployment: `ImMcp-<slug>` (D1). */
export class ImMcpStack extends Stack {
  readonly names: Names;
  readonly adapter: InfraAdapter;
  readonly storage: Storage;
  readonly runtime: Runtime;
  readonly ingress: Ingress;
  readonly oauth: OauthFunction;
  readonly middleware: MiddlewareFunction;
  readonly refresh?: RefreshFunction;
  readonly alarms: Alarms;

  constructor(scope: Construct, id: string, props: ImMcpStackProps) {
    super(scope, id, { description: `IM MCP server on Amazon Bedrock AgentCore (${props.cfg.im}, ${props.cfg.slug})`, ...props });
    const { cfg, d } = props;
    const names = (this.names = namesFor(cfg.slug, cfg.region));
    const adapter = (this.adapter = getInfraAdapter(cfg.im));

    this.storage = new Storage(this, 'Storage', { names, withImAppSecret: adapter.needsAppSecret });
    const image = new Image(this, 'Image', { cfg, d });
    this.runtime = new Runtime(this, 'Runtime', { cfg, names, adapter, image, cmk: this.storage.userSecretKey, imApp: this.storage.imApp });

    const common = { cfg, d, names, adapter, storage: this.storage, runtimeArn: this.runtime.runtimeArn };
    this.oauth = new OauthFunction(this, 'Oauth', common);
    this.middleware = new MiddlewareFunction(this, 'Middleware', common);
    if (adapter.needsRefresh) this.refresh = new RefreshFunction(this, 'Refresh', common);

    this.ingress = new Ingress(this, 'Ingress', {
      cfg,
      d,
      names,
      oauthFn: this.oauth.f.fn,
      middlewareFn: this.middleware.f.fn,
      webAclArn: props.webAclArn,
    });
    this.alarms = new Alarms(this, 'Alarms', {
      cfg,
      names,
      adapter,
      httpApiId: this.ingress.httpApi.apiId,
      fns: { oauth: this.oauth.f.fn, middleware: this.middleware.f.fn, refresh: this.refresh?.f.fn },
    });

    const base = this.ingress.baseUrl;
    new CfnOutput(this, 'BaseUrl', { value: base });
    new CfnOutput(this, 'McpUrl', { value: `${base}/mcp`, description: 'Give this URL to MCP clients' });
    if (adapter.authMode === 'redirect') {
      new CfnOutput(this, 'CallbackUrl', { value: `${base}/callback`, description: 'Register this redirect URL in the IM developer console' });
      new CfnOutput(this, 'ImAppSecretName', { value: names.imAppSecret, description: 'Fill with npm run secret:set-im-app' });
    }
    const hint = adapter.imConsoleCallbackHint(cfg);
    if (hint) new CfnOutput(this, 'ImConsoleCallbackHint', { value: hint });
    new CfnOutput(this, 'RuntimeArn', { value: this.runtime.runtimeArn });
    new CfnOutput(this, 'AlarmTopicArn', { value: this.alarms.topic.topicArn });
    new CfnOutput(this, 'RootKeySecretName', { value: names.rootKeySecret });
    new CfnOutput(this, 'UserSecretPrefix', { value: names.userSecretPrefix });
    new CfnOutput(this, 'TableName', { value: this.storage.table.tableName });

    applyNag(this, cfg.slug);
  }
}

/** App wiring (§3.1): the main stack, plus the us-east-1 WAF stack when `ingress.waf` is on (aws only). */
export function addImMcpStacks(app: App, cfg: Config, account = process.env.CDK_DEFAULT_ACCOUNT): { main: ImMcpStack; waf?: ImMcpWafStack } {
  const d = derive(cfg);
  const names = namesFor(cfg.slug, cfg.region);
  const env = { account, region: cfg.region };
  let waf: ImMcpWafStack | undefined;
  if (cfg.ingress.waf) {
    waf = new ImMcpWafStack(app, names.wafStack, { env: { account, region: 'us-east-1' }, crossRegionReferences: true, names });
  }
  const main = new ImMcpStack(app, names.stack, { env, cfg, d, webAclArn: waf?.webAclArn, crossRegionReferences: !!waf });
  if (waf) main.addStackDependency(waf);
  Tags.of(app).add('project', 'gcr-im-mcp-on-agentcore');
  Tags.of(app).add('im-mcp:slug', cfg.slug);
  return { main, waf };
}

import { CfnOutput, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import type { Config, Derived } from '../config.js';
import type { Names } from '../names.js';

export interface IngressProps {
  cfg: Config;
  d: Derived;
  names: Names;
  oauthFn: lambda.IFunction;
  middlewareFn: lambda.IFunction;
  /** WAF web ACL (us-east-1, CLOUDFRONT scope); only with edge: cloudfront on aws. */
  webAclArn?: string;
}

const M = apigwv2.HttpMethod;

/** OAuth routes (§4.1). All served by the oauth Lambda. */
export const OAUTH_ROUTES: [apigwv2.HttpMethod, string][] = [
  [M.GET, '/.well-known/oauth-authorization-server'],
  [M.GET, '/.well-known/oauth-protected-resource'],
  [M.GET, '/.well-known/oauth-protected-resource/mcp'],
  [M.POST, '/register'],
  [M.GET, '/authorize'],
  [M.GET, '/authorize/status'],
  [M.GET, '/callback'],
  [M.POST, '/token'],
];
export const MCP_METHODS = [M.POST, M.GET, M.DELETE];

/**
 * HTTP API at the origin root (`$default` stage) so RFC 8414 / RFC 9728 well-known paths and DCR resolve
 * from the base URL. Same default in both partitions (D3).
 */
export class Ingress extends Construct {
  readonly httpApi: apigwv2.HttpApi;
  readonly baseUrl: string;
  readonly baseUrlParam: ssm.StringParameter;
  readonly distribution?: cloudfront.Distribution;
  readonly domainName?: apigwv2.DomainName;

  constructor(scope: Construct, id: string, props: IngressProps) {
    super(scope, id);
    const { cfg, d, names } = props;
    const stack = Stack.of(this);
    const rl = cfg.ingress.rateLimit;

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: names.httpApi,
      description: `IM MCP server (${cfg.im}) - OAuth AS + MCP endpoint`,
      createDefaultStage: true,
    });

    const oauthInt = new HttpLambdaIntegration('OauthIntegration', props.oauthFn);
    const mcpInt = new HttpLambdaIntegration('McpIntegration', props.middlewareFn);
    const routes: apigwv2.HttpRoute[] = [];
    for (const [method, path] of OAUTH_ROUTES) routes.push(...this.httpApi.addRoutes({ path, methods: [method], integration: oauthInt }));
    routes.push(...this.httpApi.addRoutes({ path: '/mcp', methods: MCP_METHODS, integration: mcpInt }));

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: names.accessLogGroup,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const stage = this.httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    // RouteSettings refers to the route key, so the stage must be created after every route.
    for (const r of routes) stage.node.addDependency(r);
    stage.defaultRouteSettings = { throttlingRateLimit: rl.rps, throttlingBurstLimit: rl.burst };
    stage.routeSettings = { 'POST /register': { ThrottlingRateLimit: rl.registerRps, ThrottlingBurstLimit: rl.registerBurst } };
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        routeKey: '$context.routeKey',
        status: '$context.status',
        responseLatency: '$context.responseLatency',
        integrationErrorMessage: '$context.integrationErrorMessage',
      }),
    };

    let baseUrl: string = this.httpApi.apiEndpoint;

    if (cfg.ingress.customDomain) {
      this.domainName = new apigwv2.DomainName(this, 'DomainName', {
        domainName: cfg.ingress.customDomain,
        certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', cfg.ingress.certificateArn!),
      });
      new apigwv2.ApiMapping(this, 'ApiMapping', { api: this.httpApi, domainName: this.domainName, stage: this.httpApi.defaultStage });
      baseUrl = `https://${cfg.ingress.customDomain}`;
      new CfnOutput(stack, 'CustomDomainTarget', {
        value: this.domainName.regionalDomainName,
        description: 'Create a CNAME (or alias) record for the custom domain pointing at this name',
      });
    }

    if (cfg.ingress.edge === 'cloudfront') {
      if (d.isChina) throw new Error('ingress.edge: cloudfront is not available in AWS China regions'); // config rejects this first
      // apiEndpoint = https://<id>.execute-api.<region>.<suffix>; the origin needs the bare host.
      const apiHost = Fn.select(2, Fn.split('/', this.httpApi.apiEndpoint));
      this.distribution = new cloudfront.Distribution(this, 'Distribution', {
        comment: `IM MCP server (${cfg.slug})`,
        defaultBehavior: {
          origin: new origins.HttpOrigin(apiHost, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        webAclId: props.webAclArn,
      });
      baseUrl = `https://${this.distribution.distributionDomainName}`;
    }

    this.baseUrl = baseUrl;
    this.baseUrlParam = new ssm.StringParameter(this, 'BaseUrl', {
      parameterName: names.baseUrlParam,
      description: 'Public base URL of the IM MCP server (read by the Lambdas at runtime)',
      stringValue: baseUrl,
    });
  }
}

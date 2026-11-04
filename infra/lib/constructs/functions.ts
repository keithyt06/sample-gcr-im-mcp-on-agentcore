import { join } from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { REPO_ROOT } from '../config.js';
import type { LambdaName, Names } from '../names.js';

const SIZES: Record<LambdaName, { memoryMb: number; timeoutSec: number }> = {
  oauth: { memoryMb: 256, timeoutSec: 29 },
  middleware: { memoryMb: 512, timeoutSec: 29 },
  refresh: { memoryMb: 256, timeoutSec: 300 },
  alarm: { memoryMb: 128, timeoutSec: 10 },
};

export interface ImFunctionProps {
  name: LambdaName;
  names: Names;
  environment: Record<string, string>;
}

/** Shared Lambda factory (§6.1): Node 22 arm64, own role (no managed policies), explicit log group, SDK bundled. */
export class ImFunction extends Construct {
  readonly fn: nodejs.NodejsFunction;
  readonly role: iam.Role;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ImFunctionProps) {
    super(scope, id);
    const { name, names } = props;
    const size = SIZES[name];

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: names.fnLogGroup(name),
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.role = new iam.Role(this, 'Role', {
      description: `Execution role for ${names.fn(name)}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${this.logGroup.logGroupArn}:*`] }),
    );

    this.fn = new nodejs.NodejsFunction(this, 'Fn', {
      functionName: names.fn(name),
      entry: join(REPO_ROOT, 'lambda', name, 'index.ts'),
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: join(REPO_ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: size.memoryMb,
      timeout: Duration.seconds(size.timeoutSec),
      role: this.role,
      logGroup: this.logGroup,
      environment: props.environment,
      bundling: {
        target: 'node22',
        format: nodejs.OutputFormat.CJS,
        minify: true,
        sourceMap: true,
        externalModules: [],
        logLevel: nodejs.LogLevel.WARNING,
        // Bundling must never fall back to Docker (esbuild is a devDependency).
        forceDockerBundling: false,
      },
    });
    // Log group must exist before the function writes to it.
    this.fn.node.addDependency(this.logGroup);
  }

  /** Add an inline policy statement to this function's own role. */
  allow(actions: string[], resources: string[]): void {
    this.role.addToPolicy(new iam.PolicyStatement({ actions, resources }));
  }
}

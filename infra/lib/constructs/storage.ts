import { RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { Names } from '../names.js';

export interface StorageProps {
  names: Names;
  /** redirect IMs only */
  withImAppSecret: boolean;
}

/** CMK for per-user secrets, the single OAuth table, the HMAC root key, and the IM app secret placeholder (§3.3). */
export class Storage extends Construct {
  readonly userSecretKey: kms.Key;
  readonly table: dynamodb.Table;
  readonly rootKey: secretsmanager.Secret;
  readonly imApp?: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    const { names } = props;

    this.userSecretKey = new kms.Key(this, 'UserSecretKey', {
      description: `Encrypts per-user IM credentials (${names.userSecretPrefix}/*)`,
      enableKeyRotation: true,
      pendingWindow: Duration.days(7),
      removalPolicy: RemovalPolicy.RETAIN,
      alias: names.kmsAlias,
    });

    this.table = new dynamodb.Table(this, 'Oauth', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.rootKey = new secretsmanager.Secret(this, 'RootKey', {
      secretName: names.rootKeySecret,
      description: 'HMAC root key for MCP access tokens, DCR client ids and session ids',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    if (props.withImAppSecret) {
      // The app id is NOT in the template, so changing it never regenerates the value.
      // The operator fills the real value with `npm run secret:set-im-app`.
      this.imApp = new secretsmanager.Secret(this, 'ImApp', {
        secretName: names.imAppSecret,
        description: 'IM app credentials; filled by npm run secret:set-im-app',
        generateSecretString: { secretStringTemplate: '{"configured":false}', generateStringKey: 'appSecret' },
        removalPolicy: RemovalPolicy.DESTROY,
      });
    }
  }
}

import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config.js';
import { addImMcpStacks } from '../lib/stack.js';

const app = new App();
addImMcpStacks(app, loadConfig(app.node.tryGetContext('config') ?? 'config/deploy.yaml'));

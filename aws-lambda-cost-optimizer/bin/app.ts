#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LambdaOptimizerStack } from '../lib/lambda-optimizer-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new LambdaOptimizerStack(app, 'LambdaCostOptimizerStack', {
  env,
  description:
    'Scans all Lambda functions in the account for cost optimization opportunities ' +
    '(memory right-sizing, dead functions, cold starts, ARM64 migration, timeout sanity) ' +
    'and emails a weekly HTML report.',
  tags: {
    Project: 'aws-lambda-cost-optimizer',
    ManagedBy: 'cdk',
  },
});

app.synth();

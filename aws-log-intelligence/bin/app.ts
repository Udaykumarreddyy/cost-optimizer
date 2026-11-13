#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LogIntelligenceStack } from '../lib/log-intelligence-stack';

const app = new cdk.App();

new LogIntelligenceStack(app, 'LogIntelligenceStack', {
  description: 'Weekly CloudWatch Log Group cost optimization and problem detection (aws-log-intelligence).',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
  tags: {
    Project: 'aws-log-intelligence',
    Purpose: 'cost-optimization'
  }
});

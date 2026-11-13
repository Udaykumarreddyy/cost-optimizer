#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ContainerOptimizerStack } from '../lib/container-optimizer-stack';

const app = new cdk.App();

new ContainerOptimizerStack(app, 'ContainerOptimizerStack', {
  description: 'Analyzes ECS/EKS container workloads for cost optimization and reliability issues (aws-container-optimizer).',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  tags: {
    Project: 'aws-container-optimizer',
  },
});

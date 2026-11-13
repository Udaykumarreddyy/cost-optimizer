#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkCostStack } from '../lib/network-cost-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

new NetworkCostStack(app, 'NetworkCostAnalyzerStack', {
  env,
  description:
    'AWS Network Cost Analyzer - scans NAT Gateways, cross-AZ transfer, VPC endpoints, idle load balancers, and unused Elastic IPs for savings opportunities.',
  tags: {
    Project: 'aws-network-cost-analyzer',
    Purpose: 'FinOps-NetworkCostVisibility',
  },
});

app.synth();

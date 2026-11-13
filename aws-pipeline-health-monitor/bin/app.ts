#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PipelineHealthStack } from '../lib/pipeline-health-stack';

const app = new cdk.App();

new PipelineHealthStack(app, 'PipelineHealthMonitorStack', {
  description:
    'Weekly health monitor for AWS CodePipeline and CodeBuild - computes DORA metrics, publishes an HTML dashboard to S3, and emails a summary via SNS.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
  tags: {
    Project: 'aws-pipeline-health-monitor',
    Owner: 'platform-engineering'
  }
});

app.synth();

#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { CostOptimizerStack } from "../lib/cost-optimizer-stack";

const app = new cdk.App();

new CostOptimizerStack(app, "AwsCostOptimizerStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    "AWS Cost Optimizer — Weekly scan for idle/unused resources with HTML report & SNS alerts",
});

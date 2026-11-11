import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CostOptimizerStack } from "../lib/cost-optimizer-stack";

describe("CostOptimizerStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new CostOptimizerStack(app, "TestStack");
    template = Template.fromStack(stack);
  });

  test("Creates S3 bucket for reports", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: [
          {
            ExpirationInDays: 90,
            Status: "Enabled",
          },
        ],
      },
    });
  });

  test("Creates SNS topic for alerts", () => {
    template.hasResourceProperties("AWS::SNS::Topic", {
      DisplayName: "AWS Cost Optimizer Alerts",
      TopicName: "cost-optimizer-alerts",
    });
  });

  test("Creates Lambda function with correct runtime", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs20.x",
      Handler: "handler.handler",
      Timeout: 300,
      MemorySize: 512,
    });
  });

  test("Creates EventBridge rule for weekly schedule", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 8 ? * MON *)",
    });
  });

  test("Lambda has required environment variables", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          REPORT_BUCKET: {},
          SNS_TOPIC_ARN: {},
          SNAPSHOT_AGE_DAYS: {},
          EC2_IDLE_CPU_THRESHOLD: {},
        },
      },
    });
  });

  test("IAM role has EC2 read permissions", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: expect.arrayContaining([
          expect.objectContaining({
            Action: expect.arrayContaining(["ec2:DescribeInstances"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });
});

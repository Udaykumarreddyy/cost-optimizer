import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkCostStack } from '../lib/network-cost-stack';

function synthTemplate(): Template {
  const app = new cdk.App();
  const stack = new NetworkCostStack(app, 'TestNetworkCostStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('NetworkCostStack', () => {
  let template: Template;

  beforeAll(() => {
    template = synthTemplate();
  });

  test('declares NotificationEmail and LookbackDays parameters', () => {
    template.hasParameter('NotificationEmail', {
      Type: 'String',
    });
    template.hasParameter('LookbackDays', {
      Type: 'Number',
      Default: 7,
    });
  });

  test('creates an S3 bucket with a 90-day lifecycle expiration rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            ExpirationInDays: 90,
          }),
        ]),
      },
    });
  });

  test('creates an SNS topic with an email subscription', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
    });
  });

  test('creates the analyzer Lambda with 512MB memory and a 10 minute timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'network-cost-analyzer',
      MemorySize: 512,
      Timeout: 600,
      Runtime: Match.stringLikeRegexp('nodejs20.x'),
    });
  });

  test('creates a weekly EventBridge rule for Monday 08:00 UTC', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 8 ? * MON *)',
      State: 'ENABLED',
    });
  });

  test('grants the Lambda execution role the required read-only network/cost permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'ec2:Describe*',
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: 'elasticloadbalancing:Describe*',
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['cloudwatch:GetMetricData']),
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['ce:GetCostAndUsage']),
          }),
        ]),
      },
    });
  });

  test('exposes stack outputs for the bucket, topic, and function name', () => {
    template.hasOutput('ReportBucketName', {});
    template.hasOutput('NotificationTopicArn', {});
    template.hasOutput('AnalyzerFunctionName', {});
  });
});

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ContainerOptimizerStack } from '../lib/container-optimizer-stack';

function synthTemplate(): Template {
  const app = new cdk.App();
  const stack = new ContainerOptimizerStack(app, 'TestContainerOptimizerStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('ContainerOptimizerStack', () => {
  let template: Template;

  beforeAll(() => {
    template = synthTemplate();
  });

  test('creates an S3 report bucket with a 90-day lifecycle rule', () => {
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

  test('S3 bucket blocks public access and enforces encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.anyValue(),
      }),
    });
  });

  test('creates an SNS topic with an email subscription', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
    });
  });

  test('creates the analyzer Lambda with correct memory and timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
      Timeout: 600,
      Runtime: Match.stringLikeRegexp('nodejs20.x'),
    });
  });

  test('Lambda has ECS, EKS, and CloudWatch read permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['ecs:List*', 'ecs:Describe*']),
          }),
        ]),
      },
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['eks:List*', 'eks:Describe*']),
          }),
        ]),
      },
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['cloudwatch:GetMetricData']),
          }),
        ]),
      },
    });
  });

  test('creates a weekly EventBridge rule scheduled for Monday 08:00 UTC', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 8 ? * MON *)',
      State: 'ENABLED',
    });
  });

  test('defines NotificationEmail, CPUUtilizationThreshold, and MemoryUtilizationThreshold parameters', () => {
    template.hasParameter('NotificationEmail', { Type: 'String' });
    template.hasParameter('CPUUtilizationThreshold', { Type: 'Number', Default: 30 });
    template.hasParameter('MemoryUtilizationThreshold', { Type: 'Number', Default: 30 });
  });

  test('exposes stack outputs for the report bucket, SNS topic, and function name', () => {
    template.hasOutput('ReportBucketName', {});
    template.hasOutput('SnsTopicArn', {});
    template.hasOutput('AnalyzerFunctionName', {});
  });
});

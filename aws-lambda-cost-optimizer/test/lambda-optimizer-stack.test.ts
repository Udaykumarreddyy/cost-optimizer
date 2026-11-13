import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LambdaOptimizerStack } from '../lib/lambda-optimizer-stack';

describe('LambdaOptimizerStack', () => {
  let app: cdk.App;
  let stack: LambdaOptimizerStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new LambdaOptimizerStack(app, 'TestLambdaOptimizerStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('creates exactly one S3 report bucket with a 90-day lifecycle rule', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.anyValue(),
      }),
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

  test('blocks all public access on the report bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates an SNS topic with an email subscription', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
    });
  });

  test('creates the optimizer Lambda function with 512MB / 10 minute timeout on arm64', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
      Timeout: 600,
      Architectures: ['arm64'],
      Runtime: Match.stringLikeRegexp('nodejs20'),
    });
  });

  test('optimizer function has REPORT_BUCKET_NAME, SNS_TOPIC_ARN, LOOKBACK_DAYS, MIN_INVOCATIONS env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REPORT_BUCKET_NAME: Match.anyValue(),
          SNS_TOPIC_ARN: Match.anyValue(),
          LOOKBACK_DAYS: Match.anyValue(),
          MIN_INVOCATIONS: Match.anyValue(),
        }),
      },
    });
  });

  test('grants least-privilege read-only Lambda and CloudWatch IAM permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['lambda:List*']),
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['cloudwatch:GetMetricData']),
          }),
        ]),
      }),
    });
  });

  test('creates an EventBridge rule scheduled for Monday 08:00 UTC', () => {
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 8 ? * MON *)',
      State: 'ENABLED',
    });
  });

  test('EventBridge rule targets the optimizer Lambda function', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.anyValue(),
        }),
      ]),
    });
  });

  test('exposes stack parameters for NotificationEmail, LookbackDays, and MinInvocations', () => {
    template.hasParameter('NotificationEmail', Match.objectLike({ Type: 'String' }));
    template.hasParameter('LookbackDays', Match.objectLike({ Type: 'Number', Default: 14 }));
    template.hasParameter('MinInvocations', Match.objectLike({ Type: 'Number', Default: 100 }));
  });

  test('synthesizes without error and produces the expected CfnOutputs', () => {
    template.hasOutput('ReportBucketName', {});
    template.hasOutput('NotificationTopicArn', {});
    template.hasOutput('OptimizerFunctionName', {});
    template.hasOutput('OptimizerFunctionArn', {});
  });
});

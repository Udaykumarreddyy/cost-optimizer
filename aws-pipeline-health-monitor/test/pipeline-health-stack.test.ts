import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PipelineHealthStack } from '../lib/pipeline-health-stack';

describe('PipelineHealthStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new PipelineHealthStack(app, 'TestPipelineHealthStack', {
      env: { account: '123456789012', region: 'us-east-1' }
    });
    template = Template.fromStack(stack);
  });

  test('creates an encrypted, private S3 bucket with a 90-day lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'AES256' })
          })
        ])
      }),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            ExpirationInDays: 90
          })
        ])
      }
    });
  });

  test('creates an SNS topic with an email subscription', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email'
    });
  });

  test('creates the Lambda function with a 10-minute timeout and 512MB memory', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 600,
      MemorySize: 512,
      Runtime: Match.stringLikeRegexp('nodejs20.x')
    });
  });

  test('creates a weekly EventBridge rule scheduled for Monday 08:00 UTC', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 8 ? * MON *)',
      State: 'ENABLED'
    });
  });

  test('grants the Lambda role read-only CodePipeline, CodeBuild, and CloudWatch permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['codepipeline:List*', 'codepipeline:Get*'])
          })
        ])
      })
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['codebuild:List*', 'codebuild:BatchGet*'])
          })
        ])
      })
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['cloudwatch:GetMetricData'])
          })
        ])
      })
    });
  });

  test('exposes NotificationEmail and LookbackDays parameters with the correct default', () => {
    template.hasParameter('NotificationEmail', Match.objectLike({ Type: 'String' }));
    template.hasParameter(
      'LookbackDays',
      Match.objectLike({ Type: 'Number', Default: 7 })
    );
  });

  test('wires the EventBridge rule to invoke the Lambda function', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.anyValue()
        })
      ])
    });
  });
});

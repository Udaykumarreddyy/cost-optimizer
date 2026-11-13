import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LogIntelligenceStack } from '../lib/log-intelligence-stack';

function synthTemplate(): Template {
  const app = new cdk.App();
  const stack = new LogIntelligenceStack(app, 'TestLogIntelligenceStack', {
    env: { account: '123456789012', region: 'us-east-1' }
  });
  return Template.fromStack(stack);
}

describe('LogIntelligenceStack', () => {
  let template: Template;

  beforeAll(() => {
    template = synthTemplate();
  });

  test('declares the three required CfnParameters', () => {
    template.hasParameter('NotificationEmail', {
      Type: 'String'
    });
    template.hasParameter('RetentionRecommendationDays', {
      Type: 'Number',
      Default: 30
    });
    template.hasParameter('ErrorSpikeThreshold', {
      Type: 'Number',
      Default: 50
    });
  });

  test('creates an S3 report bucket with a 90-day lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
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

  test('blocks public access on the report bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      }
    });
  });

  test('creates an SNS topic with an email subscription', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email'
    });
  });

  test('creates the analyzer Lambda with 10-minute timeout and 1024MB memory', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 600,
      MemorySize: 1024,
      Runtime: Match.stringLikeRegexp('nodejs20.x')
    });
  });

  test('Lambda environment wires the bucket, topic, and parameters', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REPORT_BUCKET_NAME: Match.anyValue(),
          SNS_TOPIC_ARN: Match.anyValue(),
          RETENTION_RECOMMENDATION_DAYS: Match.anyValue(),
          ERROR_SPIKE_THRESHOLD: Match.anyValue()
        })
      }
    });
  });

  test('grants the required read-only CloudWatch Logs and CloudWatch Metrics IAM actions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['logs:Describe*', 'logs:GetLogEvents', 'logs:FilterLogEvents'])
          })
        ])
      }
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['cloudwatch:GetMetricData'])
          })
        ])
      }
    });
  });

  test('creates an EventBridge rule scheduled for Monday 08:00 UTC', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 8 ? * MON *)',
      State: 'ENABLED'
    });
  });

  test('EventBridge rule targets the analyzer Lambda', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.anyValue()
        })
      ])
    });
  });

  test('declares the expected stack outputs', () => {
    template.hasOutput('ReportBucketName', {});
    template.hasOutput('NotificationTopicArn', {});
    template.hasOutput('AnalyzerFunctionName', {});
  });
});

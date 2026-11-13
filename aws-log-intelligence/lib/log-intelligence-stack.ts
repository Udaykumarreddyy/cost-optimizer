import { Construct } from 'constructs';
import {
  Stack,
  StackProps,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Aws,
  CfnOutput
} from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export class LogIntelligenceStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // Parameters
    // ------------------------------------------------------------------
    const notificationEmail = new CfnParameter(this, 'NotificationEmail', {
      type: 'String',
      description: 'Email address that receives the weekly log intelligence summary via SNS.',
      allowedPattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      constraintDescription: 'Must be a valid email address.'
    });

    const retentionRecommendationDays = new CfnParameter(this, 'RetentionRecommendationDays', {
      type: 'Number',
      default: 30,
      description:
        'Default retention (in days) recommended for log groups with no retention policy when no ' +
        'more specific naming-pattern rule matches (e.g. /aws/lambda/*, /ecs/*, /aws/rds/*, production).',
      minValue: 1,
      maxValue: 3653
    });

    const errorSpikeThreshold = new CfnParameter(this, 'ErrorSpikeThreshold', {
      type: 'Number',
      default: 50,
      description:
        'Percentage increase in ERROR/EXCEPTION/FATAL log lines (current 24h vs. previous 24h) that ' +
        'qualifies as an "error spike" worth flagging in the report and notification.',
      minValue: 1,
      maxValue: 1000
    });

    // ------------------------------------------------------------------
    // S3 report bucket (90-day lifecycle)
    // ------------------------------------------------------------------
    const reportBucket = new s3.Bucket(this, 'ReportBucket', {
      bucketName: `log-intelligence-reports-${Aws.ACCOUNT_ID}-${Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireReportsAfter90Days',
          enabled: true,
          expiration: Duration.days(90),
          noncurrentVersionExpiration: Duration.days(90)
        }
      ]
    });

    // ------------------------------------------------------------------
    // SNS topic + email subscription
    // ------------------------------------------------------------------
    const topic = new sns.Topic(this, 'NotificationTopic', {
      topicName: 'log-intelligence-notifications',
      displayName: 'AWS Log Intelligence Notifications'
    });
    topic.addSubscription(new snsSubscriptions.EmailSubscription(notificationEmail.valueAsString));

    // ------------------------------------------------------------------
    // Lambda function
    // ------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'FunctionLogGroup', {
      logGroupName: '/aws/lambda/log-intelligence-analyzer',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const analyzerFunction = new lambda.NodejsFunction(this, 'AnalyzerFunction', {
      functionName: 'log-intelligence-analyzer',
      entry: path.join(__dirname, '..', 'lambda', 'handler.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      timeout: Duration.minutes(10),
      memorySize: 1024,
      logGroup,
      environment: {
        REPORT_BUCKET_NAME: reportBucket.bucketName,
        SNS_TOPIC_ARN: topic.topicArn,
        RETENTION_RECOMMENDATION_DAYS: retentionRecommendationDays.valueAsString,
        ERROR_SPIKE_THRESHOLD: errorSpikeThreshold.valueAsString,
        AWS_ACCOUNT_ID: Aws.ACCOUNT_ID
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*']
      },
      description: 'Weekly scan of CloudWatch Log Groups for cost optimization + problem detection.'
    });

    // ------------------------------------------------------------------
    // IAM permissions
    // ------------------------------------------------------------------
    analyzerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:Describe*',
          'logs:GetLogEvents',
          'logs:FilterLogEvents',
          'logs:ListTagsForResource',
          'logs:ListTagsLogGroup'
        ],
        resources: ['*']
      })
    );

    analyzerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetricsReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics'],
        resources: ['*']
      })
    );

    reportBucket.grantPut(analyzerFunction);
    reportBucket.grantRead(analyzerFunction);
    topic.grantPublish(analyzerFunction);

    // ------------------------------------------------------------------
    // EventBridge weekly schedule: every Monday at 08:00 UTC
    // ------------------------------------------------------------------
    const schedule = new events.Rule(this, 'WeeklySchedule', {
      ruleName: 'log-intelligence-weekly-schedule',
      description: 'Triggers the log intelligence analyzer every Monday at 08:00 UTC.',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '8',
        weekDay: 'MON',
        month: '*',
        year: '*'
      })
    });
    schedule.addTarget(
      new targets.LambdaFunction(analyzerFunction, {
        retryAttempts: 2
      })
    );

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new CfnOutput(this, 'ReportBucketName', {
      value: reportBucket.bucketName,
      description: 'S3 bucket where weekly HTML/JSON reports are stored.'
    });

    new CfnOutput(this, 'NotificationTopicArn', {
      value: topic.topicArn,
      description: 'SNS topic ARN for weekly summary notifications.'
    });

    new CfnOutput(this, 'AnalyzerFunctionName', {
      value: analyzerFunction.functionName,
      description: 'Name of the Lambda function that performs the analysis (invoke manually to test on demand).'
    });
  }
}

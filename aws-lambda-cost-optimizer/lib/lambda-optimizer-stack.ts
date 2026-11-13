import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodeLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

/**
 * LambdaCostOptimizerStack
 *
 * Deploys a self-contained, serverless cost-auditing pipeline for AWS Lambda:
 *
 *   EventBridge (weekly, Mon 08:00 UTC)
 *        |
 *        v
 *   Optimizer Lambda (512 MB / 10 min)
 *        |-- lambda:List*, lambda:GetFunction*, cloudwatch:GetMetricData (read-only)
 *        |-- Runs 5 analyzers (memory, invocation, cold-start, architecture, timeout)
 *        |-- Renders an HTML report
 *        |-- Uploads report to S3 (date-partitioned key, 90-day lifecycle)
 *        `-- Publishes a text summary to SNS -> email
 */
export class LambdaOptimizerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Parameters
    // ---------------------------------------------------------------------
    const notificationEmail = new cdk.CfnParameter(this, 'NotificationEmail', {
      type: 'String',
      description: 'Email address that receives the weekly cost-optimization summary.',
      allowedPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
      constraintDescription: 'Must be a valid email address.',
    });

    const lookbackDays = new cdk.CfnParameter(this, 'LookbackDays', {
      type: 'Number',
      default: 14,
      minValue: 1,
      maxValue: 90,
      description: 'Number of days of CloudWatch metric history to analyze for each function.',
    });

    const minInvocations = new cdk.CfnParameter(this, 'MinInvocations', {
      type: 'Number',
      default: 100,
      minValue: 0,
      description:
        'Minimum number of invocations in the lookback window required before a function ' +
        'is included in memory/cold-start/timeout analysis (avoids noisy recommendations on low-traffic functions).',
    });

    // ---------------------------------------------------------------------
    // S3 bucket for HTML reports (90-day lifecycle)
    // ---------------------------------------------------------------------
    const reportBucket = new s3.Bucket(this, 'ReportBucket', {
      bucketName: undefined, // let CloudFormation generate a unique name
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-reports-after-90-days',
          enabled: true,
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    // ---------------------------------------------------------------------
    // SNS topic for notifications
    // ---------------------------------------------------------------------
    const topic = new sns.Topic(this, 'OptimizerTopic', {
      displayName: 'Lambda Cost Optimizer',
      topicName: `${cdk.Aws.STACK_NAME}-notifications`,
    });
    topic.addSubscription(new subscriptions.EmailSubscription(notificationEmail.valueAsString));

    // ---------------------------------------------------------------------
    // Lambda execution role (least privilege, read-only against Lambda/CloudWatch)
    // ---------------------------------------------------------------------
    const optimizerRole = new iam.Role(this, 'OptimizerExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the Lambda Cost Optimizer scanner function.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    optimizerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LambdaReadOnlyDiscovery',
        effect: iam.Effect.ALLOW,
        actions: [
          'lambda:List*',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:GetFunctionConcurrency',
          'lambda:GetProvisionedConcurrencyConfig',
          'lambda:GetAccountSettings',
        ],
        resources: ['*'],
      }),
    );

    optimizerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetricsReadOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:ListMetrics',
        ],
        resources: ['*'],
      }),
    );

    // Scoped write access to just this stack's report bucket and topic.
    reportBucket.grantPut(optimizerRole);
    topic.grantPublish(optimizerRole);

    // ---------------------------------------------------------------------
    // Optimizer Lambda function
    // ---------------------------------------------------------------------
    const optimizerFunction = new nodeLambda.NodejsFunction(this, 'OptimizerFunction', {
      functionName: `${cdk.Aws.STACK_NAME}-scanner`,
      description: 'Scans all Lambda functions in the account and generates cost optimization recommendations.',
      entry: path.join(__dirname, '..', 'lambda', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(10),
      role: optimizerRole,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        REPORT_BUCKET_NAME: reportBucket.bucketName,
        SNS_TOPIC_ARN: topic.topicArn,
        LOOKBACK_DAYS: lookbackDays.valueAsString,
        MIN_INVOCATIONS: minInvocations.valueAsString,
      },
    });

    // ---------------------------------------------------------------------
    // EventBridge schedule: every Monday at 08:00 UTC
    // ---------------------------------------------------------------------
    const schedule = new events.Rule(this, 'WeeklyScanSchedule', {
      ruleName: `${cdk.Aws.STACK_NAME}-weekly-scan`,
      description: 'Triggers the Lambda Cost Optimizer every Monday at 08:00 UTC.',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '8',
        weekDay: 'MON',
        month: '*',
        year: '*',
      }),
    });
    schedule.addTarget(new targets.LambdaFunction(optimizerFunction));

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ReportBucketName', {
      value: reportBucket.bucketName,
      description: 'S3 bucket where HTML cost-optimization reports are stored.',
    });

    new cdk.CfnOutput(this, 'NotificationTopicArn', {
      value: topic.topicArn,
      description: 'SNS topic ARN that publishes the weekly summary notification.',
    });

    new cdk.CfnOutput(this, 'OptimizerFunctionName', {
      value: optimizerFunction.functionName,
      description: 'Name of the Lambda function that performs the scan (invoke manually to run on-demand).',
    });

    new cdk.CfnOutput(this, 'OptimizerFunctionArn', {
      value: optimizerFunction.functionArn,
    });
  }
}

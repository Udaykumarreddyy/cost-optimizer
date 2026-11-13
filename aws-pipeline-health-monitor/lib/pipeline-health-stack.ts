import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, CfnParameter } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export class PipelineHealthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // CloudFormation parameters
    // ------------------------------------------------------------------
    const notificationEmail = new CfnParameter(this, 'NotificationEmail', {
      type: 'String',
      description: 'Email address that receives the weekly pipeline health summary.',
      allowedPattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      constraintDescription: 'Must be a valid email address.'
    });

    const lookbackDays = new CfnParameter(this, 'LookbackDays', {
      type: 'Number',
      description: 'Number of days of pipeline/build history to analyze on each run.',
      default: 7,
      minValue: 1,
      maxValue: 90
    });

    // ------------------------------------------------------------------
    // S3 bucket for HTML reports
    // ------------------------------------------------------------------
    const reportBucket = new s3.Bucket(this, 'ReportBucket', {
      bucketName: undefined, // let CloudFormation generate a unique name
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireReportsAfter90Days',
          enabled: true,
          expiration: Duration.days(90)
        }
      ]
    });

    // ------------------------------------------------------------------
    // SNS topic for the weekly summary email
    // ------------------------------------------------------------------
    const topic = new sns.Topic(this, 'PipelineHealthTopic', {
      displayName: 'AWS Pipeline Health Monitor',
      topicName: `${this.stackName}-pipeline-health-alerts`
    });
    topic.addSubscription(new subscriptions.EmailSubscription(notificationEmail.valueAsString));

    // ------------------------------------------------------------------
    // IAM role for the Lambda function
    // ------------------------------------------------------------------
    const lambdaRole = new iam.Role(this, 'PipelineHealthLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the AWS Pipeline Health Monitor Lambda function.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CodePipelineReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['codepipeline:List*', 'codepipeline:Get*'],
        resources: ['*']
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CodeBuildReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['codebuild:List*', 'codebuild:BatchGet*'],
        resources: ['*']
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetricsReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
        resources: ['*']
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StsCallerIdentity',
        effect: iam.Effect.ALLOW,
        actions: ['sts:GetCallerIdentity'],
        resources: ['*']
      })
    );

    reportBucket.grantPut(lambdaRole);
    topic.grantPublish(lambdaRole);

    // ------------------------------------------------------------------
    // Lambda function
    // ------------------------------------------------------------------
    const healthMonitorFn = new lambda.NodejsFunction(this, 'PipelineHealthFunction', {
      functionName: `${this.stackName}-pipeline-health-monitor`,
      description: 'Weekly scan of CodePipeline/CodeBuild health; computes DORA metrics and publishes a report.',
      entry: path.join(__dirname, '..', 'lambda', 'handler.ts'),
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.minutes(10),
      role: lambdaRole,
      architecture: lambdaBase.Architecture.ARM_64,
      logRetention: cdk.aws_logs.RetentionDays.ONE_MONTH,
      environment: {
        REPORT_BUCKET_NAME: reportBucket.bucketName,
        SNS_TOPIC_ARN: topic.topicArn,
        LOOKBACK_DAYS: lookbackDays.valueAsString
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*']
      }
    });

    // ------------------------------------------------------------------
    // EventBridge rule: every Monday at 08:00 UTC
    // ------------------------------------------------------------------
    const weeklyRule = new events.Rule(this, 'WeeklyScanRule', {
      ruleName: `${this.stackName}-weekly-health-scan`,
      description: 'Triggers the pipeline health monitor every Monday at 08:00 UTC.',
      schedule: events.Schedule.expression('cron(0 8 ? * MON *)')
    });
    weeklyRule.addTarget(new targets.LambdaFunction(healthMonitorFn));

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ReportBucketName', {
      value: reportBucket.bucketName,
      description: 'S3 bucket that stores generated HTML health reports.'
    });

    new cdk.CfnOutput(this, 'LatestReportUrl', {
      value: `https://s3.console.aws.amazon.com/s3/object/${reportBucket.bucketName}?prefix=reports/latest.html`,
      description: 'Console link to the most recently generated report.'
    });

    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: topic.topicArn,
      description: 'SNS topic that publishes the weekly summary email.'
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: healthMonitorFn.functionName,
      description: 'Name of the pipeline health monitor Lambda function (for manual/on-demand invocation).'
    });
  }
}

import * as path from 'path';
import { Duration, RemovalPolicy, Stack, StackProps, CfnParameter, CfnOutput } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

export class ContainerOptimizerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // Parameters
    // ------------------------------------------------------------------
    const notificationEmail = new CfnParameter(this, 'NotificationEmail', {
      type: 'String',
      description: 'Email address to receive the weekly container optimization summary via SNS.',
      allowedPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
      constraintDescription: 'Must be a valid email address.',
    });

    const cpuUtilizationThreshold = new CfnParameter(this, 'CPUUtilizationThreshold', {
      type: 'Number',
      default: 30,
      minValue: 1,
      maxValue: 100,
      description:
        'ECS services / EKS node groups with average CPU utilization (over 7 days) below this percentage are flagged as over-provisioned / under-utilized.',
    });

    const memoryUtilizationThreshold = new CfnParameter(this, 'MemoryUtilizationThreshold', {
      type: 'Number',
      default: 30,
      minValue: 1,
      maxValue: 100,
      description:
        'ECS services with average memory utilization (over 7 days) below this percentage are flagged in findings.',
    });

    // ------------------------------------------------------------------
    // S3 report bucket (90-day lifecycle)
    // ------------------------------------------------------------------
    const reportBucket = new s3.Bucket(this, 'ReportBucket', {
      bucketName: undefined, // let CloudFormation generate a unique name
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
          noncurrentVersionExpiration: Duration.days(90),
        },
      ],
    });

    // ------------------------------------------------------------------
    // SNS topic + email subscription
    // ------------------------------------------------------------------
    const topic = new sns.Topic(this, 'ContainerOptimizerTopic', {
      displayName: 'Container Cost Optimizer Notifications',
    });
    topic.addSubscription(new subscriptions.EmailSubscription(notificationEmail.valueAsString));

    // ------------------------------------------------------------------
    // Lambda function (orchestrates all analyzers)
    // ------------------------------------------------------------------
    const analyzerFunction = new lambdaNodejs.NodejsFunction(this, 'ContainerOptimizerFunction', {
      functionName: undefined,
      description: 'Scans ECS/EKS workloads for cost optimization and reliability issues and emails a weekly report.',
      entry: path.join(__dirname, '..', 'lambda', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(10),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        // Bundle the AWS SDK v3 clients ourselves rather than relying on the
        // runtime-provided version, since the Lambda managed runtime only
        // guarantees a handful of common clients (not client-ecs/client-eks).
        externalModules: [],
      },
      environment: {
        REPORT_BUCKET_NAME: reportBucket.bucketName,
        SNS_TOPIC_ARN: topic.topicArn,
        CPU_UTILIZATION_THRESHOLD: cpuUtilizationThreshold.valueAsString,
        MEMORY_UTILIZATION_THRESHOLD: memoryUtilizationThreshold.valueAsString,
      },
    });

    reportBucket.grantWrite(analyzerFunction);
    topic.grantPublish(analyzerFunction);

    // ------------------------------------------------------------------
    // IAM: read-only discovery/describe permissions across ECS, EKS, CloudWatch
    // ------------------------------------------------------------------
    analyzerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'EcsReadOnlyDiscovery',
        effect: iam.Effect.ALLOW,
        actions: ['ecs:List*', 'ecs:Describe*'],
        resources: ['*'], // ECS list/describe APIs do not support resource-level scoping
      })
    );

    analyzerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'EksReadOnlyDiscovery',
        effect: iam.Effect.ALLOW,
        actions: ['eks:List*', 'eks:Describe*'],
        resources: ['*'], // EKS list/describe APIs do not support resource-level scoping
      })
    );

    analyzerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetrics',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
        resources: ['*'], // CloudWatch metric read APIs do not support resource-level scoping
      })
    );

    // ------------------------------------------------------------------
    // EventBridge schedule: every Monday at 08:00 UTC
    // ------------------------------------------------------------------
    const weeklySchedule = new events.Rule(this, 'WeeklyScanSchedule', {
      description: 'Triggers the container optimizer Lambda every Monday at 08:00 UTC.',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '8',
        weekDay: 'MON',
      }),
    });
    weeklySchedule.addTarget(new targets.LambdaFunction(analyzerFunction));

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new CfnOutput(this, 'ReportBucketName', {
      value: reportBucket.bucketName,
      description: 'S3 bucket where HTML optimization reports are stored.',
    });

    new CfnOutput(this, 'SnsTopicArn', {
      value: topic.topicArn,
      description: 'SNS topic that publishes weekly optimization summaries.',
    });

    new CfnOutput(this, 'AnalyzerFunctionName', {
      value: analyzerFunction.functionName,
      description: 'Name of the Lambda function that performs the scan.',
    });
  }
}

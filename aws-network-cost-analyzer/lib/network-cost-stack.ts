import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * NetworkCostStack
 *
 * Deploys a scheduled, serverless network-cost analyzer:
 *  - S3 bucket for HTML/JSON reports (90 day lifecycle expiration)
 *  - SNS topic + email subscription for weekly summaries
 *  - Lambda function that runs the 5 analyzers and builds the report
 *  - EventBridge rule firing every Monday at 08:00 UTC
 *  - Least-privilege IAM permissions scoped to read-only network/cost APIs
 */
export class NetworkCostStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Parameters
    // ---------------------------------------------------------------------
    const notificationEmail = new cdk.CfnParameter(this, 'NotificationEmail', {
      type: 'String',
      description: 'Email address that receives the weekly network cost summary.',
      allowedPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
      constraintDescription: 'Must be a valid email address.',
    });

    const lookbackDays = new cdk.CfnParameter(this, 'LookbackDays', {
      type: 'Number',
      default: 7,
      minValue: 1,
      maxValue: 90,
      description: 'Number of days to look back when pulling CloudWatch metrics and Cost Explorer data.',
    });

    // ---------------------------------------------------------------------
    // S3 report bucket
    // ---------------------------------------------------------------------
    const reportBucket = new s3.Bucket(this, 'NetworkCostReportBucket', {
      bucketName: undefined, // let CloudFormation generate a unique name
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireReportsAfter90Days',
          enabled: true,
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    // ---------------------------------------------------------------------
    // SNS topic for weekly summary notifications
    // ---------------------------------------------------------------------
    const topic = new sns.Topic(this, 'NetworkCostTopic', {
      displayName: 'AWS Network Cost Analyzer - Weekly Summary',
      topicName: 'network-cost-analyzer-notifications',
    });
    topic.addSubscription(new subscriptions.EmailSubscription(notificationEmail.valueAsString));

    // ---------------------------------------------------------------------
    // Lambda execution role (least privilege, read-only network/cost APIs)
    // ---------------------------------------------------------------------
    const lambdaRole = new iam.Role(this, 'NetworkCostAnalyzerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the AWS Network Cost Analyzer Lambda function.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EC2NetworkReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['ec2:Describe*'],
        resources: ['*'],
      }),
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ElasticLoadBalancingReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['elasticloadbalancing:Describe*'],
        resources: ['*'],
      }),
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetricsReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics'],
        resources: ['*'],
      }),
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CostExplorerReadOnly',
        effect: iam.Effect.ALLOW,
        actions: ['ce:GetCostAndUsage', 'ce:GetCostForecast', 'ce:GetDimensionValues'],
        resources: ['*'],
      }),
    );

    reportBucket.grantPut(lambdaRole);
    reportBucket.grantRead(lambdaRole);
    topic.grantPublish(lambdaRole);

    // ---------------------------------------------------------------------
    // Lambda function - orchestrates all analyzers
    // ---------------------------------------------------------------------
    const analyzerFunction = new NodejsFunction(this, 'NetworkCostAnalyzerFunction', {
      functionName: 'network-cost-analyzer',
      description: 'Scans NAT Gateways, cross-AZ transfer, VPC endpoints, idle LBs, and unused EIPs for cost savings.',
      entry: path.join(__dirname, '..', 'lambda', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: cdk.Duration.minutes(10),
      role: lambdaRole,
      architecture: lambda.Architecture.ARM_64,
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
      },
    });

    // ---------------------------------------------------------------------
    // EventBridge schedule - every Monday at 08:00 UTC
    // ---------------------------------------------------------------------
    const schedule = new events.Rule(this, 'WeeklyScheduleRule', {
      ruleName: 'network-cost-analyzer-weekly',
      description: 'Triggers the network cost analyzer every Monday at 08:00 UTC.',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '8',
        weekDay: 'MON',
      }),
    });
    schedule.addTarget(new targets.LambdaFunction(analyzerFunction));

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ReportBucketName', {
      value: reportBucket.bucketName,
      description: 'S3 bucket where HTML/JSON network cost reports are stored.',
    });

    new cdk.CfnOutput(this, 'NotificationTopicArn', {
      value: topic.topicArn,
      description: 'SNS topic ARN used for weekly summary notifications.',
    });

    new cdk.CfnOutput(this, 'AnalyzerFunctionName', {
      value: analyzerFunction.functionName,
      description: 'Lambda function that runs the network cost analysis.',
    });
  }
}

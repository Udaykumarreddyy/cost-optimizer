import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as path from "path";
import { Construct } from "constructs";

export class CostOptimizerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── PARAMETERS ───────────────────────────────────────────────
    const emailParam = new cdk.CfnParameter(this, "NotificationEmail", {
      type: "String",
      description: "Email address to receive cost optimization reports",
      default: "your-email@example.com",
    });

    const snapshotAgeDaysParam = new cdk.CfnParameter(this, "SnapshotAgeDays", {
      type: "Number",
      description: "Delete/report snapshots older than this many days",
      default: 30,
    });

    const ec2IdleCpuThresholdParam = new cdk.CfnParameter(
      this,
      "EC2IdleCpuThreshold",
      {
        type: "Number",
        description:
          "EC2 instances with average CPU below this % are flagged as idle",
        default: 5,
      }
    );

    // ─── S3 BUCKET — stores HTML reports ──────────────────────────
    const reportBucket = new s3.Bucket(this, "CostReportBucket", {
      bucketName: `cost-optimizer-reports-${cdk.Aws.ACCOUNT_ID}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90), // auto-delete reports older than 90 days
        },
      ],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ─── SNS TOPIC — sends email notifications ───────────────────
    const alertTopic = new sns.Topic(this, "CostAlertTopic", {
      displayName: "AWS Cost Optimizer Alerts",
      topicName: "cost-optimizer-alerts",
    });

    alertTopic.addSubscription(
      new snsSubs.EmailSubscription(emailParam.valueAsString)
    );

    // ─── IAM ROLE — read-only access to scan resources ───────────
    const lambdaRole = new iam.Role(this, "CostOptimizerLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Role for Cost Optimizer Lambda — read-only resource scanning",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Read-only permissions for scanning
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "EC2ReadOnly",
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:DescribeInstances",
          "ec2:DescribeVolumes",
          "ec2:DescribeAddresses",
          "ec2:DescribeSnapshots",
          "ec2:DescribeRegions",
        ],
        resources: ["*"],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchReadOnly",
        effect: iam.Effect.ALLOW,
        actions: [
          "cloudwatch:GetMetricStatistics",
          "cloudwatch:ListMetrics",
        ],
        resources: ["*"],
      })
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "S3ScanAndWrite",
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:ListAllMyBuckets",
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:GetBucketTagging",
        ],
        resources: ["*"],
      })
    );

    // Write to report bucket
    reportBucket.grantWrite(lambdaRole);

    // Publish to SNS
    alertTopic.grantPublish(lambdaRole);

    // ─── LAMBDA FUNCTION — the scanner ───────────────────────────
    const scannerFn = new lambda.Function(this, "CostScannerFunction", {
      functionName: "cost-optimizer-scanner",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda")),
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        REPORT_BUCKET: reportBucket.bucketName,
        SNS_TOPIC_ARN: alertTopic.topicArn,
        SNAPSHOT_AGE_DAYS: snapshotAgeDaysParam.valueAsString,
        EC2_IDLE_CPU_THRESHOLD: ec2IdleCpuThresholdParam.valueAsString,
      },
      description:
        "Scans AWS account for idle EC2, unused EBS, unattached EIPs, old snapshots, empty S3 buckets",
    });

    // ─── EVENTBRIDGE RULE — weekly schedule (every Monday 8 AM UTC) ─
    const weeklyRule = new events.Rule(this, "WeeklyScheduleRule", {
      ruleName: "cost-optimizer-weekly",
      description: "Triggers cost optimizer scan every Monday at 8:00 AM UTC",
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "8",
        weekDay: "MON",
      }),
    });

    weeklyRule.addTarget(new targets.LambdaFunction(scannerFn));

    // ─── OUTPUTS ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ReportBucketName", {
      value: reportBucket.bucketName,
      description: "S3 bucket where HTML cost reports are stored",
    });

    new cdk.CfnOutput(this, "SnsTopicArn", {
      value: alertTopic.topicArn,
      description: "SNS topic ARN for cost alerts",
    });

    new cdk.CfnOutput(this, "LambdaFunctionName", {
      value: scannerFn.functionName,
      description: "Lambda function that performs the scan",
    });

    new cdk.CfnOutput(this, "ScheduleRule", {
      value: weeklyRule.ruleName,
      description: "EventBridge rule name (weekly Monday schedule)",
    });
  }
}

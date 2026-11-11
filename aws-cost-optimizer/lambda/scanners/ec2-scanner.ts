/**
 * EC2 Scanner — Finds idle EC2 instances
 *
 * How it works:
 * 1. Lists all running EC2 instances in the current region
 * 2. For each instance, fetches average CPU utilization from CloudWatch (last 7 days)
 * 3. If average CPU is below the threshold (default 5%), it's flagged as "idle"
 *
 * Why this matters:
 * An idle EC2 instance costs money 24/7 even if nobody is using it.
 * A t3.medium costs ~$30/month. 10 idle instances = $300/month wasted.
 */
import {
  EC2Client,
  DescribeInstancesCommand,
  Instance,
} from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import { ScanResult, ResourceItem } from "../utils/types";

const ec2 = new EC2Client({});
const cw = new CloudWatchClient({});

// Approximate monthly cost by instance type (USD)
const INSTANCE_COST_MAP: Record<string, number> = {
  "t2.micro": 8.5,
  "t2.small": 17,
  "t2.medium": 34,
  "t3.micro": 7.5,
  "t3.small": 15,
  "t3.medium": 30,
  "t3.large": 60,
  "m5.large": 70,
  "m5.xlarge": 140,
  "m6i.large": 70,
  "m6i.xlarge": 140,
  "c5.large": 62,
  "c5.xlarge": 124,
  "r5.large": 91,
  "r5.xlarge": 182,
};

export async function scanIdleEC2Instances(): Promise<ScanResult> {
  const threshold = parseFloat(process.env.EC2_IDLE_CPU_THRESHOLD || "5");
  const items: ResourceItem[] = [];

  // Get all running instances
  const describeResult = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [{ Name: "instance-state-name", Values: ["running"] }],
    })
  );

  const instances: Instance[] = [];
  for (const reservation of describeResult.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      instances.push(instance);
    }
  }

  // Check CPU for each running instance
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const instance of instances) {
    const instanceId = instance.InstanceId!;
    const instanceType = instance.InstanceType || "unknown";

    try {
      const metrics = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: "AWS/EC2",
          MetricName: "CPUUtilization",
          Dimensions: [{ Name: "InstanceId", Value: instanceId }],
          StartTime: sevenDaysAgo,
          EndTime: now,
          Period: 86400, // 1 day
          Statistics: ["Average"],
        })
      );

      const datapoints = metrics.Datapoints || [];
      if (datapoints.length === 0) {
        // No CPU data = likely idle or just launched
        continue;
      }

      const avgCpu =
        datapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) /
        datapoints.length;

      if (avgCpu < threshold) {
        // Get instance name from tags
        const nameTag = (instance.Tags || []).find(
          (t) => t.Key === "Name"
        );

        const estimatedCost = INSTANCE_COST_MAP[instanceType] || 30;

        items.push({
          resourceId: instanceId,
          resourceType: "EC2 Instance",
          reason: `Average CPU ${avgCpu.toFixed(1)}% over 7 days (threshold: ${threshold}%)`,
          region: process.env.AWS_REGION || "us-east-1",
          estimatedMonthlyCost: estimatedCost,
          details: {
            instanceType,
            name: nameTag?.Value || "No Name",
            avgCpu: `${avgCpu.toFixed(1)}%`,
            launchTime: instance.LaunchTime?.toISOString() || "Unknown",
          },
        });
      }
    } catch (err) {
      console.warn(`Could not get metrics for ${instanceId}:`, err);
    }
  }

  return { category: "Idle EC2 Instances", items };
}

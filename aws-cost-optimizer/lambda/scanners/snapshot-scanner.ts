/**
 * Snapshot Scanner — Finds old EBS snapshots
 *
 * How it works:
 * 1. Lists all EBS snapshots owned by the current account
 * 2. Checks the creation date of each snapshot
 * 3. If the snapshot is older than the threshold (default 30 days), it's flagged
 * 4. Cost is estimated based on snapshot size ($0.05/GB/month)
 *
 * Why this matters:
 * Developers often create snapshots for backups but forget to delete them.
 * A 100GB snapshot costs $5/month. Hundreds of old snapshots add up fast.
 * Snapshots also accumulate from automated backup tools that don't clean up.
 */
import {
  EC2Client,
  DescribeSnapshotsCommand,
} from "@aws-sdk/client-ec2";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ScanResult, ResourceItem } from "../utils/types";

const ec2 = new EC2Client({});
const sts = new STSClient({});

const SNAPSHOT_COST_PER_GB = 0.05; // $0.05 per GB per month

export async function scanOldSnapshots(): Promise<ScanResult> {
  const ageDays = parseInt(process.env.SNAPSHOT_AGE_DAYS || "30", 10);
  const items: ResourceItem[] = [];

  // Get current account ID to filter only our snapshots
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ageDays);

  // Only get snapshots owned by this account (not public AWS ones)
  const result = await ec2.send(
    new DescribeSnapshotsCommand({
      OwnerIds: [accountId],
    })
  );

  for (const snapshot of result.Snapshots || []) {
    const startTime = snapshot.StartTime;
    if (!startTime) continue;

    if (startTime < cutoffDate) {
      const snapshotId = snapshot.SnapshotId!;
      const sizeGb = snapshot.VolumeSize || 0;
      const monthlyCost = sizeGb * SNAPSHOT_COST_PER_GB;
      const ageInDays = Math.floor(
        (Date.now() - startTime.getTime()) / (1000 * 60 * 60 * 24)
      );

      const nameTag = (snapshot.Tags || []).find((t) => t.Key === "Name");

      items.push({
        resourceId: snapshotId,
        resourceType: "EBS Snapshot",
        reason: `Snapshot is ${ageInDays} days old (threshold: ${ageDays} days)`,
        region: process.env.AWS_REGION || "us-east-1",
        estimatedMonthlyCost: monthlyCost,
        details: {
          sizeGb: `${sizeGb} GB`,
          name: nameTag?.Value || snapshot.Description || "No Name",
          createdAt: startTime.toISOString(),
          ageDays: `${ageInDays} days`,
          volumeId: snapshot.VolumeId || "Deleted volume",
        },
      });
    }
  }

  return { category: "Old EBS Snapshots", items };
}

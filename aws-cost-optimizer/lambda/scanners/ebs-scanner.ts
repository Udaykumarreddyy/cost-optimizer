/**
 * EBS Scanner — Finds unused (unattached) EBS volumes
 *
 * How it works:
 * 1. Lists all EBS volumes with state = "available"
 *    ("available" means the volume exists but is NOT attached to any EC2 instance)
 * 2. Each unattached volume is flagged — it's costing money for nothing
 *
 * Why this matters:
 * When you terminate an EC2 instance, the attached EBS volume may NOT be deleted
 * automatically (depends on "DeleteOnTermination" setting). These orphan volumes
 * keep costing money. A 100GB gp3 volume costs ~$8/month even if unused.
 */
import { EC2Client, DescribeVolumesCommand } from "@aws-sdk/client-ec2";
import { ScanResult, ResourceItem } from "../utils/types";

const ec2 = new EC2Client({});

// Cost per GB per month for each volume type
const VOLUME_COST_PER_GB: Record<string, number> = {
  gp2: 0.10,
  gp3: 0.08,
  io1: 0.125,
  io2: 0.125,
  st1: 0.045,
  sc1: 0.015,
  standard: 0.05,
};

export async function scanUnusedEBSVolumes(): Promise<ScanResult> {
  const items: ResourceItem[] = [];

  // "available" = not attached to any instance
  const result = await ec2.send(
    new DescribeVolumesCommand({
      Filters: [{ Name: "status", Values: ["available"] }],
    })
  );

  for (const volume of result.Volumes || []) {
    const volumeId = volume.VolumeId!;
    const sizeGb = volume.Size || 0;
    const volumeType = volume.VolumeType || "gp3";
    const costPerGb = VOLUME_COST_PER_GB[volumeType] || 0.08;
    const monthlyCost = sizeGb * costPerGb;

    const nameTag = (volume.Tags || []).find((t) => t.Key === "Name");

    items.push({
      resourceId: volumeId,
      resourceType: "EBS Volume",
      reason: `Unattached ${volumeType} volume (${sizeGb} GB) — not connected to any EC2 instance`,
      region: process.env.AWS_REGION || "us-east-1",
      estimatedMonthlyCost: monthlyCost,
      details: {
        volumeType,
        sizeGb: `${sizeGb} GB`,
        name: nameTag?.Value || "No Name",
        createdAt: volume.CreateTime?.toISOString() || "Unknown",
        state: "available (unattached)",
      },
    });
  }

  return { category: "Unused EBS Volumes", items };
}

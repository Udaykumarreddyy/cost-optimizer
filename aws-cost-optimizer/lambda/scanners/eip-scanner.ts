/**
 * EIP Scanner — Finds unattached Elastic IPs
 *
 * How it works:
 * 1. Lists all Elastic IPs in the account
 * 2. If an EIP has no AssociationId, it means it's allocated but NOT attached
 *    to any EC2 instance or network interface
 * 3. AWS charges $3.65/month ($0.005/hour) for each unattached EIP
 *
 * Why this matters:
 * EIPs are free when attached to a running instance. But if the instance is
 * stopped or terminated and the EIP is not released, AWS charges for it.
 * 10 forgotten EIPs = $36.50/month wasted.
 */
import { EC2Client, DescribeAddressesCommand } from "@aws-sdk/client-ec2";
import { ScanResult, ResourceItem } from "../utils/types";

const ec2 = new EC2Client({});

export async function scanUnattachedEIPs(): Promise<ScanResult> {
  const items: ResourceItem[] = [];

  const result = await ec2.send(new DescribeAddressesCommand({}));

  for (const address of result.Addresses || []) {
    // If AssociationId is missing, the EIP is not attached to anything
    if (!address.AssociationId) {
      const allocationId = address.AllocationId || "unknown";
      const publicIp = address.PublicIp || "unknown";

      const nameTag = (address.Tags || []).find((t) => t.Key === "Name");

      items.push({
        resourceId: allocationId,
        resourceType: "Elastic IP",
        reason: `EIP ${publicIp} is allocated but not attached to any instance`,
        region: process.env.AWS_REGION || "us-east-1",
        estimatedMonthlyCost: 3.65, // $0.005/hour × 730 hours/month
        details: {
          publicIp,
          name: nameTag?.Value || "No Name",
          domain: address.Domain || "vpc",
        },
      });
    }
  }

  return { category: "Unattached Elastic IPs", items };
}

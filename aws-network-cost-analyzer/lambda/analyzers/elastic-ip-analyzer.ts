import { EC2Client, DescribeAddressesCommand, Address } from '@aws-sdk/client-ec2';
import { ElasticIPAnalysis, SavingsRecommendation } from '../utils/types';

// Since February 1, 2024, AWS charges for ALL public IPv4 addresses,
// including Elastic IPs, whether associated with a running resource or not
// (unassociated EIPs were already billed before; the 2024 change extended
// the charge to in-use/associated public IPv4 addresses too). An EIP sitting
// unassociated is pure, 100% avoidable waste.
export const ELASTIC_IP_MONTHLY_RATE_USD = 3.6; // $0.005/hr * 24 * 30

const ec2Client = new EC2Client({});

async function listAddresses(): Promise<Address[]> {
  const response = await ec2Client.send(new DescribeAddressesCommand({}));
  return response.Addresses ?? [];
}

/**
 * Finds every Elastic IP in the account/region and flags the ones that are
 * not associated with a running instance or ENI - since the Feb 2024 pricing
 * change these cost money whether used or not, so an unassociated EIP is
 * guaranteed waste.
 */
export async function analyzeElasticIPs(): Promise<{
  analyses: ElasticIPAnalysis[];
  recommendations: SavingsRecommendation[];
}> {
  const addresses = await listAddresses();
  const analyses: ElasticIPAnalysis[] = [];
  const recommendations: SavingsRecommendation[] = [];

  for (const address of addresses) {
    const allocationId = address.AllocationId ?? address.PublicIp ?? 'unknown';
    const isAssociated = Boolean(address.AssociationId || address.InstanceId || address.NetworkInterfaceId);

    const notes: string[] = [];
    if (!isAssociated) {
      notes.push(
        `Unassociated - no instance or ENI attached. Billed ~$${ELASTIC_IP_MONTHLY_RATE_USD.toFixed(
          2,
        )}/month with zero utility.`,
      );
    } else {
      notes.push(
        `Associated with ${address.InstanceId ?? address.NetworkInterfaceId ?? 'a resource'}. Still billed ` +
          `~$${ELASTIC_IP_MONTHLY_RATE_USD.toFixed(2)}/month under the Feb 2024 public IPv4 pricing change.`,
      );
    }

    const analysis: ElasticIPAnalysis = {
      allocationId,
      publicIp: address.PublicIp ?? 'unknown',
      associationId: address.AssociationId,
      instanceId: address.InstanceId,
      networkInterfaceId: address.NetworkInterfaceId,
      isAssociated,
      estimatedMonthlyCostUsd: ELASTIC_IP_MONTHLY_RATE_USD,
      isWaste: !isAssociated,
      notes,
    };
    analyses.push(analysis);

    if (!isAssociated) {
      recommendations.push({
        id: `eip-unassociated-${allocationId}`,
        category: 'ELASTIC_IP',
        severity: 'LOW',
        title: `Unassociated Elastic IP: ${address.PublicIp}`,
        description:
          `Elastic IP ${address.PublicIp} (${allocationId}) is not attached to any instance or network interface. ` +
          `It costs ~$${ELASTIC_IP_MONTHLY_RATE_USD.toFixed(2)}/month regardless of use.`,
        resourceId: allocationId,
        estimatedMonthlySavingsUsd: ELASTIC_IP_MONTHLY_RATE_USD,
        actionItems: [
          'Release the Elastic IP if it is no longer needed.',
          'If it is reserved for a planned cutover, document the expected re-association date; otherwise release it.',
        ],
      });
    }
  }

  return { analyses, recommendations };
}

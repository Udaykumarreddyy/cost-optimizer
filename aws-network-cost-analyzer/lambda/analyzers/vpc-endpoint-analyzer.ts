import {
  EC2Client,
  DescribeVpcEndpointsCommand,
  DescribeNatGatewaysCommand,
  DescribeVpcsCommand,
  VpcEndpoint,
} from '@aws-sdk/client-ec2';
import { VpcEndpointRecommendation, SavingsRecommendation } from '../utils/types';

// Interface endpoints bill per-AZ, per-hour, plus data processing. Gateway
// endpoints (S3, DynamoDB) are free - no hourly charge, no data processing fee.
export const INTERFACE_ENDPOINT_HOURLY_RATE_USD_PER_AZ = 0.01;
// Conservative estimate of S3/DynamoDB share of NAT-processed data processing
// cost, used to size the "create a gateway endpoint" recommendation.
const ESTIMATED_S3_DYNAMODB_SHARE_OF_NAT_TRAFFIC = 0.3;
export const NAT_GATEWAY_DATA_PROCESSING_RATE_USD_PER_GB = 0.045;

const ec2Client = new EC2Client({});

async function listAllVpcIds(): Promise<string[]> {
  const vpcIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await ec2Client.send(new DescribeVpcsCommand({ NextToken: nextToken }));
    vpcIds.push(...(response.Vpcs ?? []).map((v) => v.VpcId!).filter(Boolean));
    nextToken = response.NextToken;
  } while (nextToken);
  return vpcIds;
}

async function listVpcEndpoints(): Promise<VpcEndpoint[]> {
  const endpoints: VpcEndpoint[] = [];
  let nextToken: string | undefined;
  do {
    const response = await ec2Client.send(
      new DescribeVpcEndpointsCommand({ NextToken: nextToken }),
    );
    endpoints.push(...(response.VpcEndpoints ?? []));
    nextToken = response.NextToken;
  } while (nextToken);
  return endpoints;
}

async function listNatGatewaysByVpc(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  let nextToken: string | undefined;
  do {
    const response = await ec2Client.send(
      new DescribeNatGatewaysCommand({
        NextToken: nextToken,
        Filter: [{ Name: 'state', Values: ['available', 'pending'] }],
      }),
    );
    for (const gw of response.NatGateways ?? []) {
      if (!gw.VpcId || !gw.NatGatewayId) continue;
      const list = map.get(gw.VpcId) ?? [];
      list.push(gw.NatGatewayId);
      map.set(gw.VpcId, list);
    }
    nextToken = response.NextToken;
  } while (nextToken);
  return map;
}

/**
 * For every VPC in the account/region, determines whether free Gateway VPC
 * Endpoints exist for S3/DynamoDB, inventories paid Interface Endpoints, and
 * estimates savings available by adding missing gateway endpoints.
 */
export async function analyzeVpcEndpoints(
  natTrafficGbByVpc: Map<string, number> = new Map(),
): Promise<{
  recommendationsByVpc: VpcEndpointRecommendation[];
  recommendations: SavingsRecommendation[];
}> {
  const [vpcIds, endpoints, natGatewaysByVpc] = await Promise.all([
    listAllVpcIds(),
    listVpcEndpoints(),
    listNatGatewaysByVpc(),
  ]);

  const endpointsByVpc = new Map<string, VpcEndpoint[]>();
  for (const endpoint of endpoints) {
    if (!endpoint.VpcId) continue;
    const list = endpointsByVpc.get(endpoint.VpcId) ?? [];
    list.push(endpoint);
    endpointsByVpc.set(endpoint.VpcId, list);
  }

  const recommendationsByVpc: VpcEndpointRecommendation[] = [];
  const recommendations: SavingsRecommendation[] = [];

  for (const vpcId of vpcIds) {
    const vpcEndpoints = endpointsByVpc.get(vpcId) ?? [];

    const hasS3GatewayEndpoint = vpcEndpoints.some(
      (e) => e.ServiceName?.endsWith('.s3') && e.VpcEndpointType === 'Gateway',
    );
    const hasDynamoDbGatewayEndpoint = vpcEndpoints.some(
      (e) => e.ServiceName?.endsWith('.dynamodb') && e.VpcEndpointType === 'Gateway',
    );

    const interfaceEndpoints = vpcEndpoints.filter((e) => e.VpcEndpointType === 'Interface');
    const existingInterfaceEndpoints = interfaceEndpoints.map((e) => {
      const azCount = new Set(e.SubnetIds ?? []).size || 1;
      return {
        serviceName: e.ServiceName ?? 'unknown',
        vpcEndpointId: e.VpcEndpointId ?? 'unknown',
        azCount,
        estimatedMonthlyCostUsd: azCount * INTERFACE_ENDPOINT_HOURLY_RATE_USD_PER_AZ * 24 * 30,
      };
    });

    const natGatewaysInVpc = natGatewaysByVpc.get(vpcId) ?? [];
    const natTrafficGb = natTrafficGbByVpc.get(vpcId) ?? 0;

    // Estimate how much of the NAT data-processing bill could be avoided by
    // adding gateway endpoints for the services that don't yet have one.
    let estimatedMonthlySavingsFromGatewayEndpointsUsd = 0;
    const recs: string[] = [];

    const missingGatewayEndpointCount = (hasS3GatewayEndpoint ? 0 : 1) + (hasDynamoDbGatewayEndpoint ? 0 : 1);
    if (natGatewaysInVpc.length > 0 && missingGatewayEndpointCount > 0 && natTrafficGb > 0) {
      const monthlyNatTrafficGb = (natTrafficGb / 7) * 30; // normalize weekly sample to monthly
      const estimatedS3DynamoGb = monthlyNatTrafficGb * ESTIMATED_S3_DYNAMODB_SHARE_OF_NAT_TRAFFIC;
      estimatedMonthlySavingsFromGatewayEndpointsUsd =
        estimatedS3DynamoGb * NAT_GATEWAY_DATA_PROCESSING_RATE_USD_PER_GB;
    }

    if (!hasS3GatewayEndpoint) {
      recs.push(
        `No S3 Gateway VPC Endpoint found in ${vpcId}. Add one (no hourly cost) to stop routing S3 traffic through NAT Gateways.`,
      );
    }
    if (!hasDynamoDbGatewayEndpoint) {
      recs.push(
        `No DynamoDB Gateway VPC Endpoint found in ${vpcId}. Add one (no hourly cost) to stop routing DynamoDB traffic through NAT Gateways.`,
      );
    }
    if (interfaceEndpoints.length > 0) {
      const totalInterfaceCost = existingInterfaceEndpoints.reduce(
        (acc, e) => acc + e.estimatedMonthlyCostUsd,
        0,
      );
      recs.push(
        `${interfaceEndpoints.length} Interface Endpoint(s) in ${vpcId} cost ~$${totalInterfaceCost.toFixed(2)}/month ` +
          '(billed per AZ, per hour). Confirm they are still needed; consolidate unused ones.',
      );
    }

    const recommendation: VpcEndpointRecommendation = {
      vpcId,
      hasS3GatewayEndpoint,
      hasDynamoDbGatewayEndpoint,
      existingInterfaceEndpoints,
      natGatewaysInVpc,
      estimatedMonthlySavingsFromGatewayEndpointsUsd,
      recommendations: recs,
    };
    recommendationsByVpc.push(recommendation);

    if (missingGatewayEndpointCount > 0 && natGatewaysInVpc.length > 0) {
      recommendations.push({
        id: `vpc-endpoint-missing-${vpcId}`,
        category: 'VPC_ENDPOINT',
        severity: natGatewaysInVpc.length > 0 ? 'MEDIUM' : 'LOW',
        title: `Missing free Gateway VPC Endpoint(s) in ${vpcId}`,
        description: recs.join(' '),
        resourceId: vpcId,
        estimatedMonthlySavingsUsd: estimatedMonthlySavingsFromGatewayEndpointsUsd,
        actionItems: [
          'Create a Gateway VPC Endpoint for S3 (com.amazonaws.<region>.s3) if missing - free, no hourly charge.',
          'Create a Gateway VPC Endpoint for DynamoDB (com.amazonaws.<region>.dynamodb) if missing - free, no hourly charge.',
          'Attach the endpoint to the route tables used by private subnets that currently rely on the NAT Gateway.',
          'Verify IAM/endpoint policies still scope access appropriately after the route change.',
        ],
      });
    }
  }

  return { recommendationsByVpc, recommendations };
}

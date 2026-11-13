import { EC2Client, DescribeNatGatewaysCommand, NatGateway } from '@aws-sdk/client-ec2';
import { CloudWatchClient, GetMetricDataCommand, MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { NatGatewayAnalysis, NatGatewayMetrics, SavingsRecommendation } from '../utils/types';

// Pricing (us-east-1, on-demand, as of 2024/2025 published rates). NAT Gateway
// pricing is uniform across most commercial regions; override via env if needed.
export const NAT_GATEWAY_HOURLY_RATE_USD = 0.045; // per NAT Gateway, per hour
export const NAT_GATEWAY_DATA_PROCESSING_RATE_USD_PER_GB = 0.045; // per GB processed (in + out)

// A NAT Gateway running 24/7 that moves less than this many GB over the
// lookback window is "barely using" the always-on hourly charge.
const LOW_TRAFFIC_THRESHOLD_GB = 1;

const METRIC_NAMESPACE = 'AWS/NATGateway';

const ec2Client = new EC2Client({});
const cloudWatchClient = new CloudWatchClient({});

async function listNatGateways(): Promise<NatGateway[]> {
  const gateways: NatGateway[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ec2Client.send(
      new DescribeNatGatewaysCommand({
        NextToken: nextToken,
        Filter: [{ Name: 'state', Values: ['available', 'pending'] }],
      }),
    );
    gateways.push(...(response.NatGateways ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  return gateways;
}

function buildMetricQueries(natGatewayId: string, periodSeconds: number): MetricDataQuery[] {
  const metricNames = [
    'BytesOutToDestination',
    'BytesOutToSource',
    'BytesInFromDestination',
    'BytesInFromSource',
    'ActiveConnectionCount',
    'PacketsDropCount',
  ];

  return metricNames.map((metricName, index) => ({
    Id: `m${index}`,
    Label: metricName,
    MetricStat: {
      Metric: {
        Namespace: METRIC_NAMESPACE,
        MetricName: metricName,
        Dimensions: [{ Name: 'NatGatewayId', Value: natGatewayId }],
      },
      Period: periodSeconds,
      Stat: metricName === 'ActiveConnectionCount' ? 'Average' : 'Sum',
    },
    ReturnData: true,
  }));
}

async function getNatGatewayMetrics(
  natGatewayId: string,
  startTime: Date,
  endTime: Date,
): Promise<NatGatewayMetrics> {
  // One datapoint per whole lookback window keeps the GetMetricData call cheap
  // while still giving us a total for the period.
  const periodSeconds = Math.max(
    300,
    Math.ceil((endTime.getTime() - startTime.getTime()) / 1000 / 1440) * 60,
  );

  const response = await cloudWatchClient.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: buildMetricQueries(natGatewayId, periodSeconds),
      ScanBy: 'TimestampAscending',
    }),
  );

  const sums: Record<string, number> = {
    BytesOutToDestination: 0,
    BytesOutToSource: 0,
    BytesInFromDestination: 0,
    BytesInFromSource: 0,
    ActiveConnectionCount: 0,
    PacketsDropCount: 0,
  };
  const activeConnectionSamples: number[] = [];

  for (const result of response.MetricDataResults ?? []) {
    const label = result.Label ?? '';
    const values = result.Values ?? [];
    if (label === 'ActiveConnectionCount') {
      activeConnectionSamples.push(...values);
    } else if (label in sums) {
      sums[label] = values.reduce((acc, v) => acc + v, 0);
    }
  }

  const avgActiveConnections =
    activeConnectionSamples.length > 0
      ? activeConnectionSamples.reduce((a, b) => a + b, 0) / activeConnectionSamples.length
      : 0;

  return {
    bytesOutToDestination: sums.BytesOutToDestination,
    bytesOutToSource: sums.BytesOutToSource,
    bytesInFromDestination: sums.BytesInFromDestination,
    bytesInFromSource: sums.BytesInFromSource,
    activeConnectionCount: avgActiveConnections,
    packetsDropCount: sums.PacketsDropCount,
  };
}

function bytesToGb(bytes: number): number {
  return bytes / 1024 ** 3;
}

/**
 * Analyzes every NAT Gateway in the account/region: pulls CloudWatch usage
 * metrics, computes the hourly + data-processing cost, and flags gateways
 * that are paying the always-on hourly fee while moving almost no traffic.
 */
export async function analyzeNatGateways(lookbackDays: number): Promise<{
  analyses: NatGatewayAnalysis[];
  recommendations: SavingsRecommendation[];
}> {
  const natGateways = await listNatGateways();
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const analyses: NatGatewayAnalysis[] = [];
  const recommendations: SavingsRecommendation[] = [];

  for (const gateway of natGateways) {
    const natGatewayId = gateway.NatGatewayId!;
    const metrics = await getNatGatewayMetrics(natGatewayId, startTime, endTime);

    const totalBytesProcessed =
      metrics.bytesOutToDestination +
      metrics.bytesOutToSource +
      metrics.bytesInFromDestination +
      metrics.bytesInFromSource;
    const totalGigabytesProcessed = bytesToGb(totalBytesProcessed);

    const hoursInLookback = lookbackDays * 24;
    const hourlyCostUsd = hoursInLookback * NAT_GATEWAY_HOURLY_RATE_USD;
    const dataProcessingCostUsd = totalGigabytesProcessed * NAT_GATEWAY_DATA_PROCESSING_RATE_USD_PER_GB;

    // Normalize the lookback-period cost to a full 30-day month for comparability.
    const monthlyHourlyCostUsd = 30 * 24 * NAT_GATEWAY_HOURLY_RATE_USD;
    const monthlyDataProcessingCostUsd =
      (dataProcessingCostUsd / lookbackDays) * 30 || 0;
    const estimatedMonthlyCostUsd = monthlyHourlyCostUsd + monthlyDataProcessingCostUsd;

    const isLowTraffic = totalGigabytesProcessed < LOW_TRAFFIC_THRESHOLD_GB;
    const recommendsVpcEndpoint = totalGigabytesProcessed > 5; // enough traffic to be worth checking destinations

    const notes: string[] = [];
    if (isLowTraffic) {
      notes.push(
        `Only ${totalGigabytesProcessed.toFixed(3)} GB processed in ${lookbackDays} days, but still billed ` +
          `$${monthlyHourlyCostUsd.toFixed(2)}/mo just for existing. Consider deleting this NAT Gateway.`,
      );
    }
    if (metrics.packetsDropCount > 0) {
      notes.push(`${metrics.packetsDropCount.toFixed(0)} packets dropped - check port allocation / bandwidth limits.`);
    }
    if (recommendsVpcEndpoint) {
      notes.push(
        'Significant traffic volume - verify whether S3/DynamoDB traffic is routed through this NAT Gateway. ' +
          'Gateway VPC endpoints for S3 and DynamoDB are free and bypass NAT entirely.',
      );
    }

    const analysis: NatGatewayAnalysis = {
      natGatewayId,
      vpcId: gateway.VpcId ?? 'unknown',
      subnetId: gateway.SubnetId ?? 'unknown',
      state: gateway.State ?? 'unknown',
      lookbackDays,
      metrics,
      totalGigabytesProcessed,
      hourlyCostUsd,
      dataProcessingCostUsd,
      estimatedMonthlyCostUsd,
      isLowTraffic,
      recommendsVpcEndpoint,
      notes,
    };
    analyses.push(analysis);

    if (isLowTraffic) {
      recommendations.push({
        id: `nat-low-traffic-${natGatewayId}`,
        category: 'NAT_GATEWAY',
        severity: 'MEDIUM',
        title: `NAT Gateway ${natGatewayId} is barely used`,
        description:
          `Processed only ${totalGigabytesProcessed.toFixed(3)} GB in the last ${lookbackDays} days while still ` +
          `incurring the full hourly charge of ~$${monthlyHourlyCostUsd.toFixed(2)}/month.`,
        resourceId: natGatewayId,
        estimatedMonthlySavingsUsd: monthlyHourlyCostUsd,
        actionItems: [
          'Confirm no workload still depends on this NAT Gateway for outbound internet access.',
          'Delete the NAT Gateway if the subnet no longer needs outbound internet access.',
          'If only S3/DynamoDB access is needed, replace with a free Gateway VPC Endpoint instead of a NAT Gateway.',
        ],
      });
    }

    if (recommendsVpcEndpoint) {
      recommendations.push({
        id: `nat-vpc-endpoint-${natGatewayId}`,
        category: 'NAT_GATEWAY',
        severity: 'LOW',
        title: `Review S3/DynamoDB traffic through NAT Gateway ${natGatewayId}`,
        description:
          `This NAT Gateway processed ${totalGigabytesProcessed.toFixed(2)} GB in ${lookbackDays} days ` +
          `(~$${monthlyDataProcessingCostUsd.toFixed(2)}/mo in data processing charges). If any of that is S3 or ` +
          'DynamoDB traffic, a Gateway VPC Endpoint eliminates both the NAT processing fee and the NAT hourly dependency for that traffic.',
        resourceId: natGatewayId,
        estimatedMonthlySavingsUsd: monthlyDataProcessingCostUsd * 0.5, // conservative: assume up to half is S3/DynamoDB
        actionItems: [
          'Use VPC Flow Logs or Traffic Mirroring to confirm what fraction of NAT traffic targets S3/DynamoDB.',
          'Create Gateway VPC Endpoints for S3 and DynamoDB in the affected VPC (no hourly cost).',
          'Update route tables / endpoint policies so S3 and DynamoDB traffic prefers the endpoint over the NAT Gateway.',
        ],
      });
    }
  }

  return { analyses, recommendations };
}

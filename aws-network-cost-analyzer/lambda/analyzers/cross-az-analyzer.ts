import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  Granularity,
} from '@aws-sdk/client-cost-explorer';
import { CrossAZCost, CrossAZServiceCost, SavingsRecommendation } from '../utils/types';

// Cost Explorer's "Data Transfer - Inter AZ" usage type bucket. AWS tags
// inter-AZ transfer usage types with an "AZ-" prefix / "-In"/"-Out" suffix
// depending on partition/region, so we match broadly on a few known patterns.
const CROSS_AZ_USAGE_TYPE_PATTERNS = ['DataTransfer-Regional-Bytes', 'AZ-DataTransfer'];

const costExplorerClient = new CostExplorerClient({});

function dateToIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Queries Cost Explorer for costs attributable to inter-AZ data transfer,
 * grouped by service, over the given lookback window.
 */
export async function analyzeCrossAZCosts(lookbackDays: number): Promise<{
  analysis: CrossAZCost;
  recommendations: SavingsRecommendation[];
}> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  // Cost Explorer requires at least a 1-day window and End must be strictly
  // after Start; also CE data typically lags ~24h, which is fine for a
  // weekly scheduled report.
  const response = await costExplorerClient.send(
    new GetCostAndUsageCommand({
      TimePeriod: {
        Start: dateToIsoDay(startTime),
        End: dateToIsoDay(endTime),
      },
      Granularity: Granularity.DAILY,
      Metrics: ['UnblendedCost', 'UsageQuantity'],
      Filter: {
        And: [
          {
            Dimensions: {
              Key: 'USAGE_TYPE_GROUP',
              Values: ['EC2: Data Transfer - Inter AZ'],
            },
          },
        ],
      },
      GroupBy: [
        { Type: 'DIMENSION', Key: 'SERVICE' },
        { Type: 'DIMENSION', Key: 'USAGE_TYPE' },
      ],
    }),
  ).catch(async () => {
    // USAGE_TYPE_GROUP filtering for inter-AZ transfer isn't available in
    // every account/billing configuration. Fall back to a usage-type
    // substring filter, which is broadly compatible across accounts.
    return costExplorerClient.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: dateToIsoDay(startTime),
          End: dateToIsoDay(endTime),
        },
        Granularity: Granularity.DAILY,
        Metrics: ['UnblendedCost', 'UsageQuantity'],
        Filter: {
          Dimensions: {
            Key: 'USAGE_TYPE',
            Values: CROSS_AZ_USAGE_TYPE_PATTERNS,
            MatchOptions: ['CONTAINS'],
          },
        },
        GroupBy: [
          { Type: 'DIMENSION', Key: 'SERVICE' },
          { Type: 'DIMENSION', Key: 'USAGE_TYPE' },
        ],
      }),
    );
  });

  const aggregated = new Map<string, CrossAZServiceCost>();

  for (const day of response.ResultsByTime ?? []) {
    for (const group of day.Groups ?? []) {
      const [serviceName, usageType] = group.Keys ?? ['Unknown', 'Unknown'];
      const costUsd = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? '0');
      const usageAmountGb = parseFloat(group.Metrics?.UsageQuantity?.Amount ?? '0');

      const key = `${serviceName}::${usageType}`;
      const existing = aggregated.get(key);
      if (existing) {
        existing.costUsd += costUsd;
        existing.usageAmountGb += usageAmountGb;
      } else {
        aggregated.set(key, {
          serviceName: serviceName ?? 'Unknown',
          usageType: usageType ?? 'Unknown',
          costUsd,
          usageAmountGb,
        });
      }
    }
  }

  const costByService = Array.from(aggregated.values()).sort((a, b) => b.costUsd - a.costUsd);
  const totalCrossAzCostUsd = costByService.reduce((acc, item) => acc + item.costUsd, 0);
  const topOffendingServices = costByService.slice(0, 3);

  const analysis: CrossAZCost = {
    lookbackDays,
    totalCrossAzCostUsd,
    costByService,
    topOffendingServices,
  };

  const recommendations: SavingsRecommendation[] = [];
  if (totalCrossAzCostUsd > 0) {
    const projectedMonthlyUsd = (totalCrossAzCostUsd / lookbackDays) * 30;
    recommendations.push({
      id: 'cross-az-data-transfer',
      category: 'CROSS_AZ',
      severity: projectedMonthlyUsd > 50 ? 'HIGH' : 'MEDIUM',
      title: 'Inter-AZ data transfer costs detected',
      description:
        `$${totalCrossAzCostUsd.toFixed(2)} spent on inter-AZ data transfer over the last ${lookbackDays} days ` +
        `(~$${projectedMonthlyUsd.toFixed(2)}/month projected). Top contributors: ` +
        topOffendingServices.map((s) => `${s.serviceName} ($${s.costUsd.toFixed(2)})`).join(', ') +
        '.',
      estimatedMonthlySavingsUsd: projectedMonthlyUsd * 0.6, // AZ-affinity + endpoints typically cut this 50-70%
      actionItems: [
        'Deploy latency-insensitive / non-HA workloads to a single AZ instead of spreading across AZs.',
        'Co-locate chatty services (app <-> cache, app <-> DB) in the same AZ using AZ-aware load balancing or placement.',
        'Use VPC endpoints for AWS service traffic (S3, DynamoDB, etc.) which does not incur inter-AZ transfer charges the same way NAT-routed service calls do.',
        'For Kafka/Kinesis/ECS/EKS, enable topology-aware or zone-aware routing to prefer same-AZ replicas.',
      ],
    });
  }

  return { analysis, recommendations };
}

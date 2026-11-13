import {
  EKSClient,
  ListClustersCommand,
  ListNodegroupsCommand,
  DescribeNodegroupCommand,
  ListAddonsCommand,
} from '@aws-sdk/client-eks';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { EKSNodeGroupAnalysis, MetricStat, NodeGroupInstanceInfo } from '../utils/types';

const eksClient = new EKSClient({});
const cwClient = new CloudWatchClient({});

const METRIC_LOOKBACK_DAYS = 7;
const METRIC_PERIOD_SECONDS = 3600;
const UNDER_UTILIZED_CPU_THRESHOLD = 30;
const HOURS_PER_MONTH = 730;

/**
 * Representative on-demand/spot EC2 pricing (us-east-1, Linux) for the instance
 * families most commonly used in EKS node groups. Spot prices are approximate
 * long-run averages (~65-72% discount) since real-time Spot pricing fluctuates
 * continuously per AZ.
 */
const EC2_PRICING_TABLE: Record<string, NodeGroupInstanceInfo> = {
  't3.medium': { instanceType: 't3.medium', vCpu: 2, memoryGiB: 4, onDemandHourly: 0.0416, spotHourly: 0.0125 },
  't3.large': { instanceType: 't3.large', vCpu: 2, memoryGiB: 8, onDemandHourly: 0.0832, spotHourly: 0.025 },
  't3.xlarge': { instanceType: 't3.xlarge', vCpu: 4, memoryGiB: 16, onDemandHourly: 0.1664, spotHourly: 0.05 },
  'm5.large': { instanceType: 'm5.large', vCpu: 2, memoryGiB: 8, onDemandHourly: 0.096, spotHourly: 0.0288 },
  'm5.xlarge': { instanceType: 'm5.xlarge', vCpu: 4, memoryGiB: 16, onDemandHourly: 0.192, spotHourly: 0.0576 },
  'm5.2xlarge': { instanceType: 'm5.2xlarge', vCpu: 8, memoryGiB: 32, onDemandHourly: 0.384, spotHourly: 0.1152 },
  'm5.4xlarge': { instanceType: 'm5.4xlarge', vCpu: 16, memoryGiB: 64, onDemandHourly: 0.768, spotHourly: 0.2304 },
  'm6i.large': { instanceType: 'm6i.large', vCpu: 2, memoryGiB: 8, onDemandHourly: 0.096, spotHourly: 0.029 },
  'm6i.xlarge': { instanceType: 'm6i.xlarge', vCpu: 4, memoryGiB: 16, onDemandHourly: 0.192, spotHourly: 0.058 },
  'c5.large': { instanceType: 'c5.large', vCpu: 2, memoryGiB: 4, onDemandHourly: 0.085, spotHourly: 0.0255 },
  'c5.xlarge': { instanceType: 'c5.xlarge', vCpu: 4, memoryGiB: 8, onDemandHourly: 0.17, spotHourly: 0.051 },
  'c5.2xlarge': { instanceType: 'c5.2xlarge', vCpu: 8, memoryGiB: 16, onDemandHourly: 0.34, spotHourly: 0.102 },
  'r5.large': { instanceType: 'r5.large', vCpu: 2, memoryGiB: 16, onDemandHourly: 0.126, spotHourly: 0.0378 },
  'r5.xlarge': { instanceType: 'r5.xlarge', vCpu: 4, memoryGiB: 32, onDemandHourly: 0.252, spotHourly: 0.0756 },
};

/** Ordered smallest-to-largest within a family so we can suggest "one size down". */
const DOWNSIZE_MAP: Record<string, string> = {
  'm5.4xlarge': 'm5.2xlarge',
  'm5.2xlarge': 'm5.xlarge',
  'm5.xlarge': 'm5.large',
  'm6i.xlarge': 'm6i.large',
  'c5.2xlarge': 'c5.xlarge',
  'c5.xlarge': 'c5.large',
  'r5.xlarge': 'r5.large',
  't3.xlarge': 't3.large',
  't3.large': 't3.medium',
};

function getInstancePricing(instanceType: string): NodeGroupInstanceInfo {
  return (
    EC2_PRICING_TABLE[instanceType] ?? {
      instanceType,
      vCpu: 2,
      memoryGiB: 8,
      onDemandHourly: 0.1, // conservative default for unknown/newer instance types
      spotHourly: 0.03,
    }
  );
}

async function listAllEksClusterNames(): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await eksClient.send(new ListClustersCommand({ nextToken }));
    names.push(...(resp.clusters ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);
  return names;
}

async function listAllNodegroupNames(clusterName: string): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await eksClient.send(
      new ListNodegroupsCommand({ clusterName, nextToken })
    );
    names.push(...(resp.nodegroups ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);
  return names;
}

/**
 * Fetches CPU/Memory utilization for a node group's underlying Auto Scaling Group.
 * AWS/EC2 CPUUtilization supports the AutoScalingGroupName dimension natively.
 * MemoryUtilization requires the CloudWatch agent (CWAgent namespace) and will
 * simply return null (no datapoints) if the agent isn't installed - this is
 * reported as a finding rather than treated as an error.
 */
async function getNodeGroupMetrics(
  asgName: string
): Promise<{ cpu: MetricStat | null; memory: MetricStat | null }> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - METRIC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const dimensions = [{ Name: 'AutoScalingGroupName', Value: asgName }];

  const queries: MetricDataQuery[] = [
    {
      Id: 'cpu',
      MetricStat: {
        Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: dimensions },
        Period: METRIC_PERIOD_SECONDS,
        Stat: 'Average',
      },
      ReturnData: true,
    },
    {
      Id: 'cpuMax',
      MetricStat: {
        Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: dimensions },
        Period: METRIC_PERIOD_SECONDS,
        Stat: 'Maximum',
      },
      ReturnData: true,
    },
    {
      Id: 'mem',
      MetricStat: {
        Metric: { Namespace: 'CWAgent', MetricName: 'mem_used_percent', Dimensions: dimensions },
        Period: METRIC_PERIOD_SECONDS,
        Stat: 'Average',
      },
      ReturnData: true,
    },
    {
      Id: 'memMax',
      MetricStat: {
        Metric: { Namespace: 'CWAgent', MetricName: 'mem_used_percent', Dimensions: dimensions },
        Period: METRIC_PERIOD_SECONDS,
        Stat: 'Maximum',
      },
      ReturnData: true,
    },
  ];

  const resp = await cwClient.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: queries,
      ScanBy: 'TimestampAscending',
    })
  );

  const byId = new Map(resp.MetricDataResults?.map((r) => [r.Id, r]) ?? []);
  const buildStat = (avgId: string, maxId: string): MetricStat | null => {
    const values = byId.get(avgId)?.Values ?? [];
    if (values.length === 0) return null;
    const average = values.reduce((s, v) => s + v, 0) / values.length;
    const maximum = Math.max(...(byId.get(maxId)?.Values ?? values));
    const minimum = Math.min(...values);
    return { average, maximum, minimum, datapoints: values.length };
  };

  return { cpu: buildStat('cpu', 'cpuMax'), memory: buildStat('mem', 'memMax') };
}

/**
 * Detects Karpenter via the EKS managed add-on list. Detects Cluster Autoscaler
 * heuristically via node group tags (e.g. "k8s.io/cluster-autoscaler/enabled" or
 * "k8s.io/cluster-autoscaler/<clusterName>"), which operators commonly propagate
 * onto the node group / ASG for discovery. Full certainty would require querying
 * the Kubernetes API (kube-system / karpenter namespaces), which is out of scope
 * for an IAM-only, AWS-API-based Lambda.
 */
async function detectAutoscalers(
  clusterName: string,
  nodeGroupTags: Record<string, string>
): Promise<{ hasKarpenter: boolean; hasClusterAutoscaler: boolean }> {
  let hasKarpenter = false;
  try {
    const resp = await eksClient.send(new ListAddonsCommand({ clusterName }));
    hasKarpenter = (resp.addons ?? []).some((a) => a.toLowerCase().includes('karpenter'));
  } catch (err) {
    console.error(`Failed to list addons for cluster ${clusterName}:`, err);
  }

  const tagKeys = Object.keys(nodeGroupTags).map((k) => k.toLowerCase());
  const hasClusterAutoscaler = tagKeys.some(
    (k) => k.includes('cluster-autoscaler') || k.includes('k8s.io/cluster-autoscaler')
  );

  return { hasKarpenter, hasClusterAutoscaler };
}

/**
 * Entry point: scans every EKS cluster/node group in the account+region and
 * returns per-node-group utilization, sizing, Spot eligibility, and autoscaler
 * presence, plus estimated monthly EC2 spend and potential savings.
 */
export async function analyzeEksNodeGroups(): Promise<{
  analyses: EKSNodeGroupAnalysis[];
  eksClustersScanned: number;
}> {
  const clusterNames = await listAllEksClusterNames();
  const analyses: EKSNodeGroupAnalysis[] = [];

  for (const clusterName of clusterNames) {
    const nodeGroupNames = await listAllNodegroupNames(clusterName);

    for (const nodeGroupName of nodeGroupNames) {
      const resp = await eksClient.send(
        new DescribeNodegroupCommand({ clusterName, nodegroupName: nodeGroupName })
      );
      const ng = resp.nodegroup;
      if (!ng) continue;

      const instanceTypes = ng.instanceTypes ?? ['m5.large'];
      const primaryInstanceType = instanceTypes[0];
      const capacityType = (ng.capacityType as 'ON_DEMAND' | 'SPOT') ?? 'ON_DEMAND';
      const desiredSize = ng.scalingConfig?.desiredSize ?? 0;
      const minSize = ng.scalingConfig?.minSize ?? 0;
      const maxSize = ng.scalingConfig?.maxSize ?? 0;

      const asgName = ng.resources?.autoScalingGroups?.[0]?.name;
      const metrics = asgName
        ? await getNodeGroupMetrics(asgName)
        : { cpu: null, memory: null };

      const pricing = getInstancePricing(primaryInstanceType);
      const hourlyRate = capacityType === 'SPOT' ? pricing.spotHourly : pricing.onDemandHourly;
      const estimatedMonthlyCostUsd = hourlyRate * HOURS_PER_MONTH * desiredSize;

      const isUnderUtilized =
        desiredSize > 0 && metrics.cpu !== null && metrics.cpu.average < UNDER_UTILIZED_CPU_THRESHOLD;

      const smallerInstanceRecommendation = isUnderUtilized
        ? DOWNSIZE_MAP[primaryInstanceType] ?? null
        : null;

      let potentialMonthlySavingsUsd = 0;
      const findings: string[] = [];

      if (isUnderUtilized && metrics.cpu) {
        findings.push(
          `Average CPU utilization ${metrics.cpu.average.toFixed(1)}% is below ${UNDER_UTILIZED_CPU_THRESHOLD}% - node group is under-utilized.`
        );
      }
      if (smallerInstanceRecommendation) {
        const smallerPricing = getInstancePricing(smallerInstanceRecommendation);
        const smallerHourly =
          capacityType === 'SPOT' ? smallerPricing.spotHourly : smallerPricing.onDemandHourly;
        const smallerMonthly = smallerHourly * HOURS_PER_MONTH * desiredSize;
        const downsizeSavings = Math.max(estimatedMonthlyCostUsd - smallerMonthly, 0);
        potentialMonthlySavingsUsd += downsizeSavings;
        findings.push(
          `Could downsize from ${primaryInstanceType} to ${smallerInstanceRecommendation}, saving ~$${downsizeSavings.toFixed(2)}/mo.`
        );
      }

      const spotEligible = capacityType === 'ON_DEMAND';
      if (spotEligible) {
        const spotMonthly = pricing.spotHourly * HOURS_PER_MONTH * desiredSize;
        const spotSavings = Math.max(estimatedMonthlyCostUsd - spotMonthly, 0);
        // Spot and downsizing are alternative strategies, not stacked - report the
        // larger of the two as the realistic "potential savings" ceiling.
        potentialMonthlySavingsUsd = Math.max(potentialMonthlySavingsUsd, spotSavings);
        findings.push(
          `On-Demand node group; switching non-critical workloads to Spot could save ~$${spotSavings.toFixed(2)}/mo (~${pricing.onDemandHourly > 0 ? (((pricing.onDemandHourly - pricing.spotHourly) / pricing.onDemandHourly) * 100).toFixed(0) : 0}% discount).`
        );
      }

      if (desiredSize === 0) {
        findings.push('Node group is scaled to 0 desired nodes but still provisioned (see idle resource report).');
      }

      const tags = ng.tags ?? {};
      const { hasKarpenter, hasClusterAutoscaler } = await detectAutoscalers(clusterName, tags);
      if (!hasKarpenter && !hasClusterAutoscaler && maxSize > minSize) {
        findings.push(
          'No Cluster Autoscaler or Karpenter detected despite min != max scaling config - node group may not actually scale down on low utilization.'
        );
      }

      analyses.push({
        clusterName,
        nodeGroupName,
        nodeGroupArn: ng.nodegroupArn ?? '',
        instanceTypes,
        capacityType,
        desiredSize,
        minSize,
        maxSize,
        cpuUtilization: metrics.cpu,
        memoryUtilization: metrics.memory,
        isUnderUtilized,
        smallerInstanceRecommendation,
        spotEligible,
        hasClusterAutoscaler,
        hasKarpenter,
        estimatedMonthlyCostUsd,
        potentialMonthlySavingsUsd,
        findings,
      });
    }
  }

  return { analyses, eksClustersScanned: clusterNames.length };
}

import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  Service,
} from '@aws-sdk/client-ecs';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import {
  ECSServiceAnalysis,
  MetricStat,
  ServiceLaunchType,
  FARGATE_PRICING,
} from '../utils/types';

const ecsClient = new ECSClient({});
const cwClient = new CloudWatchClient({});

const METRIC_LOOKBACK_DAYS = 7;
const METRIC_PERIOD_SECONDS = 3600; // 1 hour granularity

/**
 * Paginates through ListClusters and returns every cluster ARN in the account/region.
 */
async function listAllClusterArns(): Promise<string[]> {
  const clusterArns: string[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await ecsClient.send(
      new ListClustersCommand({ nextToken, maxResults: 100 })
    );
    clusterArns.push(...(resp.clusterArns ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);

  return clusterArns;
}

/**
 * Paginates through ListServices for a single cluster and returns every service ARN.
 */
async function listAllServiceArns(clusterArn: string): Promise<string[]> {
  const serviceArns: string[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await ecsClient.send(
      new ListServicesCommand({ cluster: clusterArn, nextToken, maxResults: 100 })
    );
    serviceArns.push(...(resp.serviceArns ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);

  return serviceArns;
}

/**
 * DescribeServices only accepts up to 10 service ARNs per call, so we chunk requests.
 */
async function describeServicesChunked(
  clusterArn: string,
  serviceArns: string[]
): Promise<Service[]> {
  const services: Service[] = [];
  const CHUNK_SIZE = 10;

  for (let i = 0; i < serviceArns.length; i += CHUNK_SIZE) {
    const chunk = serviceArns.slice(i, i + CHUNK_SIZE);
    const resp = await ecsClient.send(
      new DescribeServicesCommand({ cluster: clusterArn, services: chunk })
    );
    services.push(...(resp.services ?? []));
  }

  return services;
}

/**
 * Fetches CPUUtilization and MemoryUtilization for a service over the lookback window
 * using a single GetMetricData call (one query per metric) to minimize API calls.
 */
async function getServiceMetrics(
  clusterName: string,
  serviceName: string
): Promise<{ cpu: MetricStat | null; memory: MetricStat | null }> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - METRIC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const dimensions = [
    { Name: 'ClusterName', Value: clusterName },
    { Name: 'ServiceName', Value: serviceName },
  ];

  const queries: MetricDataQuery[] = [
    {
      Id: 'cpu',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ECS',
          MetricName: 'CPUUtilization',
          Dimensions: dimensions,
        },
        Period: METRIC_PERIOD_SECONDS,
        Stat: 'Average',
      },
      ReturnData: true,
    },
    {
      Id: 'cpuMax',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ECS',
          MetricName: 'CPUUtilization',
          Dimensions: dimensions,
        },
        Period: METRIC_PERIOD_SECONDS,
        Stat: 'Maximum',
      },
      ReturnData: true,
    },
    {
      Id: 'mem',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ECS',
          MetricName: 'MemoryUtilization',
          Dimensions: dimensions,
        },
        Period: METRIC_PERIOD_SECONDS,
        Stat: 'Average',
      },
      ReturnData: true,
    },
    {
      Id: 'memMax',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ECS',
          MetricName: 'MemoryUtilization',
          Dimensions: dimensions,
        },
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
    const avgResult = byId.get(avgId);
    const maxResult = byId.get(maxId);
    const values = avgResult?.Values ?? [];
    if (values.length === 0) {
      return null;
    }
    const average = values.reduce((sum, v) => sum + v, 0) / values.length;
    const maximum = Math.max(...(maxResult?.Values ?? values));
    const minimum = Math.min(...values);
    return { average, maximum, minimum, datapoints: values.length };
  };

  return {
    cpu: buildStat('cpu', 'cpuMax'),
    memory: buildStat('mem', 'memMax'),
  };
}

/**
 * Resolves the ECS launch type for a service, falling back to UNKNOWN for services
 * that use a capacity provider strategy without a static launchType.
 */
function resolveLaunchType(service: Service): ServiceLaunchType {
  if (service.launchType === 'FARGATE') return 'FARGATE';
  if (service.launchType === 'EC2') return 'EC2';
  if (service.launchType === 'EXTERNAL') return 'EXTERNAL';

  // Capacity-provider-based services don't set launchType; infer from strategy names.
  const providers = service.capacityProviderStrategy?.map((c) => c.capacityProvider ?? '') ?? [];
  if (providers.some((p) => p.includes('FARGATE'))) return 'FARGATE';
  if (providers.length > 0) return 'EC2';
  return 'UNKNOWN';
}

/**
 * Estimates monthly Fargate cost for a service based on its task definition's CPU/memory
 * reservation and desired task count. Returns 0 for non-Fargate services (EC2 launch type
 * costs are amortized across the cluster's EC2 instances, not billed per-task).
 */
export function estimateFargateMonthlyCost(
  cpuUnits: number,
  memoryMiB: number,
  taskCount: number
): number {
  const vCpu = cpuUnits / 1024;
  const gb = memoryMiB / 1024;
  const hourlyPerTask = vCpu * FARGATE_PRICING.vCpuPerHour + gb * FARGATE_PRICING.gbPerHour;
  const HOURS_PER_MONTH = 730;
  return hourlyPerTask * HOURS_PER_MONTH * taskCount;
}

export interface EcsServiceAnalyzerOptions {
  cpuUtilizationThreshold: number;
  memoryUtilizationThreshold: number;
}

/**
 * Looks up a task definition's reserved task-level CPU units and memory (MiB).
 * Returns null when the task definition doesn't set task-level cpu/memory (common
 * for EC2 launch type, which instead sets cpu/memory per-container) since that
 * isn't directly comparable to Fargate's per-vCPU/per-GB pricing model.
 */
async function getTaskDefCpuMemory(
  taskDefinitionArn: string
): Promise<{ cpuUnits: number; memoryMiB: number } | null> {
  if (!taskDefinitionArn) return null;
  try {
    const resp = await ecsClient.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn })
    );
    const cpuUnits = Number(resp.taskDefinition?.cpu ?? 0);
    const memoryMiB = Number(resp.taskDefinition?.memory ?? 0);
    if (!cpuUnits || !memoryMiB) return null;
    return { cpuUnits, memoryMiB };
  } catch (err) {
    console.error(`Failed to describe task definition ${taskDefinitionArn}:`, err);
    return null;
  }
}

/**
 * Entry point: scans every ECS cluster/service in the account+region and returns
 * a per-service analysis including utilization, health flags, and estimated cost.
 *
 * Also returns the raw taskDefinitionArn + desiredCount per service so the
 * task-rightsizing analyzer can reuse the same DescribeServices data without
 * a second full scan.
 */
export async function analyzeEcsServices(
  options: EcsServiceAnalyzerOptions
): Promise<{
  analyses: ECSServiceAnalysis[];
  clustersScanned: number;
  serviceLastUpdatedAt: Map<string, Date | undefined>;
}> {
  const clusterArns = await listAllClusterArns();
  const analyses: ECSServiceAnalysis[] = [];
  const serviceLastUpdatedAt = new Map<string, Date | undefined>();
  const taskDefSizingCache = new Map<string, { cpuUnits: number; memoryMiB: number } | null>();

  for (const clusterArn of clusterArns) {
    const clusterName = clusterArn.split('/').pop() ?? clusterArn;
    const serviceArns = await listAllServiceArns(clusterArn);
    if (serviceArns.length === 0) {
      continue;
    }

    const services = await describeServicesChunked(clusterArn, serviceArns);

    for (const service of services) {
      const serviceName = service.serviceName ?? 'unknown-service';
      const desiredCount = service.desiredCount ?? 0;
      const runningCount = service.runningCount ?? 0;
      const pendingCount = service.pendingCount ?? 0;
      const launchType = resolveLaunchType(service);
      const taskDefinitionArn = service.taskDefinition ?? '';

      // Use the primary deployment's updatedAt as a proxy for "last scaled" time,
      // which the idle-resource-detector uses to estimate how long a service has
      // been sitting at desiredCount=0.
      const primaryDeployment =
        service.deployments?.find((d) => d.status === 'PRIMARY') ?? service.deployments?.[0];
      serviceLastUpdatedAt.set(service.serviceArn ?? '', primaryDeployment?.updatedAt);

      const { cpu, memory } = await getServiceMetrics(clusterName, serviceName);

      const findings: string[] = [];
      const isFailing = desiredCount > 0 && runningCount === 0;
      const isZombie = desiredCount === 0;
      const isOverProvisioned =
        !isZombie && cpu !== null && cpu.average < options.cpuUtilizationThreshold;

      if (isFailing) {
        findings.push(
          `Service has ${desiredCount} desired task(s) but 0 running - deployment or capacity failure.`
        );
      }
      if (isZombie) {
        findings.push('Service exists with desiredCount=0 (zombie service, consider deleting).');
      }
      if (isOverProvisioned && cpu) {
        findings.push(
          `Average CPU utilization ${cpu.average.toFixed(1)}% is below the ${options.cpuUtilizationThreshold}% threshold - likely over-provisioned.`
        );
      }
      if (memory && memory.average < options.memoryUtilizationThreshold && !isZombie) {
        findings.push(
          `Average memory utilization ${memory.average.toFixed(1)}% is below the ${options.memoryUtilizationThreshold}% threshold.`
        );
      }
      if (cpu === null && memory === null && !isZombie) {
        findings.push('No CloudWatch metrics found in the last 7 days (service may be new or EXTERNAL launch type).');
      }

      // Cost is only directly attributable for Fargate; EC2-backed services share
      // cluster capacity that is billed per-instance (see eks/ec2 node analysis),
      // not per-task, so we report $0 "direct" Fargate cost for them here.
      let estimatedMonthlyCostUsd = 0;
      if (launchType === 'FARGATE') {
        let sizing = taskDefSizingCache.get(taskDefinitionArn);
        if (sizing === undefined) {
          sizing = await getTaskDefCpuMemory(taskDefinitionArn);
          taskDefSizingCache.set(taskDefinitionArn, sizing);
        }
        if (sizing) {
          estimatedMonthlyCostUsd = estimateFargateMonthlyCost(
            sizing.cpuUnits,
            sizing.memoryMiB,
            Math.max(runningCount, desiredCount)
          );
        }
      }

      analyses.push({
        clusterName,
        serviceName,
        serviceArn: service.serviceArn ?? '',
        launchType,
        desiredCount,
        runningCount,
        pendingCount,
        taskDefinitionArn,
        cpuUtilization: cpu,
        memoryUtilization: memory,
        isOverProvisioned,
        isFailing,
        isZombie,
        estimatedMonthlyCostUsd,
        cpuThresholdUsed: options.cpuUtilizationThreshold,
        memoryThresholdUsed: options.memoryUtilizationThreshold,
        findings,
      });
    }
  }

  return { analyses, clustersScanned: clusterArns.length, serviceLastUpdatedAt };
}

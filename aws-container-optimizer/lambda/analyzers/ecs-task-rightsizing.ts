import { ECSClient, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { ECSServiceAnalysis, TaskRightsizing, FARGATE_PRICING } from '../utils/types';

const ecsClient = new ECSClient({});

const HOURS_PER_MONTH = 730;
const HEADROOM_MULTIPLIER = 1.3; // recommend 30% headroom above observed peak usage

/**
 * Valid Fargate CPU tiers (in CPU units, 1024 = 1 vCPU) and the memory values
 * each tier supports, per the AWS Fargate task size table. Used to snap a raw
 * "observed + headroom" recommendation down to a real, deployable combination.
 */
const FARGATE_CPU_MEMORY_TABLE: { cpu: number; memoryOptions: number[] }[] = [
  { cpu: 256, memoryOptions: [512, 1024, 2048] },
  { cpu: 512, memoryOptions: [1024, 2048, 3072, 4096] },
  {
    cpu: 1024,
    memoryOptions: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
  },
  {
    cpu: 2048,
    memoryOptions: Array.from({ length: 13 }, (_, i) => 4096 + i * 1024), // 4096..16384
  },
  {
    cpu: 4096,
    memoryOptions: Array.from({ length: 23 }, (_, i) => 8192 + i * 1024), // 8192..30720
  },
  {
    cpu: 8192,
    memoryOptions: Array.from({ length: 12 }, (_, i) => 16384 + i * 4096), // 16384..61440
  },
  {
    cpu: 16384,
    memoryOptions: Array.from({ length: 12 }, (_, i) => 32768 + i * 8192), // 32768..122880
  },
];

/**
 * Snaps a raw desired CPU/memory pair to the nearest valid, deployable Fargate
 * CPU/memory combination that is >= both inputs. Never recommends below the
 * Fargate minimum (256 CPU units / 512 MiB memory).
 */
function snapToValidFargateSize(
  desiredCpuUnits: number,
  desiredMemoryMiB: number
): { cpu: number; memoryMiB: number } {
  for (const tier of FARGATE_CPU_MEMORY_TABLE) {
    if (tier.cpu < desiredCpuUnits) continue;
    const memory = tier.memoryOptions.find((m) => m >= desiredMemoryMiB);
    if (memory !== undefined) {
      return { cpu: tier.cpu, memoryMiB: memory };
    }
  }
  // Desired size exceeds the largest supported tier; cap at the max.
  const last = FARGATE_CPU_MEMORY_TABLE[FARGATE_CPU_MEMORY_TABLE.length - 1];
  return { cpu: last.cpu, memoryMiB: last.memoryOptions[last.memoryOptions.length - 1] };
}

export function calculateFargateMonthlyCost(
  cpuUnits: number,
  memoryMiB: number,
  taskCount: number
): number {
  const vCpu = cpuUnits / 1024;
  const gb = memoryMiB / 1024;
  const hourlyPerTask = vCpu * FARGATE_PRICING.vCpuPerHour + gb * FARGATE_PRICING.gbPerHour;
  return hourlyPerTask * HOURS_PER_MONTH * taskCount;
}

interface TaskDefSizing {
  cpuUnits: number;
  memoryMiB: number;
  family: string;
}

async function getTaskDefinitionSizing(taskDefinitionArn: string): Promise<TaskDefSizing | null> {
  try {
    const resp = await ecsClient.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn })
    );
    const taskDef = resp.taskDefinition;
    if (!taskDef) return null;

    const cpuUnits = Number(taskDef.cpu ?? 0);
    const memoryMiB = Number(taskDef.memory ?? 0);
    if (!cpuUnits || !memoryMiB) {
      // Task-level cpu/memory not set (common for EC2 launch type, which sets
      // cpu/memory per-container instead). Skip - not directly comparable to
      // Fargate pricing.
      return null;
    }

    return {
      cpuUnits,
      memoryMiB,
      family: taskDef.family ?? taskDefinitionArn,
    };
  } catch (err) {
    console.error(`Failed to describe task definition ${taskDefinitionArn}:`, err);
    return null;
  }
}

/**
 * For each Fargate ECS service analysis with CloudWatch utilization data, compares
 * the task definition's reserved CPU/memory against observed average utilization and
 * produces a right-sizing recommendation with current vs recommended monthly cost.
 *
 * Example: a task requests 1024 CPU units (1 vCPU) but CloudWatch shows avg CPU
 * utilization of ~20% => observed usage ~200 CPU units => with 30% headroom that's
 * ~260 units => snapped up to the next valid Fargate tier (512) => recommend 512.
 */
export async function analyzeTaskRightsizing(
  serviceAnalyses: ECSServiceAnalysis[]
): Promise<TaskRightsizing[]> {
  const results: TaskRightsizing[] = [];
  const taskDefCache = new Map<string, TaskDefSizing | null>();

  for (const service of serviceAnalyses) {
    if (service.launchType !== 'FARGATE') {
      // EC2 launch type tasks share host capacity; right-sizing there is a node group
      // utilization problem, handled by eks-nodegroup-analyzer / idle-resource-detector.
      continue;
    }
    if (service.isZombie || !service.taskDefinitionArn) {
      continue;
    }
    if (!service.cpuUtilization || !service.memoryUtilization) {
      continue; // not enough data to make a recommendation
    }

    let sizing = taskDefCache.get(service.taskDefinitionArn);
    if (sizing === undefined) {
      sizing = await getTaskDefinitionSizing(service.taskDefinitionArn);
      taskDefCache.set(service.taskDefinitionArn, sizing);
    }
    if (!sizing) continue;

    const { cpuUnits: currentCpuUnits, memoryMiB: currentMemoryMiB, family } = sizing;

    const observedAvgCpuUnits = (service.cpuUtilization.average / 100) * currentCpuUnits;
    const observedAvgMemoryMiB = (service.memoryUtilization.average / 100) * currentMemoryMiB;

    const desiredCpuUnits = Math.max(observedAvgCpuUnits * HEADROOM_MULTIPLIER, 0);
    const desiredMemoryMiB = Math.max(observedAvgMemoryMiB * HEADROOM_MULTIPLIER, 0);

    const { cpu: recommendedCpuUnits, memoryMiB: recommendedMemoryMiB } = snapToValidFargateSize(
      desiredCpuUnits,
      desiredMemoryMiB
    );

    // Only surface a recommendation if it actually reduces cost.
    if (recommendedCpuUnits >= currentCpuUnits && recommendedMemoryMiB >= currentMemoryMiB) {
      continue;
    }

    const taskCount = Math.max(service.runningCount, 1);
    const currentMonthlyCostUsd = calculateFargateMonthlyCost(
      currentCpuUnits,
      currentMemoryMiB,
      taskCount
    );
    const recommendedMonthlyCostUsd = calculateFargateMonthlyCost(
      recommendedCpuUnits,
      recommendedMemoryMiB,
      taskCount
    );
    const monthlySavingsUsd = currentMonthlyCostUsd - recommendedMonthlyCostUsd;
    const savingsPercent =
      currentMonthlyCostUsd > 0 ? (monthlySavingsUsd / currentMonthlyCostUsd) * 100 : 0;

    const cpuWastePercent =
      currentCpuUnits > 0 ? (1 - observedAvgCpuUnits / currentCpuUnits) * 100 : 0;
    const memoryWastePercent =
      currentMemoryMiB > 0 ? (1 - observedAvgMemoryMiB / currentMemoryMiB) * 100 : 0;

    results.push({
      clusterName: service.clusterName,
      serviceName: service.serviceName,
      taskDefinitionArn: service.taskDefinitionArn,
      taskDefinitionFamily: family,
      currentCpuUnits,
      currentMemoryMiB,
      observedAvgCpuUnits,
      observedAvgMemoryMiB,
      recommendedCpuUnits,
      recommendedMemoryMiB,
      desiredCount: service.desiredCount,
      currentMonthlyCostUsd,
      recommendedMonthlyCostUsd,
      monthlySavingsUsd,
      savingsPercent,
      cpuWastePercent,
      memoryWastePercent,
      rationale:
        `Task reserves ${currentCpuUnits} CPU units / ${currentMemoryMiB} MiB but ` +
        `averages ~${observedAvgCpuUnits.toFixed(0)} CPU units (${service.cpuUtilization.average.toFixed(1)}%) ` +
        `and ~${observedAvgMemoryMiB.toFixed(0)} MiB (${service.memoryUtilization.average.toFixed(1)}%) over 7 days. ` +
        `Recommending ${recommendedCpuUnits}/${recommendedMemoryMiB} with 30% headroom.`,
    });
  }

  return results;
}

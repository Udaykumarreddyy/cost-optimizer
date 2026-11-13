/**
 * Shared type definitions for the AWS Container Optimizer.
 *
 * These interfaces are produced by the analyzers in lambda/analyzers/*
 * and consumed by the report generator / SNS notifier.
 */

/** Realistic on-demand Fargate pricing (us-east-1, as of 2026). Linux/X86_64. */
export interface FargatePricing {
  vCpuPerHour: number; // $ per vCPU-hour
  gbPerHour: number; // $ per GB-hour (memory)
}

/** On-demand EC2 pricing used for EKS node group cost estimates (us-east-1). */
export interface Ec2Pricing {
  instanceType: string;
  vCpu: number;
  memoryGiB: number;
  onDemandHourly: number;
  spotHourly: number; // approximate, ~70% discount off on-demand
}

export const FARGATE_PRICING: FargatePricing = {
  vCpuPerHour: 0.04048,
  gbPerHour: 0.004445,
};

/** A generic savings line item used across analyzers for the report + SNS summary. */
export interface SavingsItem {
  resourceId: string;
  resourceType: 'ecs-service' | 'ecs-task-def' | 'eks-nodegroup' | 'ecs-cluster';
  description: string;
  monthlySavingsUsd: number;
  severity: 'low' | 'medium' | 'high';
}

export type ServiceLaunchType = 'FARGATE' | 'EC2' | 'EXTERNAL' | 'UNKNOWN';

export interface MetricStat {
  average: number;
  maximum: number;
  minimum: number;
  datapoints: number;
}

/** Result of analyzing a single ECS service (utilization + health). */
export interface ECSServiceAnalysis {
  clusterName: string;
  serviceName: string;
  serviceArn: string;
  launchType: ServiceLaunchType;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  taskDefinitionArn: string;
  cpuUtilization: MetricStat | null;
  memoryUtilization: MetricStat | null;
  isOverProvisioned: boolean;
  isFailing: boolean; // desiredCount > 0 but runningCount == 0
  isZombie: boolean; // desiredCount == 0 but service still exists
  estimatedMonthlyCostUsd: number;
  cpuThresholdUsed: number;
  memoryThresholdUsed: number;
  findings: string[];
}

/** Result of comparing a task definition's reservations to actual observed usage. */
export interface TaskRightsizing {
  clusterName: string;
  serviceName: string;
  taskDefinitionArn: string;
  taskDefinitionFamily: string;
  currentCpuUnits: number; // e.g. 1024 = 1 vCPU
  currentMemoryMiB: number;
  observedAvgCpuUnits: number;
  observedAvgMemoryMiB: number;
  recommendedCpuUnits: number;
  recommendedMemoryMiB: number;
  desiredCount: number;
  currentMonthlyCostUsd: number;
  recommendedMonthlyCostUsd: number;
  monthlySavingsUsd: number;
  savingsPercent: number;
  cpuWastePercent: number;
  memoryWastePercent: number;
  rationale: string;
}

export interface NodeGroupInstanceInfo {
  instanceType: string;
  vCpu: number;
  memoryGiB: number;
  onDemandHourly: number;
  spotHourly: number;
}

/** Result of analyzing a single EKS node group. */
export interface EKSNodeGroupAnalysis {
  clusterName: string;
  nodeGroupName: string;
  nodeGroupArn: string;
  instanceTypes: string[];
  capacityType: 'ON_DEMAND' | 'SPOT';
  desiredSize: number;
  minSize: number;
  maxSize: number;
  cpuUtilization: MetricStat | null;
  memoryUtilization: MetricStat | null;
  isUnderUtilized: boolean;
  smallerInstanceRecommendation: string | null;
  spotEligible: boolean;
  hasClusterAutoscaler: boolean;
  hasKarpenter: boolean;
  estimatedMonthlyCostUsd: number;
  potentialMonthlySavingsUsd: number;
  findings: string[];
}

export type IdleResourceType =
  | 'idle-ecs-service'
  | 'empty-ecs-cluster'
  | 'orphaned-task-definition'
  | 'scaled-to-zero-nodegroup';

/** A container resource that is idle / wasted and costing money (or clutter) for no benefit. */
export interface IdleResource {
  resourceType: IdleResourceType;
  resourceId: string;
  clusterName: string | null;
  idleSinceDays: number | null;
  wastedMonthlyCostUsd: number;
  details: string;
}

/** Top level aggregate report consumed by the HTML generator + SNS notifier. */
export interface ContainerOptReport {
  generatedAt: string;
  accountId: string;
  region: string;
  clustersScanned: number;
  servicesAnalyzed: number;
  eksClustersScanned: number;
  nodeGroupsAnalyzed: number;
  ecsServiceAnalyses: ECSServiceAnalysis[];
  taskRightsizings: TaskRightsizing[];
  eksNodeGroupAnalyses: EKSNodeGroupAnalysis[];
  idleResources: IdleResource[];
  totalEstimatedMonthlySpendUsd: number;
  totalPotentialMonthlySavingsUsd: number;
  savingsItems: SavingsItem[];
}

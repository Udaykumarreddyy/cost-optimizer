import { Context, ScheduledEvent } from 'aws-lambda';
import { analyzeEcsServices } from './analyzers/ecs-service-analyzer';
import { analyzeTaskRightsizing } from './analyzers/ecs-task-rightsizing';
import { analyzeEksNodeGroups } from './analyzers/eks-nodegroup-analyzer';
import { detectIdleResources } from './analyzers/idle-resource-detector';
import { generateHtmlReport } from './utils/report-generator';
import { uploadReport } from './utils/s3-uploader';
import { publishSummary } from './utils/sns-notifier';
import { ContainerOptReport, SavingsItem } from './utils/types';

const REPORT_BUCKET_NAME = process.env.REPORT_BUCKET_NAME ?? '';
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN ?? '';
const CPU_UTILIZATION_THRESHOLD = Number(process.env.CPU_UTILIZATION_THRESHOLD ?? '30');
const MEMORY_UTILIZATION_THRESHOLD = Number(process.env.MEMORY_UTILIZATION_THRESHOLD ?? '30');

/**
 * Parses account ID and region out of the Lambda's own invoked-function ARN
 * (arn:aws:lambda:<region>:<account-id>:function:<name>) instead of taking a
 * dependency on STS, since this data is already available for free at invoke time.
 */
function parseAccountAndRegion(invokedFunctionArn: string): { accountId: string; region: string } {
  const parts = invokedFunctionArn.split(':');
  return {
    region: parts[3] ?? process.env.AWS_REGION ?? 'us-east-1',
    accountId: parts[4] ?? 'unknown',
  };
}

function buildSavingsItems(report: Omit<ContainerOptReport, 'savingsItems' | 'totalPotentialMonthlySavingsUsd' | 'totalEstimatedMonthlySpendUsd'>): SavingsItem[] {
  const items: SavingsItem[] = [];

  for (const t of report.taskRightsizings) {
    items.push({
      resourceId: `${t.clusterName}/${t.serviceName}`,
      resourceType: 'ecs-task-def',
      description: `Right-size ${t.taskDefinitionFamily}: ${t.currentCpuUnits}/${t.currentMemoryMiB}MiB -> ${t.recommendedCpuUnits}/${t.recommendedMemoryMiB}MiB`,
      monthlySavingsUsd: t.monthlySavingsUsd,
      severity: t.savingsPercent > 50 ? 'high' : t.savingsPercent > 25 ? 'medium' : 'low',
    });
  }

  for (const ng of report.eksNodeGroupAnalyses) {
    if (ng.potentialMonthlySavingsUsd > 0) {
      items.push({
        resourceId: `${ng.clusterName}/${ng.nodeGroupName}`,
        resourceType: 'eks-nodegroup',
        description:
          ng.smallerInstanceRecommendation
            ? `Downsize to ${ng.smallerInstanceRecommendation} or move to Spot`
            : 'Move eligible workloads to Spot capacity',
        monthlySavingsUsd: ng.potentialMonthlySavingsUsd,
        severity: ng.potentialMonthlySavingsUsd > 200 ? 'high' : ng.potentialMonthlySavingsUsd > 50 ? 'medium' : 'low',
      });
    }
  }

  for (const idle of report.idleResources) {
    if (idle.wastedMonthlyCostUsd > 0) {
      items.push({
        resourceId: idle.resourceId,
        resourceType:
          idle.resourceType === 'empty-ecs-cluster' ? 'ecs-cluster' : 'ecs-service',
        description: idle.details,
        monthlySavingsUsd: idle.wastedMonthlyCostUsd,
        severity: 'medium',
      });
    }
  }

  return items.sort((a, b) => b.monthlySavingsUsd - a.monthlySavingsUsd);
}

export async function handler(_event: ScheduledEvent, context: Context): Promise<{ statusCode: number; reportKey?: string; totalSavings?: number }> {
  console.log('Starting container optimization scan...');

  if (!REPORT_BUCKET_NAME) throw new Error('REPORT_BUCKET_NAME environment variable is required');
  if (!SNS_TOPIC_ARN) throw new Error('SNS_TOPIC_ARN environment variable is required');

  const { accountId, region } = parseAccountAndRegion(context.invokedFunctionArn ?? '');

  // 1. ECS service analysis (utilization, health, Fargate cost)
  console.log('Analyzing ECS services...');
  const { analyses: ecsServiceAnalyses, clustersScanned, serviceLastUpdatedAt } =
    await analyzeEcsServices({
      cpuUtilizationThreshold: CPU_UTILIZATION_THRESHOLD,
      memoryUtilizationThreshold: MEMORY_UTILIZATION_THRESHOLD,
    });
  console.log(`Analyzed ${ecsServiceAnalyses.length} ECS service(s) across ${clustersScanned} cluster(s).`);

  // 2. Task right-sizing (reuses the CloudWatch data already fetched above)
  console.log('Computing task right-sizing recommendations...');
  const taskRightsizings = await analyzeTaskRightsizing(ecsServiceAnalyses);
  console.log(`Found ${taskRightsizings.length} right-sizing opportunity/opportunities.`);

  // 3. EKS node group analysis
  console.log('Analyzing EKS node groups...');
  const { analyses: eksNodeGroupAnalyses, eksClustersScanned } = await analyzeEksNodeGroups();
  console.log(`Analyzed ${eksNodeGroupAnalyses.length} node group(s) across ${eksClustersScanned} EKS cluster(s).`);

  // 4. Idle resource detection
  console.log('Detecting idle resources...');
  const idleResources = await detectIdleResources({
    serviceAnalyses: ecsServiceAnalyses,
    nodeGroupAnalyses: eksNodeGroupAnalyses,
    serviceLastUpdatedAt,
  });
  console.log(`Found ${idleResources.length} idle resource(s).`);

  const totalEstimatedMonthlySpendUsd =
    ecsServiceAnalyses.reduce((sum, s) => sum + s.estimatedMonthlyCostUsd, 0) +
    eksNodeGroupAnalyses.reduce((sum, n) => sum + n.estimatedMonthlyCostUsd, 0);

  const partialReport = {
    generatedAt: new Date().toISOString(),
    accountId,
    region,
    clustersScanned,
    servicesAnalyzed: ecsServiceAnalyses.length,
    eksClustersScanned,
    nodeGroupsAnalyzed: eksNodeGroupAnalyses.length,
    ecsServiceAnalyses,
    taskRightsizings,
    eksNodeGroupAnalyses,
    idleResources,
  };

  const savingsItems = buildSavingsItems(partialReport);
  const totalPotentialMonthlySavingsUsd = savingsItems.reduce((sum, i) => sum + i.monthlySavingsUsd, 0);

  const report: ContainerOptReport = {
    ...partialReport,
    totalEstimatedMonthlySpendUsd,
    totalPotentialMonthlySavingsUsd,
    savingsItems,
  };

  // 5. Generate + upload HTML report
  console.log('Generating HTML report...');
  const html = generateHtmlReport(report);
  const { key, bucket } = await uploadReport(REPORT_BUCKET_NAME, html);
  const reportS3Url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  console.log(`Report uploaded to s3://${bucket}/${key}`);

  // 6. Publish SNS summary
  console.log('Publishing SNS summary...');
  await publishSummary(SNS_TOPIC_ARN, report, reportS3Url);

  console.log(`Scan complete. Total potential monthly savings: $${totalPotentialMonthlySavingsUsd.toFixed(2)}`);

  return {
    statusCode: 200,
    reportKey: key,
    totalSavings: totalPotentialMonthlySavingsUsd,
  };
}

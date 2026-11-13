import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { ContainerOptReport } from './types';

const snsClient = new SNSClient({});

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Builds a concise plain-text summary (clusters scanned, services analyzed,
 * over-provisioned count, total potential savings) and publishes it to SNS.
 * The full HTML report lives in S3; this notification links to it.
 */
export async function publishSummary(
  topicArn: string,
  report: ContainerOptReport,
  reportS3Url: string
): Promise<void> {
  const overProvisionedCount = report.ecsServiceAnalyses.filter((s) => s.isOverProvisioned).length;
  const failingCount = report.ecsServiceAnalyses.filter((s) => s.isFailing).length;
  const zombieCount = report.ecsServiceAnalyses.filter((s) => s.isZombie).length;
  const underUtilizedNodeGroups = report.eksNodeGroupAnalyses.filter((n) => n.isUnderUtilized).length;

  const subject = `Container Optimizer: ${usd(report.totalPotentialMonthlySavingsUsd)}/mo potential savings found`;

  const lines = [
    `AWS Container Optimizer - Weekly Report`,
    `Generated: ${report.generatedAt}`,
    `Account: ${report.accountId} | Region: ${report.region}`,
    '',
    `== Scan Summary ==`,
    `ECS clusters scanned:        ${report.clustersScanned}`,
    `ECS services analyzed:       ${report.servicesAnalyzed}`,
    `EKS clusters scanned:        ${report.eksClustersScanned}`,
    `EKS node groups analyzed:    ${report.nodeGroupsAnalyzed}`,
    '',
    `== Findings ==`,
    `Over-provisioned services:   ${overProvisionedCount}`,
    `Failing services (0 running): ${failingCount}`,
    `Zombie services (0 desired): ${zombieCount}`,
    `Under-utilized EKS node groups: ${underUtilizedNodeGroups}`,
    `Task right-sizing opportunities: ${report.taskRightsizings.length}`,
    `Idle resources detected:     ${report.idleResources.length}`,
    '',
    `== Cost ==`,
    `Total estimated monthly spend:    ${usd(report.totalEstimatedMonthlySpendUsd)}`,
    `Total potential monthly savings:  ${usd(report.totalPotentialMonthlySavingsUsd)}`,
    '',
    `Full report: ${reportS3Url}`,
  ];

  await snsClient.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject.slice(0, 100), // SNS subject limit
      Message: lines.join('\n'),
    })
  );
}

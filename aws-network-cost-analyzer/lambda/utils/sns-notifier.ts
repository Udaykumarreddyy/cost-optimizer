import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { NetworkCostReport, SavingsRecommendation } from './types';

const snsClient = new SNSClient({});

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function topCostItems(report: NetworkCostReport, count: number): string[] {
  const items: { label: string; costUsd: number }[] = [];

  for (const nat of report.natGateways) {
    items.push({ label: `NAT Gateway ${nat.natGatewayId}`, costUsd: nat.estimatedMonthlyCostUsd });
  }
  if (report.crossAz.totalCrossAzCostUsd > 0) {
    const monthly = (report.crossAz.totalCrossAzCostUsd / report.crossAz.lookbackDays) * 30;
    items.push({ label: 'Cross-AZ data transfer', costUsd: monthly });
  }
  for (const lb of report.loadBalancers) {
    items.push({ label: `Load balancer ${lb.loadBalancerName}`, costUsd: lb.estimatedMonthlyCostUsd });
  }
  const eipTotal = report.elasticIps.reduce((acc, e) => acc + e.estimatedMonthlyCostUsd, 0);
  if (eipTotal > 0) {
    items.push({ label: `Elastic IPs (${report.elasticIps.length})`, costUsd: eipTotal });
  }

  return items
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, count)
    .map((item) => `  - ${item.label}: ${usd(item.costUsd)}/mo`);
}

function topSavingsItems(recommendations: SavingsRecommendation[], count: number): string[] {
  return [...recommendations]
    .sort((a, b) => b.estimatedMonthlySavingsUsd - a.estimatedMonthlySavingsUsd)
    .slice(0, count)
    .map((rec) => `  - [${rec.severity}] ${rec.title}: ${usd(rec.estimatedMonthlySavingsUsd)}/mo`);
}

/**
 * Publishes a concise summary email via SNS: total spend, top 3 cost items,
 * and total potential savings, plus a link to the full HTML report in S3.
 */
export async function publishSummaryNotification(
  topicArn: string,
  report: NetworkCostReport,
  reportUrl: string,
): Promise<void> {
  const subject = `AWS Network Cost Report: ${usd(report.totalEstimatedMonthlyNetworkSpendUsd)}/mo spend, ${usd(
    report.totalEstimatedMonthlySavingsUsd,
  )}/mo potential savings`;

  const topCosts = topCostItems(report, 3);
  const topSavings = topSavingsItems(report.recommendations, 3);

  const message = [
    'AWS NETWORK COST ANALYZER - WEEKLY SUMMARY',
    '============================================',
    '',
    `Account:        ${report.accountId}`,
    `Region:         ${report.region}`,
    `Lookback:       ${report.lookbackDays} days`,
    `Generated:      ${report.generatedAt}`,
    '',
    `TOTAL ESTIMATED MONTHLY NETWORK SPEND: ${usd(report.totalEstimatedMonthlyNetworkSpendUsd)}`,
    `TOTAL POTENTIAL MONTHLY SAVINGS:       ${usd(report.totalEstimatedMonthlySavingsUsd)}`,
    '',
    'TOP 3 COST ITEMS',
    '-----------------',
    ...(topCosts.length > 0 ? topCosts : ['  (no significant network costs detected)']),
    '',
    'TOP SAVINGS OPPORTUNITIES',
    '-------------------------',
    ...(topSavings.length > 0 ? topSavings : ['  (no recommendations this week - looking efficient!)']),
    '',
    `Full report: ${reportUrl}`,
    '',
    `${report.recommendations.length} total recommendation(s) generated this run.`,
  ].join('\n');

  await snsClient.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject.slice(0, 100), // SNS subject limit
      Message: message,
    }),
  );
}

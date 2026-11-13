import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { OptimizerReport } from './types';

/**
 * Publishes a concise plain-text summary of the scan to SNS (-> email). Keeps the email short
 * and actionable; the full breakdown (every function, every table) lives in the HTML report
 * uploaded to S3, linked from this message.
 */
export interface NotifyParams {
  snsClient: SNSClient;
  topicArn: string;
  report: OptimizerReport;
  reportS3Uri: string;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function buildSummaryMessage(report: OptimizerReport, reportS3Uri: string): string {
  const topOverProvisioned = [...report.memoryRecommendations]
    .filter((m) => m.isOverProvisioned)
    .sort((a, b) => b.estimatedMonthlySavingsUsd - a.estimatedMonthlySavingsUsd)
    .slice(0, 5);

  const deadFunctions = report.invocationAnalyses.filter((i) => i.isDeadFunction);
  const highErrorFunctions = report.invocationAnalyses.filter((i) => i.hasHighErrorRate);
  const slowColdStarts = report.coldStartAnalyses.filter((c) => c.hasSlowColdStart || c.hasFrequentColdStarts);
  const armCandidates = report.architectureRecommendations.filter((a) => a.isGravitonCompatible);
  const excessiveTimeouts = report.timeoutRecommendations.filter((t) => t.isTimeoutExcessive || t.isReliabilityRisk);

  const functionsNeedingAttention = new Set<string>([
    ...report.memoryRecommendations.filter((m) => m.isOverProvisioned).map((m) => m.functionName),
    ...deadFunctions.map((f) => f.functionName),
    ...highErrorFunctions.map((f) => f.functionName),
    ...slowColdStarts.map((f) => f.functionName),
    ...armCandidates.map((f) => f.functionName),
    ...excessiveTimeouts.map((f) => f.functionName),
  ]).size;

  const lines: string[] = [];
  lines.push('AWS Lambda Cost Optimizer - Weekly Report');
  lines.push('='.repeat(44));
  lines.push('');
  lines.push(`Account:              ${report.accountId} (${report.region})`);
  lines.push(`Scanned:              ${report.totalFunctionsScanned} Lambda functions`);
  lines.push(`Analyzed in depth:    ${report.totalFunctionsAnalyzed} (>= min invocation threshold)`);
  lines.push(`Needing attention:    ${functionsNeedingAttention}`);
  lines.push('');
  lines.push(`Estimated monthly Lambda spend:     ${formatUsd(report.totalEstimatedMonthlySpendUsd)}`);
  lines.push(`Estimated monthly savings possible: ${formatUsd(report.totalEstimatedMonthlySavingsUsd)}`);
  lines.push('');

  if (topOverProvisioned.length > 0) {
    lines.push('Top over-provisioned functions:');
    for (const m of topOverProvisioned) {
      lines.push(
        `  - ${m.functionName}: ${m.configuredMemoryMb}MB -> ${m.recommendedMemoryMb}MB ` +
          `(using ~${m.memoryUtilizationPct}%, saves ${formatUsd(m.estimatedMonthlySavingsUsd)}/mo)`,
      );
    }
    lines.push('');
  }

  if (deadFunctions.length > 0) {
    lines.push(`Dead functions (0 invocations in lookback window): ${deadFunctions.length}`);
  }
  if (highErrorFunctions.length > 0) {
    lines.push(`High error-rate functions (>5%): ${highErrorFunctions.length}`);
  }
  if (slowColdStarts.length > 0) {
    lines.push(`Cold-start hotspots: ${slowColdStarts.length}`);
  }
  if (armCandidates.length > 0) {
    const armSavings = armCandidates.reduce((acc, a) => acc + a.estimatedMonthlySavingsUsd, 0);
    lines.push(`ARM64/Graviton migration candidates: ${armCandidates.length} (saves ${formatUsd(armSavings)}/mo)`);
  }
  if (excessiveTimeouts.length > 0) {
    lines.push(`Timeout reliability risks: ${excessiveTimeouts.length}`);
  }

  lines.push('');
  lines.push(`Full report: ${reportS3Uri}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);

  return lines.join('\n');
}

export async function notify(params: NotifyParams): Promise<void> {
  const { snsClient, topicArn, report, reportS3Uri } = params;

  const message = buildSummaryMessage(report, reportS3Uri);
  const subject = `Lambda Cost Optimizer: ${formatUsd(report.totalEstimatedMonthlySavingsUsd)}/mo potential savings (${
    report.totalFunctionsScanned
  } functions scanned)`;

  await snsClient.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject.slice(0, 100), // SNS subject limit
      Message: message,
    }),
  );
}

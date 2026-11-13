import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { HealthReport } from './types';

const sns = new SNSClient({});

function formatMetricLine(name: string, value: number, unit: string, category: string): string {
  return `  - ${name}: ${value} ${unit}  [${category}]`;
}

/**
 * Build a plain-text email summary: DORA scores, top failing pipelines/
 * builds, and a link to the full HTML report in S3.
 */
export function buildSummaryMessage(report: HealthReport, reportUrl: string): string {
  const m = report.doraMetrics;

  const topFailingPipelines = [...report.pipelines]
    .filter((p) => p.failedExecutions > 0)
    .sort((a, b) => b.failedExecutions - a.failedExecutions)
    .slice(0, 5);

  const topFailingBuilds = [...report.buildProjects]
    .filter((p) => p.failedBuilds + p.timedOutBuilds > 0)
    .sort((a, b) => b.failedBuilds + b.timedOutBuilds - (a.failedBuilds + a.timedOutBuilds))
    .slice(0, 5);

  const lines: string[] = [];
  lines.push(`AWS Pipeline & Build Health Report`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Account: ${report.accountId}  Region: ${report.region}  Lookback: ${report.lookbackDays} day(s)`);
  lines.push('');
  lines.push(`OVERALL DORA PERFORMANCE: ${m.overallCategory.toUpperCase()}`);
  lines.push('');
  lines.push('DORA Metrics:');
  lines.push(formatMetricLine(m.deploymentFrequency.metricName, m.deploymentFrequency.value, m.deploymentFrequency.unit, m.deploymentFrequency.category));
  lines.push(formatMetricLine(m.leadTimeForChanges.metricName, m.leadTimeForChanges.value, m.leadTimeForChanges.unit, m.leadTimeForChanges.category));
  lines.push(formatMetricLine(m.changeFailureRate.metricName, m.changeFailureRate.value, m.changeFailureRate.unit, m.changeFailureRate.category));
  lines.push(formatMetricLine(m.meanTimeToRecovery.metricName, m.meanTimeToRecovery.value, m.meanTimeToRecovery.unit, m.meanTimeToRecovery.category));
  lines.push('');
  lines.push(`Scanned ${report.totals.pipelineCount} pipeline(s) and ${report.totals.buildProjectCount} build project(s).`);
  lines.push('');

  lines.push('Top Failing Pipelines:');
  if (topFailingPipelines.length === 0) {
    lines.push('  None - no pipeline failures this period.');
  } else {
    for (const p of topFailingPipelines) {
      lines.push(`  - ${p.pipelineName}: ${p.failedExecutions} failed / ${p.totalExecutions} total (${p.successRatePct}% success)`);
    }
  }
  lines.push('');

  lines.push('Top Failing Build Projects:');
  if (topFailingBuilds.length === 0) {
    lines.push('  None - no build failures this period.');
  } else {
    for (const p of topFailingBuilds) {
      const topPhase = p.topFailingPhases[0]?.phaseType;
      const phaseNote = topPhase ? ` (most common failing phase: ${topPhase})` : '';
      lines.push(`  - ${p.projectName}: ${p.failedBuilds} failed, ${p.timedOutBuilds} timed out${phaseNote}`);
    }
  }
  lines.push('');

  lines.push(`Full HTML report: ${reportUrl}`);

  return lines.join('\n');
}

/**
 * Publish the summary message to the SNS topic (which fans out to the
 * email subscription(s) configured on the topic).
 */
export async function sendSummaryNotification(
  topicArn: string,
  report: HealthReport,
  reportUrl: string
): Promise<void> {
  const message = buildSummaryMessage(report, reportUrl);
  const subject = `[${report.doraMetrics.overallCategory}] Pipeline Health Report - ${report.generatedAt.slice(0, 10)}`;

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject.slice(0, 100), // SNS subject hard limit
      Message: message
    })
  );
}

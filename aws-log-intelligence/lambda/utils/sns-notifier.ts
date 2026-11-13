import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { IntelligenceReport } from './types';

const snsClient = new SNSClient({});

/**
 * Publishes a plain-text summary email to the SNS topic: total estimated monthly cost,
 * top 5 most expensive log groups, count of error spikes detected, and total potential
 * monthly savings from acting on retention + ingestion recommendations.
 */
export async function sendSummaryNotification(
  topicArn: string,
  report: IntelligenceReport,
  reportUrl: string
): Promise<void> {
  const subject = buildSubject(report);
  const message = buildMessage(report, reportUrl);

  await snsClient.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject.slice(0, 100), // SNS subject hard limit
      Message: message
    })
  );
}

function buildSubject(report: IntelligenceReport): string {
  const spikeCount = report.errorSpikes.length;
  const spikeNote = spikeCount > 0 ? ` - ${spikeCount} error spike(s)` : '';
  return `[Log Intelligence] Weekly Report - $${report.costBreakdown.totalEstimatedMonthlySpend.toFixed(
    2
  )}/mo${spikeNote}`;
}

function buildMessage(report: IntelligenceReport, reportUrl: string): string {
  const top5 = report.topExpensiveGroups.slice(0, 5);
  const lines: string[] = [];

  lines.push('AWS LOG INTELLIGENCE - WEEKLY SUMMARY');
  lines.push('======================================');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Account:   ${report.accountId} (${report.region})`);
  lines.push(`Log groups scanned: ${report.totalLogGroupsScanned}`);
  lines.push('');

  lines.push('COST SUMMARY');
  lines.push('------------');
  lines.push(`Total storage cost:     $${report.costBreakdown.totalMonthlyStorageCost.toFixed(2)}/mo`);
  lines.push(`Total ingestion cost:   $${report.costBreakdown.totalMonthlyIngestionCost.toFixed(2)}/mo`);
  lines.push(`Total estimated spend:  $${report.costBreakdown.totalEstimatedMonthlySpend.toFixed(2)}/mo`);
  lines.push(`Potential savings:      $${report.costBreakdown.totalPotentialMonthlySavings.toFixed(2)}/mo`);
  lines.push('');

  lines.push('TOP 5 MOST EXPENSIVE LOG GROUPS');
  lines.push('--------------------------------');
  if (top5.length === 0) {
    lines.push('(none)');
  } else {
    top5.forEach((g, idx) => {
      const retention = g.hasNoRetention ? 'NO RETENTION SET' : `${g.retentionInDays}d retention`;
      lines.push(
        `${idx + 1}. ${g.logGroupName} - ${g.storedGB.toFixed(2)} GB - $${g.monthlyStorageCost.toFixed(
          2
        )}/mo - ${retention}`
      );
    });
  }
  lines.push('');

  lines.push('ERROR SPIKES');
  lines.push('------------');
  lines.push(`${report.errorSpikes.length} log group(s) showed a >50% increase in errors vs. the prior 24h.`);
  report.errorSpikes.slice(0, 10).forEach((spike) => {
    lines.push(
      `  - ${spike.logGroupName}: ${spike.previousPeriodErrorCount} -> ${spike.currentPeriodErrorCount} ` +
        `errors (+${spike.percentChange.toFixed(0)}%)`
    );
  });
  lines.push('');

  lines.push('RETENTION RECOMMENDATIONS');
  lines.push('--------------------------');
  lines.push(`${report.retentionRecommendations.length} log group(s) have no retention policy set.`);
  lines.push(
    `Applying recommended retention could save ~$${report.costBreakdown.totalPotentialMonthlySavings.toFixed(
      2
    )}/mo.`
  );
  lines.push('');

  lines.push('INGESTION HOTSPOTS');
  lines.push('-------------------');
  lines.push(`${report.ingestionHotspots.length} log group(s) ingest more than 1 GB/day.`);
  lines.push('');

  lines.push('FULL REPORT');
  lines.push('-----------');
  lines.push(reportUrl);

  return lines.join('\n');
}

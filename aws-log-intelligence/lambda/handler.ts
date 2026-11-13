import {
  analyzeLogGroups,
  getTopExpensiveGroups,
  buildStorageCostBreakdown,
  TOP_N_EXPENSIVE_GROUPS
} from './analyzers/log-group-analyzer';
import { detectErrors, getErrorSpikes } from './analyzers/error-detector';
import { analyzeIngestion, getIngestionHotspots, buildIngestionCostBreakdown } from './analyzers/ingestion-analyzer';
import { recommendRetention, totalRetentionSavings } from './analyzers/retention-advisor';
import { generateHtmlReport } from './utils/report-generator';
import { uploadReport, uploadJsonReport } from './utils/s3-uploader';
import { sendSummaryNotification } from './utils/sns-notifier';
import { CostBreakdown, IntelligenceReport } from './utils/types';

/** Environment variables injected by the CDK stack (see lib/log-intelligence-stack.ts). */
const REPORT_BUCKET_NAME = process.env.REPORT_BUCKET_NAME ?? '';
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN ?? '';
const RETENTION_RECOMMENDATION_DAYS = parseInt(process.env.RETENTION_RECOMMENDATION_DAYS ?? '30', 10);
const ERROR_SPIKE_THRESHOLD = parseInt(process.env.ERROR_SPIKE_THRESHOLD ?? '50', 10);
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT ?? 'unknown';
const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';

export interface HandlerResult {
  statusCode: number;
  body: string;
}

/**
 * Lambda entry point. Triggered weekly by EventBridge (Mondays, 08:00 UTC).
 *
 * Orchestration order:
 *   1. log-group-analyzer: list every log group + storage cost + retention flags
 *   2. error-detector:     scan the top N most expensive groups for ERROR/EXCEPTION/FATAL spikes
 *   3. ingestion-analyzer: pull CloudWatch metrics to find high-ingestion-rate groups
 *   4. retention-advisor:  recommend retention policies for groups with none set
 *   5. report-generator:   render everything into one HTML report
 *   6. s3-uploader:        persist the HTML (+ JSON) report under a date-partitioned key
 *   7. sns-notifier:       email a cost/risk summary with a link to the full report
 */
export async function handler(): Promise<HandlerResult> {
  const startedAt = Date.now();
  console.log('aws-log-intelligence: starting weekly scan');

  if (!REPORT_BUCKET_NAME || !SNS_TOPIC_ARN) {
    throw new Error('Missing required environment variables: REPORT_BUCKET_NAME and/or SNS_TOPIC_ARN');
  }

  // 1. Inventory every log group and its storage cost / retention status.
  const logGroupAnalyses = await analyzeLogGroups();
  console.log(`aws-log-intelligence: scanned ${logGroupAnalyses.length} log groups`);

  const topExpensiveGroups = getTopExpensiveGroups(logGroupAnalyses, TOP_N_EXPENSIVE_GROUPS);
  const storageCosts = buildStorageCostBreakdown(logGroupAnalyses);

  // 2. Scan only the top N most expensive groups for error spikes (keeps FilterLogEvents
  //    volume bounded on accounts with hundreds/thousands of log groups).
  const errorDetections = await detectErrors(topExpensiveGroups, ERROR_SPIKE_THRESHOLD);
  const errorSpikes = getErrorSpikes(errorDetections);
  console.log(`aws-log-intelligence: ${errorSpikes.length} error spike(s) detected`);

  // 3. Pull 7-day ingestion metrics for the same top N groups (the groups most likely to
  //    matter cost-wise) and flag high-ingestion-rate groups.
  const ingestionAnalyses = await analyzeIngestion(topExpensiveGroups);
  const ingestionHotspots = getIngestionHotspots(ingestionAnalyses);
  const ingestionCosts = buildIngestionCostBreakdown(ingestionAnalyses);
  console.log(`aws-log-intelligence: ${ingestionHotspots.length} ingestion hotspot(s) detected`);

  // 4. Recommend retention policies for every group lacking one (not just the top N — a
  //    small, forgotten log group left at "Never expire" for years can still be costly).
  const retentionRecommendations = recommendRetention(logGroupAnalyses, RETENTION_RECOMMENDATION_DAYS);
  const retentionSavings = totalRetentionSavings(retentionRecommendations);
  console.log(`aws-log-intelligence: ${retentionRecommendations.length} retention recommendation(s)`);

  const costBreakdown: CostBreakdown = {
    totalStorageGB: storageCosts.totalStorageGB,
    totalMonthlyStorageCost: storageCosts.totalMonthlyStorageCost,
    totalDailyIngestionGB: ingestionCosts.totalDailyIngestionGB,
    totalMonthlyIngestionCost: ingestionCosts.totalMonthlyIngestionCost,
    totalEstimatedMonthlySpend: storageCosts.totalMonthlyStorageCost + ingestionCosts.totalMonthlyIngestionCost,
    totalPotentialMonthlySavings: retentionSavings
  };

  const report: IntelligenceReport = {
    generatedAt: new Date().toISOString(),
    accountId: AWS_ACCOUNT_ID,
    region: AWS_REGION,
    totalLogGroupsScanned: logGroupAnalyses.length,
    costBreakdown,
    topExpensiveGroups,
    errorDetections,
    errorSpikes,
    ingestionAnalyses,
    ingestionHotspots,
    retentionRecommendations
  };

  // 5. Render the HTML report.
  const html = generateHtmlReport(report);

  // 6. Upload HTML + JSON to S3 under a date-partitioned key.
  const generatedAt = new Date(report.generatedAt);
  const { s3Uri } = await uploadReport(REPORT_BUCKET_NAME, html, generatedAt);
  await uploadJsonReport(REPORT_BUCKET_NAME, JSON.stringify(report, null, 2), generatedAt);
  console.log(`aws-log-intelligence: report uploaded to ${s3Uri}`);

  // 7. Notify via SNS with a cost/risk summary and a link to the full report.
  await sendSummaryNotification(SNS_TOPIC_ARN, report, s3Uri);
  console.log('aws-log-intelligence: notification sent');

  const durationMs = Date.now() - startedAt;
  console.log(`aws-log-intelligence: completed in ${durationMs}ms`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Log intelligence scan completed',
      reportUri: s3Uri,
      logGroupsScanned: logGroupAnalyses.length,
      errorSpikes: errorSpikes.length,
      retentionRecommendations: retentionRecommendations.length,
      totalEstimatedMonthlySpend: costBreakdown.totalEstimatedMonthlySpend,
      totalPotentialMonthlySavings: costBreakdown.totalPotentialMonthlySavings,
      durationMs
    })
  };
}

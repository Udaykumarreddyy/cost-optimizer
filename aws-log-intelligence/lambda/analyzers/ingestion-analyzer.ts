import {
  CloudWatchClient,
  GetMetricDataCommand,
  GetMetricDataCommandOutput,
  MetricDataQuery,
  MetricDataResult
} from '@aws-sdk/client-cloudwatch';
import { LogGroupAnalysis, IngestionAnalysis } from '../utils/types';

// CloudWatch Logs ingestion pricing (us-east-1, as of this writing): $0.50 / GB ingested.
// See https://aws.amazon.com/cloudwatch/pricing/ — adjust INGESTION_COST_PER_GB if your region/tier differs.
export const INGESTION_COST_PER_GB = 0.5;
export const HIGH_INGESTION_THRESHOLD_GB_PER_DAY = 1;
const ANALYSIS_WINDOW_DAYS = 7;
const SECONDS_PER_DAY = 86_400;
const BYTES_PER_GB = 1024 * 1024 * 1024;
const METRIC_BATCH_SIZE = 500; // GetMetricData allows up to 500 queries per call

const cwClient = new CloudWatchClient({});

/**
 * Pulls AWS/Logs IncomingBytes + IncomingLogEvents for each log group over the trailing 7 days
 * using CloudWatch GetMetricData (one Sum-per-day datapoint), then derives average/peak daily
 * ingestion and the estimated monthly ingestion cost.
 */
export async function analyzeIngestion(
  logGroups: LogGroupAnalysis[],
  now: Date = new Date()
): Promise<IngestionAnalysis[]> {
  if (logGroups.length === 0) {
    return [];
  }

  const endTime = now;
  const startTime = new Date(now.getTime() - ANALYSIS_WINDOW_DAYS * SECONDS_PER_DAY * 1000);

  // Build two MetricDataQuery entries (bytes + events) per log group, batched to respect the API limit.
  const queries: MetricDataQuery[] = [];
  logGroups.forEach((group, idx) => {
    queries.push(buildQuery(idx, 'bytes', 'IncomingBytes', group.logGroupName));
    queries.push(buildQuery(idx, 'events', 'IncomingLogEvents', group.logGroupName));
  });

  const resultsById = new Map<string, MetricDataResult>();
  for (let i = 0; i < queries.length; i += METRIC_BATCH_SIZE) {
    const batch = queries.slice(i, i + METRIC_BATCH_SIZE);
    let nextToken: string | undefined;
    do {
      const response: GetMetricDataCommandOutput = await cwClient.send(
        new GetMetricDataCommand({
          MetricDataQueries: batch,
          StartTime: startTime,
          EndTime: endTime,
          NextToken: nextToken
        })
      );
      for (const result of response.MetricDataResults ?? []) {
        if (result.Id) {
          resultsById.set(result.Id, result);
        }
      }
      nextToken = response.NextToken;
    } while (nextToken);
  }

  const analyses: IngestionAnalysis[] = logGroups.map((group, idx) => {
    const bytesResult = resultsById.get(`bytes_${idx}`);
    const eventsResult = resultsById.get(`events_${idx}`);

    const dailyBytes = bytesResult?.Values ?? [];
    const totalIncomingBytes = dailyBytes.reduce((sum, v) => sum + v, 0);
    const totalIncomingEvents = (eventsResult?.Values ?? []).reduce((sum, v) => sum + v, 0);

    const dailyGB = dailyBytes.map((bytes) => bytes / BYTES_PER_GB);
    const daysWithData = Math.max(dailyGB.length, 1);
    const avgDailyIngestionGB = dailyGB.reduce((s, v) => s + v, 0) / daysWithData;
    const peakDailyIngestionGB = dailyGB.length > 0 ? Math.max(...dailyGB) : 0;
    const isHighVolume = avgDailyIngestionGB > HIGH_INGESTION_THRESHOLD_GB_PER_DAY;
    const estimatedMonthlyIngestionCost = avgDailyIngestionGB * 30 * INGESTION_COST_PER_GB;

    return {
      logGroupName: group.logGroupName,
      totalIncomingBytes,
      totalIncomingEvents,
      avgDailyIngestionGB,
      peakDailyIngestionGB,
      isHighVolume,
      estimatedMonthlyIngestionCost,
      recommendation: isHighVolume ? buildRecommendation(group.logGroupName, avgDailyIngestionGB) : undefined
    };
  });

  return analyses;
}

function buildQuery(idx: number, kind: 'bytes' | 'events', metricName: string, logGroupName: string): MetricDataQuery {
  return {
    Id: `${kind}_${idx}`,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/Logs',
        MetricName: metricName,
        Dimensions: [{ Name: 'LogGroupName', Value: logGroupName }]
      },
      Period: SECONDS_PER_DAY,
      Stat: 'Sum'
    },
    ReturnData: true
  };
}

function buildRecommendation(logGroupName: string, avgDailyIngestionGB: number): string {
  return (
    `"${logGroupName}" is ingesting ~${avgDailyIngestionGB.toFixed(2)} GB/day. ` +
    `Consider raising the application log level (e.g. DEBUG -> INFO/WARN), sampling noisy/high-cardinality ` +
    `log lines, batching or compressing before export, or routing verbose diagnostic logs to a cheaper ` +
    `destination (S3 via Firehose) instead of CloudWatch Logs.`
  );
}

/** Returns log groups whose average daily ingestion exceeds the high-volume threshold, sorted descending. */
export function getIngestionHotspots(analyses: IngestionAnalysis[]): IngestionAnalysis[] {
  return analyses
    .filter((a) => a.isHighVolume)
    .sort((a, b) => b.avgDailyIngestionGB - a.avgDailyIngestionGB);
}

/** Rolls up total average daily ingestion GB / estimated monthly ingestion cost. */
export function buildIngestionCostBreakdown(analyses: IngestionAnalysis[]): {
  totalDailyIngestionGB: number;
  totalMonthlyIngestionCost: number;
} {
  const totalDailyIngestionGB = analyses.reduce((sum, a) => sum + a.avgDailyIngestionGB, 0);
  const totalMonthlyIngestionCost = analyses.reduce((sum, a) => sum + a.estimatedMonthlyIngestionCost, 0);
  return { totalDailyIngestionGB, totalMonthlyIngestionCost };
}

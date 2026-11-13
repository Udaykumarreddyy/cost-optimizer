import { CloudWatchClient, GetMetricDataCommand, MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { LambdaFunctionProfile, InvocationAnalysis } from '../utils/types';

/**
 * Invocation Analyzer
 * -------------------
 * Pulls the four core CloudWatch/Lambda metrics - Invocations, Errors, Throttles, Duration -
 * for every function over the lookback window and derives:
 *   - error rate %  (Errors / Invocations)
 *   - throttle rate % (Throttles / (Invocations + Throttles))
 *   - average + p99 duration (ms)
 *
 * Flags:
 *   - hasHighErrorRate: errorRatePct > 5%
 *   - isDeadFunction: invocationCount === 0 for the entire lookback window (still costing
 *     for code storage above the free 75 GB-month tier, plus it's dead-weight operational risk)
 *   - isHighlyThrottled: throttleRatePct > 1% (any sustained throttling indicates
 *     reserved-concurrency or account-concurrency limits are too tight)
 */

const HIGH_ERROR_RATE_THRESHOLD_PCT = 5;
const HIGH_THROTTLE_RATE_THRESHOLD_PCT = 1;

export interface InvocationAnalyzerOptions {
  cloudWatchClient: CloudWatchClient;
  lookbackDays: number;
  /** $ per GB-month for Lambda code/layer storage above the free tier, used for dead-function cost estimate. */
  storagePricePerGbMonthUsd?: number;
}

export interface InvocationMetricsResult {
  analyses: InvocationAnalysis[];
  /** Exposed so other analyzers (memory, timeout) can reuse the same CloudWatch calls without re-querying. */
  monthlyInvocationsByFunction: Map<string, number>;
  averageDurationMsByFunction: Map<string, number>;
  maxDurationMsByFunction: Map<string, number>;
}

function buildQueries(functionName: string, period: number): MetricDataQuery[] {
  const dims = [{ Name: 'FunctionName', Value: functionName }];
  return [
    {
      Id: 'invocations',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: dims },
        Period: period,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
    {
      Id: 'errors',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: dims },
        Period: period,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
    {
      Id: 'throttles',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Throttles', Dimensions: dims },
        Period: period,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
    {
      Id: 'durationAvg',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: dims },
        Period: period,
        Stat: 'Average',
      },
      ReturnData: true,
    },
    {
      Id: 'durationMax',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: dims },
        Period: period,
        Stat: 'Maximum',
      },
      ReturnData: true,
    },
    {
      Id: 'durationP99',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: dims },
        Period: period,
        Stat: 'p99',
      },
      ReturnData: true,
    },
  ];
}

function sum(values: number[] | undefined): number {
  return (values ?? []).reduce((acc, v) => acc + v, 0);
}

function avg(values: number[] | undefined): number {
  const v = values ?? [];
  if (v.length === 0) return 0;
  return v.reduce((acc, x) => acc + x, 0) / v.length;
}

function max(values: number[] | undefined): number {
  const v = values ?? [];
  if (v.length === 0) return 0;
  return Math.max(...v);
}

export async function analyzeInvocations(
  functions: LambdaFunctionProfile[],
  options: InvocationAnalyzerOptions,
): Promise<InvocationMetricsResult> {
  const { cloudWatchClient, lookbackDays, storagePricePerGbMonthUsd = 0.023 } = options;
  return runAnalysis(functions, cloudWatchClient, lookbackDays, storagePricePerGbMonthUsd);
}

async function runAnalysis(
  functions: LambdaFunctionProfile[],
  cloudWatchClient: CloudWatchClient,
  lookbackDays: number,
  storagePricePerGbMonthUsd: number,
): Promise<InvocationMetricsResult> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  // Use a single period covering the whole window so Sum/Average/Maximum collapse to one datapoint.
  const periodSeconds = Math.max(3600, lookbackDays * 24 * 60 * 60);

  const analyses: InvocationAnalysis[] = [];
  const monthlyInvocationsByFunction = new Map<string, number>();
  const averageDurationMsByFunction = new Map<string, number>();
  const maxDurationMsByFunction = new Map<string, number>();

  for (const fn of functions) {
    const queries = buildQueries(fn.functionName, periodSeconds);

    let invocationCount = 0;
    let errorCount = 0;
    let throttleCount = 0;
    let averageDurationMs = 0;
    let maxDurationMs = 0;
    let p99DurationMs = 0;

    try {
      const response = await cloudWatchClient.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: startTime,
          EndTime: endTime,
          ScanBy: 'TimestampAscending',
        }),
      );

      const byId = new Map(response.MetricDataResults?.map((r) => [r.Id, r.Values ?? []]) ?? []);
      invocationCount = sum(byId.get('invocations'));
      errorCount = sum(byId.get('errors'));
      throttleCount = sum(byId.get('throttles'));
      averageDurationMs = avg(byId.get('durationAvg'));
      maxDurationMs = max(byId.get('durationMax'));
      p99DurationMs = avg(byId.get('durationP99'));
    } catch (err) {
      // If CloudWatch throws (e.g., throttled API, transient error) treat as zero data rather
      // than aborting the entire scan - this function will simply show as having no metrics.
      console.error(`Failed to fetch invocation metrics for ${fn.functionName}:`, err);
    }

    const errorRatePct = invocationCount > 0 ? (errorCount / invocationCount) * 100 : 0;
    const throttleRatePct =
      invocationCount + throttleCount > 0 ? (throttleCount / (invocationCount + throttleCount)) * 100 : 0;

    const isDeadFunction = invocationCount === 0;
    const hasHighErrorRate = errorRatePct > HIGH_ERROR_RATE_THRESHOLD_PCT;
    const isHighlyThrottled = throttleRatePct > HIGH_THROTTLE_RATE_THRESHOLD_PCT;

    const estimatedMonthlyStorageCostUsd = isDeadFunction
      ? round2((fn.codeSizeBytes / 1024 / 1024 / 1024) * storagePricePerGbMonthUsd)
      : undefined;

    analyses.push({
      functionName: fn.functionName,
      invocationCount: Math.round(invocationCount),
      errorCount: Math.round(errorCount),
      errorRatePct: Math.round(errorRatePct * 100) / 100,
      throttleCount: Math.round(throttleCount),
      throttleRatePct: Math.round(throttleRatePct * 100) / 100,
      averageDurationMs: Math.round(averageDurationMs),
      p99DurationMs: Math.round(p99DurationMs),
      isDeadFunction,
      hasHighErrorRate,
      isHighlyThrottled,
      estimatedMonthlyStorageCostUsd,
    });

    monthlyInvocationsByFunction.set(fn.functionName, invocationCount);
    averageDurationMsByFunction.set(fn.functionName, averageDurationMs);
    maxDurationMsByFunction.set(fn.functionName, maxDurationMs);
  }

  return { analyses, monthlyInvocationsByFunction, averageDurationMsByFunction, maxDurationMsByFunction };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

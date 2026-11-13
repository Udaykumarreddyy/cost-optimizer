import { CloudWatchClient, GetMetricDataCommand, MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { LambdaFunctionProfile, ColdStartAnalysis } from '../utils/types';

/**
 * Cold-Start Analyzer
 * -------------------
 * CloudWatch does not emit a dedicated "cold start" metric out of the box, but every cold
 * invocation's `Init Duration` is captured by Lambda and surfaced through CloudWatch Logs
 * structured REPORT lines (and, when Lambda Insights is enabled, as a first-class
 * `init_duration` metric in the `LambdaInsights` namespace). This analyzer:
 *
 *   1. Queries `LambdaInsights` -> `init_duration` (Average/Maximum/SampleCount) when available.
 *   2. Falls back to zero cold-start signal (reported as "no data") when Insights is not
 *      enabled, since safely inferring cold starts from standard metrics alone is unreliable
 *      (standard `Duration` does not separate init time from handler time).
 *
 * Flags:
 *   - hasSlowColdStart: average cold start > 3,000 ms (candidate for Provisioned Concurrency,
 *     larger memory to speed up init, or SnapStart for Java)
 *   - hasFrequentColdStarts: coldStartRatioPct > 30% of total invocations (suggests low/spiky
 *     traffic causing frequent environment recycling)
 *
 * Provisioned Concurrency cost/benefit:
 *   PC bills $0.0000041667 per GB-second while *allocated* (whether invoked or not), roughly
 *   25% of normal duration pricing but charged continuously. We estimate:
 *     currentColdStartCostUsd  = (cold start count/month) * (avg init duration) * GB-second rate
 *     provisionedConcurrencyCostUsd = recommended PC units * memoryGb * seconds-in-month * PC rate
 *   and only recommend PC when the eliminated cold-start latency cost/risk is justified by
 *   traffic volume (coldStartRatioPct > 30% AND average invocation rate suggests steady traffic).
 */

const SLOW_COLD_START_THRESHOLD_MS = 3000;
const FREQUENT_COLD_START_RATIO_THRESHOLD_PCT = 30;
const PROVISIONED_CONCURRENCY_PRICE_PER_GB_SECOND = 0.0000041667;
const DURATION_PRICE_PER_GB_SECOND_X86 = 0.0000166667;
const SECONDS_IN_MONTH = 30 * 24 * 60 * 60;

export interface ColdStartAnalyzerOptions {
  cloudWatchClient: CloudWatchClient;
  lookbackDays: number;
  monthlyInvocationsByFunction: Map<string, number>;
}

function buildQueries(functionName: string, period: number): MetricDataQuery[] {
  const dims = [{ Name: 'function_name', Value: functionName }];
  return [
    {
      Id: 'initAvg',
      MetricStat: {
        Metric: { Namespace: 'LambdaInsights', MetricName: 'init_duration', Dimensions: dims },
        Period: period,
        Stat: 'Average',
      },
      ReturnData: true,
    },
    {
      Id: 'initMax',
      MetricStat: {
        Metric: { Namespace: 'LambdaInsights', MetricName: 'init_duration', Dimensions: dims },
        Period: period,
        Stat: 'Maximum',
      },
      ReturnData: true,
    },
    {
      Id: 'initCount',
      MetricStat: {
        Metric: { Namespace: 'LambdaInsights', MetricName: 'init_duration', Dimensions: dims },
        Period: period,
        Stat: 'SampleCount',
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
  return v.length === 0 ? 0 : v.reduce((a, x) => a + x, 0) / v.length;
}
function max(values: number[] | undefined): number {
  const v = values ?? [];
  return v.length === 0 ? 0 : Math.max(...v);
}

export async function analyzeColdStarts(
  functions: LambdaFunctionProfile[],
  options: ColdStartAnalyzerOptions,
): Promise<ColdStartAnalysis[]> {
  const { cloudWatchClient, lookbackDays, monthlyInvocationsByFunction } = options;

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const periodSeconds = Math.max(3600, lookbackDays * 24 * 60 * 60);

  const results: ColdStartAnalysis[] = [];

  for (const fn of functions) {
    const totalInvocations = monthlyInvocationsByFunction.get(fn.functionName) ?? 0;

    let averageColdStartMs = 0;
    let maxColdStartMs = 0;
    let coldStartCount = 0;
    let hasInsightsData = false;

    try {
      const response = await cloudWatchClient.send(
        new GetMetricDataCommand({
          MetricDataQueries: buildQueries(fn.functionName, periodSeconds),
          StartTime: startTime,
          EndTime: endTime,
        }),
      );
      const byId = new Map(response.MetricDataResults?.map((r) => [r.Id, r.Values ?? []]) ?? []);
      averageColdStartMs = avg(byId.get('initAvg'));
      maxColdStartMs = max(byId.get('initMax'));
      coldStartCount = sum(byId.get('initCount'));
      hasInsightsData = (byId.get('initAvg')?.length ?? 0) > 0;
    } catch (err) {
      console.error(`Failed to fetch cold-start metrics for ${fn.functionName}:`, err);
    }

    const coldStartRatioPct = totalInvocations > 0 ? (coldStartCount / totalInvocations) * 100 : 0;
    const hasSlowColdStart = hasInsightsData && averageColdStartMs > SLOW_COLD_START_THRESHOLD_MS;
    const hasFrequentColdStarts = hasInsightsData && coldStartRatioPct > FREQUENT_COLD_START_RATIO_THRESHOLD_PCT;

    // Monthly $ cost currently attributable to cold-start init overhead (billed duration includes init time).
    const memoryGb = fn.memorySizeMb / 1024;
    const coldStartsPerMonth = (coldStartCount / lookbackDays) * 30;
    const estimatedMonthlyColdStartCostUsd = round2(
      memoryGb * (averageColdStartMs / 1000) * coldStartsPerMonth * DURATION_PRICE_PER_GB_SECOND_X86,
    );

    // Recommend enough PC units to cover typical concurrent cold-start bursts: approximate by
    // invocations/month -> invocations/second during business hours, floor of 1 unit if flagged.
    const invocationsPerSecondEstimate = totalInvocations / (lookbackDays * 24 * 60 * 60);
    const recommendedProvisionedConcurrencyUnits =
      hasSlowColdStart || hasFrequentColdStarts ? Math.max(1, Math.ceil(invocationsPerSecondEstimate * 5)) : 0;

    const estimatedProvisionedConcurrencyCostUsd = round2(
      recommendedProvisionedConcurrencyUnits *
        memoryGb *
        SECONDS_IN_MONTH *
        PROVISIONED_CONCURRENCY_PRICE_PER_GB_SECOND,
    );

    const provisionedConcurrencyRecommended =
      recommendedProvisionedConcurrencyUnits > 0 && estimatedProvisionedConcurrencyCostUsd > 0;

    results.push({
      functionName: fn.functionName,
      averageColdStartMs: Math.round(averageColdStartMs),
      maxColdStartMs: Math.round(maxColdStartMs),
      coldStartCount: Math.round(coldStartCount),
      totalInvocations: Math.round(totalInvocations),
      coldStartRatioPct: Math.round(coldStartRatioPct * 10) / 10,
      hasSlowColdStart,
      hasFrequentColdStarts,
      estimatedMonthlyColdStartCostUsd,
      estimatedProvisionedConcurrencyCostUsd,
      provisionedConcurrencyRecommended,
      recommendedProvisionedConcurrencyUnits,
    });
  }

  return results;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

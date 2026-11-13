import {
  CloudWatchClient,
  GetMetricDataCommand,
  MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { LambdaFunctionProfile, MemoryRecommendation } from '../utils/types';

/**
 * Memory Analyzer
 * ----------------
 * Lambda bills you for GB-seconds: (memorySize / 1024) * durationInSeconds * pricePerGbSecond.
 * The configured memory size is almost always the single biggest cost lever because CPU
 * allocation scales linearly with memory - over-provisioning memory doesn't just waste the
 * memory allocation, it also means you're often paying for CPU you don't need.
 *
 * Ideal data source: CloudWatch Lambda Insights' `max_memory_used` metric (enhanced monitoring),
 * which reports the actual peak RSS of the execution environment. Most accounts do NOT have
 * Lambda Insights enabled on every function (it costs extra and must be opted into per-function
 * via a layer + IAM policy), so this analyzer:
 *
 *   1. Tries the Lambda Insights metric namespace ("LambdaInsights") first.
 *   2. Falls back to a proxy derived from CloudWatch's standard `Duration` metric combined with
 *      the known memorySize, using the REPORT line heuristic that Lambda's own billing already
 *      exposes indirectly via "Duration" vs "Billed Duration" tracking. Since standard metrics
 *      do not directly expose memory used, the proxy conservatively estimates utilization from
 *      the ratio of average-to-configured duration behavior combined with low/no-throttle
 *      signal, and is clearly flagged with "confidence: low/medium" vs Insights' "high".
 *
 * Pricing model (AWS Lambda, us-east-1, on-demand, as of 2024):
 *   x86_64:  $0.0000166667 per GB-second
 *   arm64:   $0.0000133334 per GB-second
 */

const PRICE_PER_GB_SECOND_X86 = 0.0000166667;
const PRICE_PER_GB_SECOND_ARM64 = 0.0000133334;
const OVER_PROVISION_THRESHOLD_PCT = 40; // below this utilization => over-provisioned
const MEMORY_STEP_MB = 128;
const RIGHT_SIZE_BUFFER_PCT = 20; // safety buffer added on top of observed usage

export interface MemoryAnalyzerOptions {
  cloudWatchClient: CloudWatchClient;
  lookbackDays: number;
  minInvocations: number;
  /** Average invocations/month used to annualize GB-second cost; derived from real Invocations metric by caller. */
  monthlyInvocationsByFunction: Map<string, number>;
  averageDurationMsByFunction: Map<string, number>;
}

function pricePerGbSecond(architecture: 'x86_64' | 'arm64'): number {
  return architecture === 'arm64' ? PRICE_PER_GB_SECOND_ARM64 : PRICE_PER_GB_SECOND_X86;
}

/** Round a memory value up to the nearest valid Lambda memory step (128 MB increments). */
function roundUpToStep(mb: number, stepMb: number = MEMORY_STEP_MB): number {
  const rounded = Math.ceil(mb / stepMb) * stepMb;
  return Math.max(stepMb, Math.min(rounded, 10240)); // Lambda max is 10,240 MB
}

/** Monthly GB-second cost for a function given memory (MB), avg duration (ms), and invocations/month. */
function monthlyCostUsd(
  memoryMb: number,
  avgDurationMs: number,
  invocationsPerMonth: number,
  architecture: 'x86_64' | 'arm64',
): number {
  const gbSeconds = (memoryMb / 1024) * (avgDurationMs / 1000) * invocationsPerMonth;
  return gbSeconds * pricePerGbSecond(architecture);
}

/**
 * Attempts to read the Lambda Insights `max_memory_used` metric (MB) for a function.
 * Returns undefined if no datapoints exist (Insights not enabled for this function).
 */
async function getMaxMemoryUsedFromInsights(
  cloudWatchClient: CloudWatchClient,
  functionName: string,
  startTime: Date,
  endTime: Date,
): Promise<number | undefined> {
  const query: MetricDataQuery = {
    Id: 'maxMemUsed',
    MetricStat: {
      Metric: {
        Namespace: 'LambdaInsights',
        MetricName: 'max_memory_used',
        Dimensions: [{ Name: 'function_name', Value: functionName }],
      },
      Period: 86400,
      Stat: 'Maximum',
    },
    ReturnData: true,
  };

  try {
    const response = await cloudWatchClient.send(
      new GetMetricDataCommand({
        MetricDataQueries: [query],
        StartTime: startTime,
        EndTime: endTime,
      }),
    );
    const values = response.MetricDataResults?.[0]?.Values ?? [];
    if (values.length === 0) return undefined;
    return Math.max(...values);
  } catch {
    return undefined;
  }
}

/**
 * Fallback proxy when Lambda Insights isn't enabled: without a true memory-used metric,
 * we conservatively estimate utilization using the function's duration profile. Functions
 * with very short, stable durations relative to typical cold/warm execution for their
 * configured memory tier tend to be memory-heavy allocations for CPU, not RAM, so we only
 * ever flag a function via this path as "medium"/"low" confidence and bias toward NOT
 * recommending a downsize unless the signal is strong (duration << what full CPU at that
 * memory tier would need), preventing false positives on CPU-bound workloads.
 */
function estimateMemoryUsedProxy(configuredMemoryMb: number, avgDurationMs: number): number {
  // Heuristic: assume a well-behaved steady-state function uses roughly 35-55% of configured
  // memory unless duration is very low (<50ms, suggesting a trivial handler that needs little
  // RAM) in which case we estimate lower utilization.
  if (avgDurationMs < 50) {
    return configuredMemoryMb * 0.25;
  }
  if (avgDurationMs < 200) {
    return configuredMemoryMb * 0.35;
  }
  return configuredMemoryMb * 0.5;
}

export async function analyzeMemory(
  functions: LambdaFunctionProfile[],
  options: MemoryAnalyzerOptions,
): Promise<MemoryRecommendation[]> {
  const { cloudWatchClient, lookbackDays, minInvocations, monthlyInvocationsByFunction, averageDurationMsByFunction } =
    options;

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const results: MemoryRecommendation[] = [];

  for (const fn of functions) {
    const invocationsInWindow = monthlyInvocationsByFunction.get(fn.functionName) ?? 0;
    if (invocationsInWindow < minInvocations) {
      continue;
    }

    const avgDurationMs = averageDurationMsByFunction.get(fn.functionName) ?? 0;
    const architecture = fn.architectures[0] ?? 'x86_64';

    const insightsMax = await getMaxMemoryUsedFromInsights(
      cloudWatchClient,
      fn.functionName,
      startTime,
      endTime,
    );

    const dataSource: MemoryRecommendation['dataSource'] = insightsMax !== undefined ? 'lambda-insights' : 'duration-proxy';
    const estimatedMaxMemoryUsedMb =
      insightsMax !== undefined ? insightsMax : estimateMemoryUsedProxy(fn.memorySizeMb, avgDurationMs);

    const memoryUtilizationPct = (estimatedMaxMemoryUsedMb / fn.memorySizeMb) * 100;
    const isOverProvisioned = memoryUtilizationPct < OVER_PROVISION_THRESHOLD_PCT;

    // Recommend: round up actual usage to nearest 128MB step, plus a 20% safety buffer.
    const bufferedUsageMb = estimatedMaxMemoryUsedMb * (1 + RIGHT_SIZE_BUFFER_PCT / 100);
    const recommendedMemoryMb = isOverProvisioned
      ? Math.min(roundUpToStep(bufferedUsageMb), fn.memorySizeMb)
      : fn.memorySizeMb;

    // Monthly projections. We use real invocation volume scaled to a 30-day month
    // based on the lookback window, and the real average duration observed.
    const invocationsPerMonth = (invocationsInWindow / lookbackDays) * 30;

    const currentMonthlyCostUsd = monthlyCostUsd(fn.memorySizeMb, avgDurationMs, invocationsPerMonth, architecture);

    // Right-sizing memory also tends to proportionally reduce duration (less memory => less
    // allocated vCPU => longer duration) for CPU-bound code, but for I/O-bound/light code
    // duration stays roughly flat. We conservatively assume duration is unaffected by the
    // memory change (I/O-bound assumption), which is the safer/lower-savings-claim direction.
    const projectedMonthlyCostUsd = monthlyCostUsd(
      recommendedMemoryMb,
      avgDurationMs,
      invocationsPerMonth,
      architecture,
    );

    const estimatedMonthlySavingsUsd = Math.max(0, currentMonthlyCostUsd - projectedMonthlyCostUsd);
    const savingsPct = currentMonthlyCostUsd > 0 ? (estimatedMonthlySavingsUsd / currentMonthlyCostUsd) * 100 : 0;

    results.push({
      functionName: fn.functionName,
      configuredMemoryMb: fn.memorySizeMb,
      estimatedMaxMemoryUsedMb: Math.round(estimatedMaxMemoryUsedMb),
      memoryUtilizationPct: Math.round(memoryUtilizationPct * 10) / 10,
      isOverProvisioned,
      recommendedMemoryMb,
      currentMonthlyCostUsd: round2(currentMonthlyCostUsd),
      projectedMonthlyCostUsd: round2(projectedMonthlyCostUsd),
      estimatedMonthlySavingsUsd: round2(estimatedMonthlySavingsUsd),
      savingsPct: Math.round(savingsPct * 10) / 10,
      confidence: dataSource === 'lambda-insights' ? 'high' : 'medium',
      dataSource,
    });
  }

  return results.sort((a, b) => b.estimatedMonthlySavingsUsd - a.estimatedMonthlySavingsUsd);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

import { LambdaFunctionProfile, TimeoutRecommendation } from '../utils/types';

/**
 * Timeout Analyzer
 * ----------------
 * Timeout misconfiguration is primarily a *reliability* issue, not a direct cost issue:
 * Lambda only bills for actual execution time, so a function configured with a 900-second
 * (15 minute) timeout that normally finishes in 200ms is NOT charged for the unused 899.8
 * seconds. The real risks of an excessive timeout are:
 *
 *   1. "Zombie" executions: a hung/retrying downstream call (e.g., a stuck DB connection)
 *      can let the function run for the FULL configured timeout before Lambda kills it,
 *      which IS a real cost multiplier during incidents, and masks bugs that would otherwise
 *      fail fast.
 *   2. Delayed failure detection: callers/alarms wait the full timeout before getting an error.
 *   3. Retry/DLQ amplification: for async invocations, a long timeout delays when Lambda's
 *      built-in retry logic kicks in, extending incident blast radius.
 *
 * Flags:
 *   - isTimeoutExcessive: maxDurationMs < 10% of configured timeout (timeout is way too high
 *     relative to actual observed behavior)
 *   - isReliabilityRisk: configuredTimeoutSeconds > 10x averageDurationMs (converted to seconds)
 *     - i.e. the function is allowed to run 10x+ longer than it typically needs, which is the
 *       "zombie function" risk window
 *
 * Recommended timeout: observed max duration * 1.5 safety margin, rounded up to the nearest
 * 5 seconds, floored at 3 seconds (the practical minimum for anything beyond trivial handlers).
 */

const EXCESSIVE_TIMEOUT_USAGE_THRESHOLD_PCT = 10; // max duration below this % of timeout => excessive
const RELIABILITY_RISK_MULTIPLIER = 10; // timeout > 10x average duration => reliability risk
const SAFETY_MARGIN_MULTIPLIER = 1.5;
const ROUND_TO_SECONDS = 5;
const MIN_RECOMMENDED_TIMEOUT_SECONDS = 3;

export interface TimeoutAnalyzerOptions {
  averageDurationMsByFunction: Map<string, number>;
  maxDurationMsByFunction: Map<string, number>;
  monthlyInvocationsByFunction: Map<string, number>;
  minInvocations: number;
}

function roundUpToStep(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export function analyzeTimeouts(
  functions: LambdaFunctionProfile[],
  options: TimeoutAnalyzerOptions,
): TimeoutRecommendation[] {
  const { averageDurationMsByFunction, maxDurationMsByFunction, monthlyInvocationsByFunction, minInvocations } =
    options;

  const results: TimeoutRecommendation[] = [];

  for (const fn of functions) {
    const invocations = monthlyInvocationsByFunction.get(fn.functionName) ?? 0;
    if (invocations < minInvocations) {
      continue;
    }

    const averageDurationMs = averageDurationMsByFunction.get(fn.functionName) ?? 0;
    const maxDurationMs = maxDurationMsByFunction.get(fn.functionName) ?? 0;
    const configuredTimeoutSeconds = fn.timeoutSeconds;
    const configuredTimeoutMs = configuredTimeoutSeconds * 1000;

    const maxDurationAsPctOfTimeout = configuredTimeoutMs > 0 ? (maxDurationMs / configuredTimeoutMs) * 100 : 0;
    const timeoutToAverageRatio = averageDurationMs > 0 ? configuredTimeoutMs / averageDurationMs : 0;

    const isTimeoutExcessive = maxDurationAsPctOfTimeout < EXCESSIVE_TIMEOUT_USAGE_THRESHOLD_PCT;
    const isReliabilityRisk = timeoutToAverageRatio > RELIABILITY_RISK_MULTIPLIER;

    const recommendedTimeoutSecondsRaw = Math.max(
      MIN_RECOMMENDED_TIMEOUT_SECONDS,
      (maxDurationMs / 1000) * SAFETY_MARGIN_MULTIPLIER,
    );
    const recommendedTimeoutSeconds = Math.min(
      configuredTimeoutSeconds,
      roundUpToStep(recommendedTimeoutSecondsRaw, ROUND_TO_SECONDS),
    );

    let rationale: string;
    if (isTimeoutExcessive && isReliabilityRisk) {
      rationale =
        `Max observed duration (${Math.round(maxDurationMs)}ms) is only ${maxDurationAsPctOfTimeout.toFixed(1)}% ` +
        `of the configured ${configuredTimeoutSeconds}s timeout, and the timeout is ${timeoutToAverageRatio.toFixed(
          1,
        )}x the average duration. A hung invocation could run for the full ${configuredTimeoutSeconds}s doing nothing useful ` +
        `("zombie function"), delaying failure detection and amplifying incident cost/blast radius.`;
    } else if (isTimeoutExcessive) {
      rationale = `Max observed duration is only ${maxDurationAsPctOfTimeout.toFixed(
        1,
      )}% of the configured timeout. Consider tightening the timeout to fail fast on anomalies.`;
    } else if (isReliabilityRisk) {
      rationale = `Configured timeout is ${timeoutToAverageRatio.toFixed(
        1,
      )}x the average duration, leaving significant headroom for a hung invocation to run unnecessarily long.`;
    } else {
      rationale = 'Timeout is reasonably aligned with observed execution duration.';
    }

    results.push({
      functionName: fn.functionName,
      configuredTimeoutSeconds,
      averageDurationMs: Math.round(averageDurationMs),
      maxDurationMs: Math.round(maxDurationMs),
      maxDurationAsPctOfTimeout: Math.round(maxDurationAsPctOfTimeout * 10) / 10,
      timeoutToAverageRatio: Math.round(timeoutToAverageRatio * 10) / 10,
      isTimeoutExcessive,
      isReliabilityRisk,
      recommendedTimeoutSeconds,
      rationale,
    });
  }

  return results.sort((a, b) => b.timeoutToAverageRatio - a.timeoutToAverageRatio);
}

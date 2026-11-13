import { LambdaFunctionProfile, ArchitectureRecommendation } from '../utils/types';

/**
 * Architecture Analyzer (ARM64 / Graviton2)
 * -----------------------------------------
 * AWS Graviton2 (arm64) Lambda pricing is ~20% cheaper per GB-second than x86_64, and for most
 * workloads performance is equal or better. This analyzer:
 *
 *   1. Reads each function's configured `architectures` array.
 *   2. For every x86_64 function, checks runtime compatibility. All first-party managed
 *      runtimes added after Graviton2 Lambda support launched (Dec 2021) support arm64:
 *        - Node.js (all supported versions)
 *        - Python (all supported versions)
 *        - Java (all supported versions, including SnapStart-eligible)
 *        - .NET (6+)
 *        - Ruby (2.7+, 3.x)
 *      Custom runtimes/container images (`packageType === 'Image'`) require that the base
 *      image itself was built for arm64 (multi-arch manifest or arm64-only image), which this
 *      analyzer cannot verify via the Lambda API alone - those are flagged as "needs manual
 *      verification" rather than "easily switchable".
 *   3. Calculates the 20% GB-second savings for every function that is cleanly switchable.
 *
 * Pricing:
 *   x86_64: $0.0000166667 / GB-second
 *   arm64:  $0.0000133334 / GB-second   (exactly 20% less)
 */

const PRICE_PER_GB_SECOND_X86 = 0.0000166667;
const PRICE_PER_GB_SECOND_ARM64 = 0.0000133334;

// Runtime prefixes known to support arm64 Lambda execution.
const ARM64_COMPATIBLE_RUNTIME_PREFIXES = ['nodejs', 'python', 'java', 'dotnet', 'ruby', 'provided.al2', 'provided.al2023'];

export interface ArchitectureAnalyzerOptions {
  monthlyInvocationsByFunction: Map<string, number>;
  averageDurationMsByFunction: Map<string, number>;
  lookbackDays: number;
}

function isRuntimeGravitonCompatible(runtime: string): { compatible: boolean; reason?: string } {
  const normalized = runtime.toLowerCase();

  if (normalized.startsWith('dotnetcore') || normalized === 'dotnet5.0') {
    return { compatible: false, reason: 'Legacy .NET Core runtime predates Graviton2 support; upgrade to .NET 6+ first.' };
  }

  const compatible = ARM64_COMPATIBLE_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!compatible) {
    return { compatible: false, reason: `Runtime "${runtime}" is not a recognized arm64-compatible managed runtime.` };
  }
  return { compatible: true };
}

export function analyzeArchitecture(
  functions: LambdaFunctionProfile[],
  options: ArchitectureAnalyzerOptions,
): ArchitectureRecommendation[] {
  const { monthlyInvocationsByFunction, averageDurationMsByFunction, lookbackDays } = options;

  const results: ArchitectureRecommendation[] = [];

  for (const fn of functions) {
    const currentArchitecture = fn.architectures[0] ?? 'x86_64';
    if (currentArchitecture === 'arm64') {
      // Already on Graviton - nothing to recommend, but still report for completeness/visibility.
      continue;
    }

    let isGravitonCompatible: boolean;
    let incompatibilityReason: string | undefined;

    if (fn.packageType === 'Image') {
      isGravitonCompatible = false;
      incompatibilityReason =
        'Container image package type - arm64 migration requires rebuilding/publishing a multi-arch or arm64 image; cannot be verified automatically.';
    } else {
      const check = isRuntimeGravitonCompatible(fn.runtime);
      isGravitonCompatible = check.compatible;
      incompatibilityReason = check.reason;
    }

    const invocationsInWindow = monthlyInvocationsByFunction.get(fn.functionName) ?? 0;
    const invocationsPerMonth = (invocationsInWindow / lookbackDays) * 30;
    const avgDurationMs = averageDurationMsByFunction.get(fn.functionName) ?? 0;
    const memoryGb = fn.memorySizeMb / 1024;
    const gbSecondsPerMonth = memoryGb * (avgDurationMs / 1000) * invocationsPerMonth;

    const currentMonthlyCostUsd = gbSecondsPerMonth * PRICE_PER_GB_SECOND_X86;
    const projectedArm64MonthlyCostUsd = gbSecondsPerMonth * PRICE_PER_GB_SECOND_ARM64;
    const estimatedMonthlySavingsUsd = isGravitonCompatible
      ? Math.max(0, currentMonthlyCostUsd - projectedArm64MonthlyCostUsd)
      : 0;
    const savingsPct = currentMonthlyCostUsd > 0 ? (estimatedMonthlySavingsUsd / currentMonthlyCostUsd) * 100 : 0;

    results.push({
      functionName: fn.functionName,
      currentArchitecture,
      runtime: fn.runtime,
      isGravitonCompatible,
      incompatibilityReason,
      currentMonthlyCostUsd: round2(currentMonthlyCostUsd),
      projectedArm64MonthlyCostUsd: round2(projectedArm64MonthlyCostUsd),
      estimatedMonthlySavingsUsd: round2(estimatedMonthlySavingsUsd),
      savingsPct: Math.round(savingsPct * 10) / 10,
    });
  }

  return results.sort((a, b) => b.estimatedMonthlySavingsUsd - a.estimatedMonthlySavingsUsd);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

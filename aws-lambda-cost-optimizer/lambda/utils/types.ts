/**
 * Shared type definitions used across every analyzer, the report generator,
 * and the handler orchestrator.
 */

/** Supported Lambda CPU architectures. */
export type LambdaArchitecture = 'x86_64' | 'arm64';

/**
 * A normalized snapshot of a single Lambda function's configuration,
 * built once per scan and passed into every analyzer so each one only
 * has to make its own CloudWatch calls.
 */
export interface LambdaFunctionProfile {
  functionName: string;
  functionArn: string;
  runtime: string;
  architectures: LambdaArchitecture[];
  memorySizeMb: number;
  timeoutSeconds: number;
  lastModified: string;
  codeSizeBytes: number;
  packageType: 'Zip' | 'Image';
  hasProvisionedConcurrency: boolean;
}

/** Statistics pulled from CloudWatch for a single metric over the lookback window. */
export interface MetricStats {
  sum: number;
  average: number;
  maximum: number;
  minimum: number;
  p99?: number;
  sampleCount: number;
  datapoints: number;
}

// ---------------------------------------------------------------------------
// Memory analyzer
// ---------------------------------------------------------------------------
export interface MemoryRecommendation {
  functionName: string;
  configuredMemoryMb: number;
  estimatedMaxMemoryUsedMb: number;
  memoryUtilizationPct: number;
  isOverProvisioned: boolean;
  recommendedMemoryMb: number;
  currentMonthlyCostUsd: number;
  projectedMonthlyCostUsd: number;
  estimatedMonthlySavingsUsd: number;
  savingsPct: number;
  confidence: 'high' | 'medium' | 'low';
  dataSource: 'lambda-insights' | 'duration-proxy';
}

// ---------------------------------------------------------------------------
// Invocation analyzer
// ---------------------------------------------------------------------------
export interface InvocationAnalysis {
  functionName: string;
  invocationCount: number;
  errorCount: number;
  errorRatePct: number;
  throttleCount: number;
  throttleRatePct: number;
  averageDurationMs: number;
  p99DurationMs: number;
  isDeadFunction: boolean;
  hasHighErrorRate: boolean;
  isHighlyThrottled: boolean;
  estimatedMonthlyStorageCostUsd?: number;
}

// ---------------------------------------------------------------------------
// Cold-start analyzer
// ---------------------------------------------------------------------------
export interface ColdStartAnalysis {
  functionName: string;
  averageColdStartMs: number;
  maxColdStartMs: number;
  coldStartCount: number;
  totalInvocations: number;
  coldStartRatioPct: number;
  hasSlowColdStart: boolean;
  hasFrequentColdStarts: boolean;
  estimatedMonthlyColdStartCostUsd: number;
  estimatedProvisionedConcurrencyCostUsd: number;
  provisionedConcurrencyRecommended: boolean;
  recommendedProvisionedConcurrencyUnits: number;
}

// ---------------------------------------------------------------------------
// Architecture analyzer
// ---------------------------------------------------------------------------
export interface ArchitectureRecommendation {
  functionName: string;
  currentArchitecture: LambdaArchitecture;
  runtime: string;
  isGravitonCompatible: boolean;
  incompatibilityReason?: string;
  currentMonthlyCostUsd: number;
  projectedArm64MonthlyCostUsd: number;
  estimatedMonthlySavingsUsd: number;
  savingsPct: number;
}

// ---------------------------------------------------------------------------
// Timeout analyzer
// ---------------------------------------------------------------------------
export interface TimeoutRecommendation {
  functionName: string;
  configuredTimeoutSeconds: number;
  averageDurationMs: number;
  maxDurationMs: number;
  maxDurationAsPctOfTimeout: number;
  timeoutToAverageRatio: number;
  isTimeoutExcessive: boolean;
  isReliabilityRisk: boolean;
  recommendedTimeoutSeconds: number;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------
export interface OptimizerReport {
  generatedAt: string;
  accountId: string;
  region: string;
  lookbackDays: number;
  minInvocations: number;
  totalFunctionsScanned: number;
  totalFunctionsAnalyzed: number;
  totalEstimatedMonthlySpendUsd: number;
  totalEstimatedMonthlySavingsUsd: number;
  memoryRecommendations: MemoryRecommendation[];
  invocationAnalyses: InvocationAnalysis[];
  coldStartAnalyses: ColdStartAnalysis[];
  architectureRecommendations: ArchitectureRecommendation[];
  timeoutRecommendations: TimeoutRecommendation[];
}

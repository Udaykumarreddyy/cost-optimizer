/**
 * Shared type definitions for the AWS Log Intelligence Lambda.
 */

/** Per-log-group storage/cost analysis produced by log-group-analyzer.ts */
export interface LogGroupAnalysis {
  logGroupName: string;
  arn: string;
  storedBytes: number;
  storedGB: number;
  retentionInDays: number | undefined; // undefined === "Never expire"
  hasNoRetention: boolean;
  monthlyStorageCost: number; // USD, storedGB * $0.03
  isLarge: boolean; // storedGB > 10
  creationTime: number | undefined;
  metricFilterCount: number | undefined;
}

/** Error-spike detection for a single log group, over the trailing 24h vs. prior 24h */
export interface ErrorDetection {
  logGroupName: string;
  currentPeriodErrorCount: number;
  previousPeriodErrorCount: number;
  errorRatePerHour: number;
  percentChange: number; // positive = increase
  isSpike: boolean; // percentChange > threshold (default 50%)
  sampleMessages: string[];
}

/** Ingestion-volume analysis for a single log group over the trailing 7 days */
export interface IngestionAnalysis {
  logGroupName: string;
  totalIncomingBytes: number;
  totalIncomingEvents: number;
  avgDailyIngestionGB: number;
  peakDailyIngestionGB: number;
  isHighVolume: boolean; // avgDailyIngestionGB > 1
  estimatedMonthlyIngestionCost: number; // USD, avgDailyIngestionGB * 30 * $0.50
  recommendation: string | undefined;
}

/** Retention recommendation for a log group that currently has no retention policy */
export interface RetentionRecommendation {
  logGroupName: string;
  currentRetention: string; // "Never expire"
  recommendedRetentionDays: number;
  matchedRule: string; // which pattern rule matched (e.g. "/aws/lambda/*")
  storedGB: number;
  estimatedMonthlySavings: number; // USD
  rationale: string;
}

/** Aggregate cost roll-up across the whole account */
export interface CostBreakdown {
  totalStorageGB: number;
  totalMonthlyStorageCost: number;
  totalDailyIngestionGB: number;
  totalMonthlyIngestionCost: number;
  totalEstimatedMonthlySpend: number;
  totalPotentialMonthlySavings: number;
}

/** Full report assembled by the orchestrator and handed to report-generator.ts */
export interface IntelligenceReport {
  generatedAt: string; // ISO-8601
  accountId: string;
  region: string;
  totalLogGroupsScanned: number;
  costBreakdown: CostBreakdown;
  topExpensiveGroups: LogGroupAnalysis[];
  errorDetections: ErrorDetection[];
  errorSpikes: ErrorDetection[];
  ingestionAnalyses: IngestionAnalysis[];
  ingestionHotspots: IngestionAnalysis[];
  retentionRecommendations: RetentionRecommendation[];
}

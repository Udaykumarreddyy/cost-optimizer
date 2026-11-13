/**
 * Shared type definitions for the pipeline health monitor Lambda.
 */

/** DORA performance category. See https://dora.dev/guides/dora-metrics-four-keys/ */
export type DORACategory = 'Elite' | 'High' | 'Medium' | 'Low';

export type ExecutionStatus =
  | 'Succeeded'
  | 'Failed'
  | 'InProgress'
  | 'Stopped'
  | 'Stopping'
  | 'Superseded'
  | 'Cancelled'
  | 'Unknown';

/** A single normalized pipeline execution record used for metric math. */
export interface PipelineExecutionRecord {
  executionId: string;
  status: ExecutionStatus;
  startTime?: Date;
  lastUpdateTime?: Date;
  durationMs?: number;
  trigger?: string;
}

/** Health summary for a single CodePipeline pipeline. */
export interface PipelineHealth {
  pipelineName: string;
  totalExecutions: number;
  succeededExecutions: number;
  failedExecutions: number;
  successRatePct: number;
  deploymentsPerWeek: number;
  averageDurationMinutes: number;
  lastExecutionStatus: ExecutionStatus;
  lastExecutionTime?: string;
  /** Minutes between a failure and the next success for this pipeline, averaged. */
  meanTimeToRecoveryMinutes: number | null;
  executions: PipelineExecutionRecord[];
}

/** Which build phase failed, and how often. */
export interface PhaseFailureCount {
  phaseType: string;
  failureCount: number;
}

/** Health summary for a single CodeBuild project. */
export interface BuildProjectHealth {
  projectName: string;
  totalBuilds: number;
  succeededBuilds: number;
  failedBuilds: number;
  timedOutBuilds: number;
  successRatePct: number;
  timeoutRatePct: number;
  averageDurationMinutes: number;
  /** p90 build duration (minutes) sourced from the AWS/CodeBuild CloudWatch namespace, across the full lookback window. Null if CloudWatch has no data points. */
  p90DurationMinutes: number | null;
  topFailingPhases: PhaseFailureCount[];
  lastBuildStatus: string;
  lastBuildTime?: string;
}

/** A single DORA metric with its raw value, unit, and benchmark category. */
export interface DORAMetricResult {
  metricName: string;
  value: number;
  unit: string;
  category: DORACategory;
  benchmarkDescription: string;
}

/** The four key DORA metrics, aggregated across the whole account/region scan. */
export interface DORAMetrics {
  deploymentFrequency: DORAMetricResult;
  leadTimeForChanges: DORAMetricResult;
  changeFailureRate: DORAMetricResult;
  meanTimeToRecovery: DORAMetricResult;
  /** Overall category = the lowest (worst) of the four individual categories. */
  overallCategory: DORACategory;
}

/** Top-level report payload consumed by the report generator / SNS notifier. */
export interface HealthReport {
  generatedAt: string;
  lookbackDays: number;
  accountId: string;
  region: string;
  pipelines: PipelineHealth[];
  buildProjects: BuildProjectHealth[];
  doraMetrics: DORAMetrics;
  totals: {
    pipelineCount: number;
    buildProjectCount: number;
    totalExecutions: number;
    totalBuilds: number;
  };
}

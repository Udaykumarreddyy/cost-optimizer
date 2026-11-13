import { DORACategory, DORAMetricResult, DORAMetrics, PipelineHealth } from '../utils/types';

/**
 * DORA benchmark thresholds, based on the Google Cloud / DORA "Accelerate
 * State of DevOps" research program (https://dora.dev/guides/dora-metrics-four-keys/).
 *
 * These are the four keys:
 *   - Deployment Frequency     (throughput)
 *   - Lead Time for Changes    (throughput)
 *   - Change Failure Rate      (stability)
 *   - Mean Time to Recovery    (stability)
 */

/** Deployment Frequency categorization, expressed in deploys/week. */
function categorizeDeploymentFrequency(deploysPerWeek: number): {
  category: DORACategory;
  benchmarkDescription: string;
} {
  if (deploysPerWeek >= 7) {
    return { category: 'Elite', benchmarkDescription: 'On-demand: multiple deploys per day (>= 7/week)' };
  }
  if (deploysPerWeek >= 1) {
    return { category: 'High', benchmarkDescription: 'Between once per day and once per week' };
  }
  if (deploysPerWeek >= 0.25) {
    return { category: 'Medium', benchmarkDescription: 'Between once per week and once per month' };
  }
  return { category: 'Low', benchmarkDescription: 'Fewer than once per month' };
}

/** Lead Time for Changes categorization, expressed in hours (commit -> production). */
function categorizeLeadTime(hours: number): { category: DORACategory; benchmarkDescription: string } {
  if (hours < 1) {
    return { category: 'Elite', benchmarkDescription: 'Less than one hour' };
  }
  if (hours <= 24) {
    return { category: 'High', benchmarkDescription: 'Between one hour and one day' };
  }
  if (hours <= 24 * 7) {
    return { category: 'Medium', benchmarkDescription: 'Between one day and one week' };
  }
  return { category: 'Low', benchmarkDescription: 'More than one week' };
}

/** Change Failure Rate categorization, expressed as a percentage (0-100). */
function categorizeChangeFailureRate(pct: number): { category: DORACategory; benchmarkDescription: string } {
  if (pct <= 15) {
    return { category: 'Elite', benchmarkDescription: '0% - 15% of deployments fail' };
  }
  if (pct <= 30) {
    return { category: 'High', benchmarkDescription: '16% - 30% of deployments fail' };
  }
  if (pct <= 45) {
    return { category: 'Medium', benchmarkDescription: '31% - 45% of deployments fail' };
  }
  return { category: 'Low', benchmarkDescription: 'More than 45% of deployments fail' };
}

/** Mean Time to Recovery categorization, expressed in hours. */
function categorizeMTTR(hours: number): { category: DORACategory; benchmarkDescription: string } {
  if (hours < 1) {
    return { category: 'Elite', benchmarkDescription: 'Less than one hour' };
  }
  if (hours <= 24) {
    return { category: 'High', benchmarkDescription: 'Less than one day' };
  }
  if (hours <= 24 * 7) {
    return { category: 'Medium', benchmarkDescription: 'Between one day and one week' };
  }
  return { category: 'Low', benchmarkDescription: 'More than one week' };
}

const CATEGORY_RANK: Record<DORACategory, number> = {
  Elite: 3,
  High: 2,
  Medium: 1,
  Low: 0
};

function worstCategory(categories: DORACategory[]): DORACategory {
  return categories.reduce((worst, c) => (CATEGORY_RANK[c] < CATEGORY_RANK[worst] ? c : worst));
}

function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

/**
 * Compute the four DORA keys from the raw per-pipeline health data gathered
 * by the pipeline analyzer.
 *
 * Notes on approximations (documented in README):
 *  - Deployment Frequency: average of each pipeline's successful
 *    deploys/week over the lookback window.
 *  - Lead Time for Changes: approximated as the average successful pipeline
 *    execution duration (source change -> fully deployed). CodePipeline does
 *    not expose the original commit timestamp via the API used here, so
 *    execution duration is used as a practical proxy for lead time.
 *  - Change Failure Rate: failed executions / total executions across all
 *    pipelines in the lookback window.
 *  - Mean Time to Recovery: average of each pipeline's MTTR (time from a
 *    failed execution to the next successful one), across pipelines that
 *    experienced at least one recovery.
 */
export function calculateDORAMetrics(pipelines: PipelineHealth[]): DORAMetrics {
  const pipelinesWithExecutions = pipelines.filter((p) => p.totalExecutions > 0);

  // --- Deployment Frequency ---
  const deployFreqPerWeek = average(pipelinesWithExecutions.map((p) => p.deploymentsPerWeek));
  const deployFreqCategorized = categorizeDeploymentFrequency(deployFreqPerWeek);
  const deploymentFrequency: DORAMetricResult = {
    metricName: 'Deployment Frequency',
    value: Math.round(deployFreqPerWeek * 100) / 100,
    unit: 'deploys/week',
    category: deployFreqCategorized.category,
    benchmarkDescription: deployFreqCategorized.benchmarkDescription
  };

  // --- Lead Time for Changes (proxy: average successful execution duration) ---
  const avgDurationMinutes = average(pipelinesWithExecutions.map((p) => p.averageDurationMinutes));
  const avgDurationHours = avgDurationMinutes / 60;
  const leadTimeCategorized = categorizeLeadTime(avgDurationHours);
  const leadTimeForChanges: DORAMetricResult = {
    metricName: 'Lead Time for Changes',
    value: Math.round(avgDurationHours * 100) / 100,
    unit: 'hours',
    category: leadTimeCategorized.category,
    benchmarkDescription: leadTimeCategorized.benchmarkDescription
  };

  // --- Change Failure Rate ---
  const totalExecutions = pipelinesWithExecutions.reduce((sum, p) => sum + p.totalExecutions, 0);
  const totalFailed = pipelinesWithExecutions.reduce((sum, p) => sum + p.failedExecutions, 0);
  const failureRatePct = totalExecutions > 0 ? (totalFailed / totalExecutions) * 100 : 0;
  const cfrCategorized = categorizeChangeFailureRate(failureRatePct);
  const changeFailureRate: DORAMetricResult = {
    metricName: 'Change Failure Rate',
    value: Math.round(failureRatePct * 100) / 100,
    unit: '%',
    category: cfrCategorized.category,
    benchmarkDescription: cfrCategorized.benchmarkDescription
  };

  // --- Mean Time to Recovery ---
  const mttrSamplesMinutes = pipelinesWithExecutions
    .map((p) => p.meanTimeToRecoveryMinutes)
    .filter((m): m is number => typeof m === 'number');
  const avgMttrMinutes = average(mttrSamplesMinutes);
  const avgMttrHours = avgMttrMinutes / 60;
  const mttrCategorized = categorizeMTTR(avgMttrHours);
  const meanTimeToRecovery: DORAMetricResult = {
    metricName: 'Mean Time to Recovery',
    value: Math.round(avgMttrHours * 100) / 100,
    unit: 'hours',
    category: mttrSamplesMinutes.length > 0 ? mttrCategorized.category : 'Elite',
    benchmarkDescription:
      mttrSamplesMinutes.length > 0
        ? mttrCategorized.benchmarkDescription
        : 'No failures observed in lookback window - nothing to recover from'
  };

  const overallCategory = worstCategory([
    deploymentFrequency.category,
    leadTimeForChanges.category,
    changeFailureRate.category,
    meanTimeToRecovery.category
  ]);

  return {
    deploymentFrequency,
    leadTimeForChanges,
    changeFailureRate,
    meanTimeToRecovery,
    overallCategory
  };
}

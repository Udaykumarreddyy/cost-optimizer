import { LogGroupAnalysis, RetentionRecommendation } from '../utils/types';
import { STORAGE_COST_PER_GB_MONTH } from './log-group-analyzer';

/**
 * Ordered pattern-matching rules used to recommend a retention period for log groups that
 * currently have no retention policy ("Never expire"). Rules are evaluated top-to-bottom;
 * the first match wins, so more specific / higher-priority rules should come first.
 */
interface RetentionRule {
  label: string;
  test: (logGroupName: string) => boolean;
  recommendedDays: number;
  rationale: string;
}

const RETENTION_RULES: RetentionRule[] = [
  {
    label: 'production/*',
    test: (name) => /prod(uction)?/i.test(name),
    recommendedDays: 365,
    rationale:
      'Production workloads often need up to a year of log history for incident forensics, ' +
      'compliance, and trend analysis.'
  },
  {
    label: '/aws/rds/*',
    test: (name) => name.startsWith('/aws/rds/'),
    recommendedDays: 90,
    rationale:
      'Database logs (slow query, audit, error logs) are useful for a full quarter of ' +
      'performance trending and are rarely needed longer for non-production databases.'
  },
  {
    label: '/ecs/* or /aws/ecs/*',
    test: (name) => name.startsWith('/ecs/') || name.startsWith('/aws/ecs/'),
    recommendedDays: 30,
    rationale:
      'ECS task/container logs are typically only useful for a month of operational ' +
      'troubleshooting before they lose relevance.'
  },
  {
    label: '/aws/eks/*',
    test: (name) => name.startsWith('/aws/eks/'),
    recommendedDays: 30,
    rationale: 'EKS control-plane and application logs follow the same 30-day operational window as ECS.'
  },
  {
    label: '/aws/lambda/*',
    test: (name) => name.startsWith('/aws/lambda/'),
    recommendedDays: 14,
    rationale:
      'Lambda invocation logs are high-volume and mostly useful for short-term debugging; ' +
      '14 days covers typical sprint/on-call cycles.'
  },
  {
    label: '/aws/apigateway/*',
    test: (name) => name.startsWith('/aws/apigateway/') || name.startsWith('/aws/api-gateway/'),
    recommendedDays: 14,
    rationale: 'API Gateway access/execution logs are high-volume and mainly used for near-term debugging.'
  },
  {
    label: '/aws/codebuild/*',
    test: (name) => name.startsWith('/aws/codebuild/'),
    recommendedDays: 30,
    rationale: 'CI build logs are useful for about a month of build-history troubleshooting.'
  },
  {
    label: 'default',
    test: () => true,
    recommendedDays: 30,
    rationale: 'No specific pattern matched; 30 days is a safe general-purpose default for operational logs.'
  }
];

/**
 * Builds retention recommendations for every log group that currently has no retention
 * policy set, based on log-group-name pattern matching, and estimates the monthly storage
 * savings if the recommended retention were applied (assumes future ingestion volume stays
 * roughly flat, so savings are modeled against the group's *currently stored* size).
 */
export function recommendRetention(
  logGroups: LogGroupAnalysis[],
  defaultRecommendationDays: number = 30
): RetentionRecommendation[] {
  const groupsWithoutRetention = logGroups.filter((g) => g.hasNoRetention);

  return groupsWithoutRetention.map((group) => {
    const rule =
      RETENTION_RULES.find((r) => r.label !== 'default' && r.test(group.logGroupName)) ??
      RETENTION_RULES[RETENTION_RULES.length - 1];

    const recommendedRetentionDays = rule.label === 'default' ? defaultRecommendationDays : rule.recommendedDays;

    // Model: logs older than the recommended retention window will eventually be purged by
    // CloudWatch, so the long-run storage footprint shrinks roughly in proportion to the
    // fraction of currently-stored data that falls outside the new retention window. Since we
    // don't have an age histogram, we conservatively estimate using a 180-day "effective
    // unbounded age" baseline, which approximates typical log growth curves for groups that
    // have never expired anything.
    const assumedEffectiveAgeDays = 180;
    const retainedFraction = Math.min(recommendedRetentionDays / assumedEffectiveAgeDays, 1);
    const projectedStoredGB = group.storedGB * retainedFraction;
    const projectedMonthlyCost = projectedStoredGB * STORAGE_COST_PER_GB_MONTH;
    const estimatedMonthlySavings = Math.max(group.monthlyStorageCost - projectedMonthlyCost, 0);

    return {
      logGroupName: group.logGroupName,
      currentRetention: 'Never expire',
      recommendedRetentionDays,
      matchedRule: rule.label,
      storedGB: group.storedGB,
      estimatedMonthlySavings,
      rationale: rule.rationale
    };
  });
}

/** Sums the estimated monthly savings across all retention recommendations. */
export function totalRetentionSavings(recommendations: RetentionRecommendation[]): number {
  return recommendations.reduce((sum, r) => sum + r.estimatedMonthlySavings, 0);
}

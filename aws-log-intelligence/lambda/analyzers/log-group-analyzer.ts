import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogGroupsCommandOutput,
  LogGroup
} from '@aws-sdk/client-cloudwatch-logs';
import { LogGroupAnalysis, CostBreakdown } from '../utils/types';

// CloudWatch Logs "Standard" storage pricing (us-east-1, as of this writing): $0.03 / GB / month.
// See https://aws.amazon.com/cloudwatch/pricing/ — adjust STORAGE_COST_PER_GB if your region/tier differs.
export const STORAGE_COST_PER_GB_MONTH = 0.03;
export const LARGE_GROUP_THRESHOLD_GB = 10;
export const TOP_N_EXPENSIVE_GROUPS = 20;

const logsClient = new CloudWatchLogsClient({});

/**
 * Lists every CloudWatch Log Group in the account/region (paginated via DescribeLogGroups),
 * computes storage size, monthly storage cost, and retention-policy flags for each.
 */
export async function analyzeLogGroups(): Promise<LogGroupAnalysis[]> {
  const allGroups: LogGroup[] = [];
  let nextToken: string | undefined;

  do {
    const response: DescribeLogGroupsCommandOutput = await logsClient.send(
      new DescribeLogGroupsCommand({
        nextToken,
        limit: 50
      })
    );
    allGroups.push(...(response.logGroups ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  const analyses: LogGroupAnalysis[] = allGroups.map((group) => {
    const storedBytes = group.storedBytes ?? 0;
    const storedGB = storedBytes / (1024 * 1024 * 1024);
    const monthlyStorageCost = storedGB * STORAGE_COST_PER_GB_MONTH;
    const retentionInDays = group.retentionInDays;
    const hasNoRetention = retentionInDays === undefined || retentionInDays === null;

    return {
      logGroupName: group.logGroupName ?? 'unknown',
      arn: group.arn ?? '',
      storedBytes,
      storedGB,
      retentionInDays,
      hasNoRetention,
      monthlyStorageCost,
      isLarge: storedGB > LARGE_GROUP_THRESHOLD_GB,
      creationTime: group.creationTime,
      metricFilterCount: group.metricFilterCount
    };
  });

  return analyses;
}

/** Returns the N log groups with the highest monthly storage cost, descending. */
export function getTopExpensiveGroups(
  analyses: LogGroupAnalysis[],
  topN: number = TOP_N_EXPENSIVE_GROUPS
): LogGroupAnalysis[] {
  return [...analyses]
    .sort((a, b) => b.monthlyStorageCost - a.monthlyStorageCost)
    .slice(0, topN);
}

/** Returns groups with no retention policy set (storing logs forever == unbounded cost growth). */
export function getGroupsWithNoRetention(analyses: LogGroupAnalysis[]): LogGroupAnalysis[] {
  return analyses.filter((a) => a.hasNoRetention);
}

/** Returns groups larger than LARGE_GROUP_THRESHOLD_GB stored. */
export function getLargeGroups(analyses: LogGroupAnalysis[]): LogGroupAnalysis[] {
  return analyses.filter((a) => a.isLarge);
}

/** Rolls up total storage GB / monthly storage cost across all scanned groups. */
export function buildStorageCostBreakdown(
  analyses: LogGroupAnalysis[]
): Pick<CostBreakdown, 'totalStorageGB' | 'totalMonthlyStorageCost'> {
  const totalStorageGB = analyses.reduce((sum, a) => sum + a.storedGB, 0);
  const totalMonthlyStorageCost = analyses.reduce((sum, a) => sum + a.monthlyStorageCost, 0);
  return { totalStorageGB, totalMonthlyStorageCost };
}

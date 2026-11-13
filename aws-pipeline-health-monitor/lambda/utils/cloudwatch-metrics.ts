import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const cloudwatch = new CloudWatchClient({});

/**
 * CodeBuild automatically publishes build metrics to the AWS/CodeBuild
 * CloudWatch namespace (Duration, Builds, SucceededBuilds, FailedBuilds),
 * dimensioned by ProjectName. BatchGetBuilds only returns the last ~300
 * build IDs; CloudWatch extended statistics (e.g. p90) give us a duration
 * percentile across the *entire* lookback window cheaply, as a sanity
 * check / complement to the per-build average computed from the API.
 *
 * Returns null if CloudWatch has no data points for the project in the
 * lookback window (e.g. a brand-new or idle project).
 */
export async function getP90BuildDurationMinutes(
  projectName: string,
  lookbackDays: number
): Promise<number | null> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  // CloudWatch GetMetricData periods must be a multiple of 60s; use one
  // bucket spanning the whole window since we only want a single p90 value.
  const periodSeconds = Math.max(60, Math.ceil((lookbackDays * 24 * 60 * 60) / 60) * 60);

  try {
    const resp = await cloudwatch.send(
      new GetMetricDataCommand({
        StartTime: startTime,
        EndTime: endTime,
        MetricDataQueries: [
          {
            Id: 'p90Duration',
            MetricStat: {
              Metric: {
                Namespace: 'AWS/CodeBuild',
                MetricName: 'Duration',
                Dimensions: [{ Name: 'ProjectName', Value: projectName }]
              },
              Period: periodSeconds,
              Stat: 'p90'
            },
            ReturnData: true
          }
        ]
      })
    );

    const values = resp.MetricDataResults?.[0]?.Values ?? [];
    if (values.length === 0) {
      return null;
    }

    // Duration metric is reported in seconds.
    const p90Seconds = values[0];
    return Math.round((p90Seconds / 60) * 10) / 10;
  } catch (err) {
    console.error(`CloudWatch GetMetricData failed for project ${projectName}`, err);
    return null;
  }
}

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  FilterLogEventsCommandOutput,
  FilteredLogEvent
} from '@aws-sdk/client-cloudwatch-logs';
import { LogGroupAnalysis, ErrorDetection } from '../utils/types';

// Matches common error/exception/fatal log lines across most application log formats.
export const ERROR_FILTER_PATTERN = '?ERROR ?EXCEPTION ?FATAL ?Error ?Exception ?Fatal';
export const MAX_SAMPLE_MESSAGES = 5;
export const MAX_EVENTS_PER_GROUP = 10_000; // safety cap on pagination per group, per period
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const logsClient = new CloudWatchLogsClient({});

/**
 * For each of the given log groups (expected: top N by storage cost), searches the last 24h
 * for ERROR/EXCEPTION/FATAL patterns via FilterLogEvents, compares the count to the prior 24h
 * window, and flags a "spike" when the increase exceeds `spikeThresholdPercent`.
 */
export async function detectErrors(
  logGroups: LogGroupAnalysis[],
  spikeThresholdPercent: number = 50,
  now: Date = new Date()
): Promise<ErrorDetection[]> {
  const nowMs = now.getTime();
  const currentStart = nowMs - ONE_DAY_MS;
  const previousStart = nowMs - 2 * ONE_DAY_MS;
  const previousEnd = currentStart;

  const results: ErrorDetection[] = [];

  for (const group of logGroups) {
    try {
      const [currentEvents, previousEvents] = await Promise.all([
        fetchErrorEvents(group.logGroupName, currentStart, nowMs),
        fetchErrorEvents(group.logGroupName, previousStart, previousEnd)
      ]);

      const currentPeriodErrorCount = currentEvents.length;
      const previousPeriodErrorCount = previousEvents.length;
      const percentChange = calculatePercentChange(previousPeriodErrorCount, currentPeriodErrorCount);
      const isSpike = percentChange > spikeThresholdPercent;
      const errorRatePerHour = currentPeriodErrorCount / 24;

      results.push({
        logGroupName: group.logGroupName,
        currentPeriodErrorCount,
        previousPeriodErrorCount,
        errorRatePerHour,
        percentChange,
        isSpike,
        sampleMessages: currentEvents.slice(0, MAX_SAMPLE_MESSAGES).map((e) => (e.message ?? '').trim())
      });
    } catch (err) {
      // A single inaccessible/odd log group (e.g. insufficient permissions, deleted mid-run)
      // should not abort the whole scan.
      console.error(`error-detector: failed to analyze "${group.logGroupName}":`, err);
      results.push({
        logGroupName: group.logGroupName,
        currentPeriodErrorCount: 0,
        previousPeriodErrorCount: 0,
        errorRatePerHour: 0,
        percentChange: 0,
        isSpike: false,
        sampleMessages: []
      });
    }
  }

  return results;
}

/** Paginated FilterLogEvents call scoped to [startTime, endTime) with the ERROR/EXCEPTION/FATAL pattern. */
async function fetchErrorEvents(
  logGroupName: string,
  startTime: number,
  endTime: number
): Promise<FilteredLogEvent[]> {
  const events: FilteredLogEvent[] = [];
  let nextToken: string | undefined;

  do {
    const response: FilterLogEventsCommandOutput = await logsClient.send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime,
        endTime,
        filterPattern: ERROR_FILTER_PATTERN,
        nextToken,
        limit: 1000
      })
    );
    events.push(...(response.events ?? []));
    nextToken = response.nextToken;
  } while (nextToken && events.length < MAX_EVENTS_PER_GROUP);

  return events;
}

/** Returns percentage change from `previous` to `current`. Handles the previous===0 edge case. */
export function calculatePercentChange(previous: number, current: number): number {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return ((current - previous) / previous) * 100;
}

/** Filters a list of ErrorDetection results down to just the spikes. */
export function getErrorSpikes(detections: ErrorDetection[]): ErrorDetection[] {
  return detections.filter((d) => d.isSpike);
}

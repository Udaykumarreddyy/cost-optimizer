import {
  CodePipelineClient,
  ListPipelinesCommand,
  ListPipelineExecutionsCommand,
  PipelineExecutionSummary,
  PipelineSummary
} from '@aws-sdk/client-codepipeline';
import { ExecutionStatus, PipelineExecutionRecord, PipelineHealth } from '../utils/types';

const codepipeline = new CodePipelineClient({});

/** CodePipeline paginates ListPipelineExecutions; cap pages so one noisy pipeline can't blow the Lambda timeout. */
const MAX_EXECUTION_PAGES = 10;
const EXECUTIONS_PER_PAGE = 100;

/**
 * Discover every CodePipeline pipeline in the account/region.
 */
export async function listAllPipelines(): Promise<PipelineSummary[]> {
  const pipelines: PipelineSummary[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await codepipeline.send(
      new ListPipelinesCommand({ nextToken })
    );
    pipelines.push(...(resp.pipelines ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);

  return pipelines;
}

/**
 * Fetch execution history for a single pipeline, newest first, pulling only
 * what's needed to cover `lookbackDays`.
 */
async function listExecutionsWithinLookback(
  pipelineName: string,
  lookbackDays: number
): Promise<PipelineExecutionSummary[]> {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const executions: PipelineExecutionSummary[] = [];
  let nextToken: string | undefined;
  let page = 0;

  do {
    const resp = await codepipeline.send(
      new ListPipelineExecutionsCommand({
        pipelineName,
        maxResults: EXECUTIONS_PER_PAGE,
        nextToken
      })
    );

    const batch = resp.pipelineExecutionSummaries ?? [];
    executions.push(...batch);

    const oldestInBatch = batch[batch.length - 1]?.lastUpdateTime;
    nextToken = resp.nextToken;
    page += 1;

    // Stop early once we've paged past the lookback window.
    if (oldestInBatch && oldestInBatch < cutoff) {
      break;
    }
  } while (nextToken && page < MAX_EXECUTION_PAGES);

  return executions.filter((e) => {
    const t = e.lastUpdateTime ?? e.startTime;
    return !t || t >= cutoff;
  });
}

function normalizeStatus(status: string | undefined): ExecutionStatus {
  switch (status) {
    case 'Succeeded':
    case 'Failed':
    case 'InProgress':
    case 'Stopped':
    case 'Stopping':
    case 'Superseded':
    case 'Cancelled':
      return status;
    default:
      return 'Unknown';
  }
}

function toExecutionRecord(summary: PipelineExecutionSummary): PipelineExecutionRecord {
  const startTime = summary.startTime;
  const lastUpdateTime = summary.lastUpdateTime;
  const durationMs =
    startTime && lastUpdateTime
      ? lastUpdateTime.getTime() - startTime.getTime()
      : undefined;

  return {
    executionId: summary.pipelineExecutionId ?? 'unknown',
    status: normalizeStatus(summary.status),
    startTime,
    lastUpdateTime,
    durationMs: durationMs && durationMs > 0 ? durationMs : undefined,
    trigger: summary.trigger?.triggerType
  };
}

/**
 * Mean time to recovery: average time between a failed execution and the
 * next successful execution that follows it, in minutes. Returns null when
 * there's no failure (nothing to recover from) or no subsequent success.
 */
function calculateMTTR(executions: PipelineExecutionRecord[]): number | null {
  // Executions come back newest-first from the API; sort oldest-first for recovery math.
  const chronological = [...executions]
    .filter((e) => e.startTime)
    .sort((a, b) => a.startTime!.getTime() - b.startTime!.getTime());

  const recoveryTimesMs: number[] = [];
  let openFailureAt: Date | null = null;

  for (const exec of chronological) {
    if (exec.status === 'Failed') {
      if (!openFailureAt) {
        openFailureAt = exec.lastUpdateTime ?? exec.startTime!;
      }
    } else if (exec.status === 'Succeeded' && openFailureAt) {
      const recoveredAt = exec.lastUpdateTime ?? exec.startTime!;
      recoveryTimesMs.push(recoveredAt.getTime() - openFailureAt.getTime());
      openFailureAt = null;
    }
  }

  if (recoveryTimesMs.length === 0) {
    return null;
  }

  const avgMs = recoveryTimesMs.reduce((a, b) => a + b, 0) / recoveryTimesMs.length;
  return Math.round((avgMs / 1000 / 60) * 10) / 10;
}

/**
 * Analyze a single pipeline: pull execution history and reduce it to a
 * PipelineHealth summary.
 */
export async function analyzePipeline(
  pipelineName: string,
  lookbackDays: number
): Promise<PipelineHealth> {
  const rawExecutions = await listExecutionsWithinLookback(pipelineName, lookbackDays);
  const executions = rawExecutions.map(toExecutionRecord);

  const totalExecutions = executions.length;
  const succeededExecutions = executions.filter((e) => e.status === 'Succeeded').length;
  const failedExecutions = executions.filter((e) => e.status === 'Failed').length;
  const successRatePct =
    totalExecutions > 0 ? Math.round((succeededExecutions / totalExecutions) * 1000) / 10 : 0;

  const durations = executions
    .map((e) => e.durationMs)
    .filter((d): d is number => typeof d === 'number');
  const averageDurationMinutes =
    durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length / 1000 / 60) * 10) / 10
      : 0;

  const weeks = Math.max(lookbackDays / 7, 1 / 7);
  const deploymentsPerWeek = Math.round((succeededExecutions / weeks) * 10) / 10;

  const last = executions[0]; // newest first from the API
  const meanTimeToRecoveryMinutes = calculateMTTR(executions);

  return {
    pipelineName,
    totalExecutions,
    succeededExecutions,
    failedExecutions,
    successRatePct,
    deploymentsPerWeek,
    averageDurationMinutes,
    lastExecutionStatus: last?.status ?? 'Unknown',
    lastExecutionTime: last?.lastUpdateTime?.toISOString(),
    meanTimeToRecoveryMinutes,
    executions
  };
}

/**
 * Discover and analyze every pipeline in the account/region.
 */
export async function analyzeAllPipelines(lookbackDays: number): Promise<PipelineHealth[]> {
  const pipelines = await listAllPipelines();

  const results: PipelineHealth[] = [];
  for (const p of pipelines) {
    if (!p.name) continue;
    try {
      const health = await analyzePipeline(p.name, lookbackDays);
      results.push(health);
    } catch (err) {
      console.error(`Failed to analyze pipeline ${p.name}`, err);
      results.push({
        pipelineName: p.name,
        totalExecutions: 0,
        succeededExecutions: 0,
        failedExecutions: 0,
        successRatePct: 0,
        deploymentsPerWeek: 0,
        averageDurationMinutes: 0,
        lastExecutionStatus: 'Unknown',
        meanTimeToRecoveryMinutes: null,
        executions: []
      });
    }
  }

  return results;
}

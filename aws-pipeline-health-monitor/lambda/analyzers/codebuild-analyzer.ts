import {
  CodeBuildClient,
  ListProjectsCommand,
  ListBuildsForProjectCommand,
  BatchGetBuildsCommand,
  Build,
  BuildPhase
} from '@aws-sdk/client-codebuild';
import { getP90BuildDurationMinutes } from '../utils/cloudwatch-metrics';
import { BuildProjectHealth, PhaseFailureCount } from '../utils/types';

const codebuild = new CodeBuildClient({});

/** BatchGetBuilds accepts at most 100 IDs per call. */
const BATCH_GET_SIZE = 100;
/** Cap how many build IDs we pull per project so a very active project can't blow the Lambda timeout. */
const MAX_BUILD_IDS_PER_PROJECT = 300;

/**
 * Discover every CodeBuild project in the account/region.
 */
export async function listAllProjects(): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await codebuild.send(new ListProjectsCommand({ nextToken }));
    names.push(...(resp.projects ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);

  return names;
}

async function listBuildIdsForProject(projectName: string): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;

  do {
    const resp = await codebuild.send(
      new ListBuildsForProjectCommand({ projectName, nextToken })
    );
    ids.push(...(resp.ids ?? []));
    nextToken = resp.nextToken;
  } while (nextToken && ids.length < MAX_BUILD_IDS_PER_PROJECT);

  return ids.slice(0, MAX_BUILD_IDS_PER_PROJECT);
}

async function batchGetBuilds(ids: string[]): Promise<Build[]> {
  const builds: Build[] = [];

  for (let i = 0; i < ids.length; i += BATCH_GET_SIZE) {
    const chunk = ids.slice(i, i + BATCH_GET_SIZE);
    const resp = await codebuild.send(new BatchGetBuildsCommand({ ids: chunk }));
    builds.push(...(resp.builds ?? []));
  }

  return builds;
}

function filterByLookback(builds: Build[], lookbackDays: number): Build[] {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  return builds.filter((b) => {
    const t = b.startTime ?? b.endTime;
    return !t || t >= cutoff;
  });
}

function buildDurationMs(build: Build): number | undefined {
  if (build.startTime && build.endTime) {
    const ms = build.endTime.getTime() - build.startTime.getTime();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

/**
 * Walk a build's phase list and return the phase(s) that ended in FAILED or
 * TIMED_OUT, so we can attribute the failure to e.g. BUILD, DOWNLOAD_SOURCE,
 * PRE_BUILD, INSTALL, etc.
 */
function failingPhasesOf(build: Build): string[] {
  const phases: BuildPhase[] = build.phases ?? [];
  return phases
    .filter((p) => p.phaseStatus === 'FAILED' || p.phaseStatus === 'TIMED_OUT')
    .map((p) => p.phaseType ?? 'UNKNOWN');
}

/**
 * Analyze a single CodeBuild project's build history.
 */
export async function analyzeProject(
  projectName: string,
  lookbackDays: number
): Promise<BuildProjectHealth> {
  const ids = await listBuildIdsForProject(projectName);
  const allBuilds = ids.length > 0 ? await batchGetBuilds(ids) : [];
  const builds = filterByLookback(allBuilds, lookbackDays);

  // Newest first (ListBuildsForProject already returns builds newest-first).
  const totalBuilds = builds.length;
  const succeededBuilds = builds.filter((b) => b.buildStatus === 'SUCCEEDED').length;
  const failedBuilds = builds.filter((b) => b.buildStatus === 'FAILED').length;
  const timedOutBuilds = builds.filter((b) => b.buildStatus === 'TIMED_OUT').length;

  const successRatePct = totalBuilds > 0 ? Math.round((succeededBuilds / totalBuilds) * 1000) / 10 : 0;
  const timeoutRatePct = totalBuilds > 0 ? Math.round((timedOutBuilds / totalBuilds) * 1000) / 10 : 0;

  const durations = builds
    .map(buildDurationMs)
    .filter((d): d is number => typeof d === 'number');
  const averageDurationMinutes =
    durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length / 1000 / 60) * 10) / 10
      : 0;

  const phaseFailureTally = new Map<string, number>();
  for (const b of builds) {
    if (b.buildStatus === 'FAILED' || b.buildStatus === 'TIMED_OUT') {
      for (const phase of failingPhasesOf(b)) {
        phaseFailureTally.set(phase, (phaseFailureTally.get(phase) ?? 0) + 1);
      }
    }
  }
  const topFailingPhases: PhaseFailureCount[] = [...phaseFailureTally.entries()]
    .map(([phaseType, failureCount]) => ({ phaseType, failureCount }))
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, 5);

  const last = builds[0];
  const p90DurationMinutes = await getP90BuildDurationMinutes(projectName, lookbackDays);

  return {
    projectName,
    totalBuilds,
    succeededBuilds,
    failedBuilds,
    timedOutBuilds,
    successRatePct,
    timeoutRatePct,
    averageDurationMinutes,
    p90DurationMinutes,
    topFailingPhases,
    lastBuildStatus: last?.buildStatus ?? 'UNKNOWN',
    lastBuildTime: (last?.endTime ?? last?.startTime)?.toISOString()
  };
}

/**
 * Discover and analyze every CodeBuild project in the account/region.
 */
export async function analyzeAllProjects(lookbackDays: number): Promise<BuildProjectHealth[]> {
  const projectNames = await listAllProjects();

  const results: BuildProjectHealth[] = [];
  for (const name of projectNames) {
    try {
      const health = await analyzeProject(name, lookbackDays);
      results.push(health);
    } catch (err) {
      console.error(`Failed to analyze CodeBuild project ${name}`, err);
      results.push({
        projectName: name,
        totalBuilds: 0,
        succeededBuilds: 0,
        failedBuilds: 0,
        timedOutBuilds: 0,
        successRatePct: 0,
        timeoutRatePct: 0,
        averageDurationMinutes: 0,
        p90DurationMinutes: null,
        topFailingPhases: [],
        lastBuildStatus: 'UNKNOWN'
      });
    }
  }

  return results;
}

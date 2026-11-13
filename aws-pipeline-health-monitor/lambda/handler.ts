import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { analyzeAllPipelines } from './analyzers/pipeline-analyzer';
import { analyzeAllProjects } from './analyzers/codebuild-analyzer';
import { calculateDORAMetrics } from './analyzers/metrics-calculator';
import { generateHtmlReport } from './utils/report-generator';
import { uploadReport } from './utils/s3-uploader';
import { sendSummaryNotification } from './utils/sns-notifier';
import { HealthReport } from './utils/types';

const REPORT_BUCKET = process.env.REPORT_BUCKET_NAME ?? '';
const TOPIC_ARN = process.env.SNS_TOPIC_ARN ?? '';
const DEFAULT_LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? '7');

interface InvocationEvent {
  lookbackDays?: number;
}

interface InvocationResult {
  statusCode: number;
  body: string;
}

async function getAccountId(): Promise<string> {
  try {
    const sts = new STSClient({});
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return identity.Account ?? 'unknown';
  } catch (err) {
    console.error('Could not resolve caller identity', err);
    return 'unknown';
  }
}

/**
 * Lambda entry point. Triggered weekly by EventBridge (see
 * lib/pipeline-health-stack.ts), but can also be invoked manually/on-demand
 * with { "lookbackDays": N } to override the scan window.
 */
export async function handler(event: InvocationEvent = {}): Promise<InvocationResult> {
  const lookbackDays = event.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  if (!REPORT_BUCKET || !TOPIC_ARN) {
    throw new Error('REPORT_BUCKET_NAME and SNS_TOPIC_ARN environment variables are required.');
  }

  console.log(`Starting pipeline health scan. lookbackDays=${lookbackDays}`);

  const [accountId, pipelines, buildProjects] = await Promise.all([
    getAccountId(),
    analyzeAllPipelines(lookbackDays),
    analyzeAllProjects(lookbackDays)
  ]);

  console.log(`Analyzed ${pipelines.length} pipeline(s) and ${buildProjects.length} build project(s).`);

  const doraMetrics = calculateDORAMetrics(pipelines);

  const report: HealthReport = {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    accountId,
    region: process.env.AWS_REGION ?? 'unknown',
    pipelines,
    buildProjects,
    doraMetrics,
    totals: {
      pipelineCount: pipelines.length,
      buildProjectCount: buildProjects.length,
      totalExecutions: pipelines.reduce((sum, p) => sum + p.totalExecutions, 0),
      totalBuilds: buildProjects.reduce((sum, p) => sum + p.totalBuilds, 0)
    }
  };

  console.log(`Overall DORA category: ${doraMetrics.overallCategory}`);

  const html = generateHtmlReport(report);
  const uploadResult = await uploadReport(REPORT_BUCKET, html, new Date(report.generatedAt));
  console.log(`Report uploaded to s3://${uploadResult.bucket}/${uploadResult.key}`);

  const consoleUrl = `https://s3.console.aws.amazon.com/s3/object/${uploadResult.bucket}?prefix=${uploadResult.key}`;
  await sendSummaryNotification(TOPIC_ARN, report, consoleUrl);
  console.log('Summary notification published to SNS.');

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Pipeline health scan complete',
      overallCategory: doraMetrics.overallCategory,
      pipelineCount: report.totals.pipelineCount,
      buildProjectCount: report.totals.buildProjectCount,
      reportKey: uploadResult.key
    })
  };
}

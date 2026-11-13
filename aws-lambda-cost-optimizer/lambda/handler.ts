import type { Context } from 'aws-lambda';
import { LambdaClient, ListFunctionsCommand, FunctionConfiguration, GetProvisionedConcurrencyConfigCommand } from '@aws-sdk/client-lambda';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { S3Client } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';

import { LambdaFunctionProfile, OptimizerReport, LambdaArchitecture } from './utils/types';
import { analyzeMemory } from './analyzers/memory-analyzer';
import { analyzeInvocations } from './analyzers/invocation-analyzer';
import { analyzeColdStarts } from './analyzers/cold-start-analyzer';
import { analyzeArchitecture } from './analyzers/architecture-analyzer';
import { analyzeTimeouts } from './analyzers/timeout-analyzer';
import { generateHtmlReport } from './utils/report-generator';
import { uploadReport } from './utils/s3-uploader';
import { notify } from './utils/sns-notifier';

const PRICE_PER_GB_SECOND_X86 = 0.0000166667;
const PRICE_PER_GB_SECOND_ARM64 = 0.0000133334;

const lambdaClient = new LambdaClient({});
const cloudWatchClient = new CloudWatchClient({});
const s3Client = new S3Client({});
const snsClient = new SNSClient({});

/**
 * Extracts the AWS account ID from the Lambda invocation context's ARN
 * (arn:aws:lambda:<region>:<accountId>:function:<name>) rather than pulling in an STS
 * dependency - the optimizer function's own invocation ARN already carries this information.
 */
function getAccountIdFromContext(context: Context): string {
  const parts = context.invokedFunctionArn?.split(':') ?? [];
  return parts[4] ?? 'unknown';
}

/**
 * Lists every Lambda function in the account/region (handles pagination) and normalizes each
 * into a LambdaFunctionProfile. Also best-effort checks Provisioned Concurrency configuration,
 * but tolerates functions that have none configured (the common case).
 */
async function discoverFunctions(): Promise<LambdaFunctionProfile[]> {
  const profiles: LambdaFunctionProfile[] = [];
  let marker: string | undefined;

  do {
    const response = await lambdaClient.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    const functions: FunctionConfiguration[] = response.Functions ?? [];

    for (const fn of functions) {
      if (!fn.FunctionName || !fn.FunctionArn) continue;

      let hasProvisionedConcurrency = false;
      try {
        const pcConfig = await lambdaClient.send(
          new GetProvisionedConcurrencyConfigCommand({
            FunctionName: fn.FunctionName,
            Qualifier: fn.Version ?? '$LATEST',
          }),
        );
        hasProvisionedConcurrency = (pcConfig.AllocatedProvisionedConcurrentExecutions ?? 0) > 0;
      } catch {
        // ResourceNotFoundException is expected when no PC is configured - ignore.
        hasProvisionedConcurrency = false;
      }

      profiles.push({
        functionName: fn.FunctionName,
        functionArn: fn.FunctionArn,
        runtime: fn.Runtime ?? 'unknown',
        architectures: (fn.Architectures as LambdaArchitecture[] | undefined) ?? ['x86_64'],
        memorySizeMb: fn.MemorySize ?? 128,
        timeoutSeconds: fn.Timeout ?? 3,
        lastModified: fn.LastModified ?? '',
        codeSizeBytes: fn.CodeSize ?? 0,
        packageType: (fn.PackageType as 'Zip' | 'Image') ?? 'Zip',
        hasProvisionedConcurrency,
      });
    }

    marker = response.NextMarker;
  } while (marker);

  return profiles;
}

function computeTotalMonthlySpend(
  functions: LambdaFunctionProfile[],
  monthlyInvocationsByFunction: Map<string, number>,
  averageDurationMsByFunction: Map<string, number>,
): number {
  let total = 0;
  for (const fn of functions) {
    const invocations = monthlyInvocationsByFunction.get(fn.functionName) ?? 0;
    const avgDurationMs = averageDurationMsByFunction.get(fn.functionName) ?? 0;
    const architecture = fn.architectures[0] ?? 'x86_64';
    const pricePerGbSecond = architecture === 'arm64' ? PRICE_PER_GB_SECOND_ARM64 : PRICE_PER_GB_SECOND_X86;
    const memoryGb = fn.memorySizeMb / 1024;
    const gbSeconds = memoryGb * (avgDurationMs / 1000) * invocations;
    total += gbSeconds * pricePerGbSecond;
  }
  return total;
}

export async function handler(
  _event: unknown,
  context: Context,
): Promise<{ statusCode: number; body: string }> {
  const startedAt = Date.now();
  console.log('Starting Lambda Cost Optimizer scan...');

  const lookbackDays = Number(process.env.LOOKBACK_DAYS ?? '14');
  const minInvocations = Number(process.env.MIN_INVOCATIONS ?? '100');
  const reportBucketName = process.env.REPORT_BUCKET_NAME;
  const snsTopicArn = process.env.SNS_TOPIC_ARN;

  if (!reportBucketName || !snsTopicArn) {
    throw new Error('Missing required environment variables REPORT_BUCKET_NAME / SNS_TOPIC_ARN.');
  }

  const accountId = getAccountIdFromContext(context);
  const allFunctions = await discoverFunctions();

  console.log(`Discovered ${allFunctions.length} Lambda functions.`);

  // Invocation analysis runs first - it produces the shared invocation/duration maps that the
  // memory, cold-start, architecture, and timeout analyzers all reuse (avoids duplicate CloudWatch calls).
  const invocationResult = await analyzeInvocations(allFunctions, {
    cloudWatchClient,
    lookbackDays,
  });

  const analyzedFunctions = allFunctions.filter(
    (fn) => (invocationResult.monthlyInvocationsByFunction.get(fn.functionName) ?? 0) >= minInvocations,
  );

  const [memoryRecommendations, coldStartAnalyses, timeoutRecommendations] = await Promise.all([
    analyzeMemory(allFunctions, {
      cloudWatchClient,
      lookbackDays,
      minInvocations,
      monthlyInvocationsByFunction: invocationResult.monthlyInvocationsByFunction,
      averageDurationMsByFunction: invocationResult.averageDurationMsByFunction,
    }),
    analyzeColdStarts(allFunctions, {
      cloudWatchClient,
      lookbackDays,
      monthlyInvocationsByFunction: invocationResult.monthlyInvocationsByFunction,
    }),
    Promise.resolve(
      analyzeTimeouts(allFunctions, {
        averageDurationMsByFunction: invocationResult.averageDurationMsByFunction,
        maxDurationMsByFunction: invocationResult.maxDurationMsByFunction,
        monthlyInvocationsByFunction: invocationResult.monthlyInvocationsByFunction,
        minInvocations,
      }),
    ),
  ]);

  const architectureRecommendations = analyzeArchitecture(allFunctions, {
    monthlyInvocationsByFunction: invocationResult.monthlyInvocationsByFunction,
    averageDurationMsByFunction: invocationResult.averageDurationMsByFunction,
    lookbackDays,
  });

  const totalEstimatedMonthlySpendUsd = computeTotalMonthlySpend(
    allFunctions,
    invocationResult.monthlyInvocationsByFunction,
    invocationResult.averageDurationMsByFunction,
  );

  const totalEstimatedMonthlySavingsUsd =
    memoryRecommendations.reduce((acc, m) => acc + m.estimatedMonthlySavingsUsd, 0) +
    architectureRecommendations.reduce((acc, a) => acc + a.estimatedMonthlySavingsUsd, 0);

  const report: OptimizerReport = {
    generatedAt: new Date().toISOString(),
    accountId,
    region: process.env.AWS_REGION ?? 'unknown',
    lookbackDays,
    minInvocations,
    totalFunctionsScanned: allFunctions.length,
    totalFunctionsAnalyzed: analyzedFunctions.length,
    totalEstimatedMonthlySpendUsd: round2(totalEstimatedMonthlySpendUsd),
    totalEstimatedMonthlySavingsUsd: round2(totalEstimatedMonthlySavingsUsd),
    memoryRecommendations,
    invocationAnalyses: invocationResult.analyses,
    coldStartAnalyses,
    architectureRecommendations,
    timeoutRecommendations,
  };

  const html = generateHtmlReport(report);
  const uploadResult = await uploadReport({
    s3Client,
    bucketName: reportBucketName,
    htmlContent: html,
    generatedAt: new Date(report.generatedAt),
  });

  console.log(`Report uploaded to ${uploadResult.s3Uri}`);

  await notify({
    snsClient,
    topicArn: snsTopicArn,
    report,
    reportS3Uri: uploadResult.s3Uri,
  });

  const durationMs = Date.now() - startedAt;
  console.log(`Scan complete in ${durationMs}ms.`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      functionsScanned: allFunctions.length,
      functionsAnalyzed: analyzedFunctions.length,
      estimatedMonthlySpendUsd: report.totalEstimatedMonthlySpendUsd,
      estimatedMonthlySavingsUsd: report.totalEstimatedMonthlySavingsUsd,
      reportS3Uri: uploadResult.s3Uri,
      durationMs,
    }),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

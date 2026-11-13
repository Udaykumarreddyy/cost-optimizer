import type { Context, ScheduledEvent } from 'aws-lambda';
import { analyzeNatGateways, NAT_GATEWAY_DATA_PROCESSING_RATE_USD_PER_GB } from './analyzers/nat-gateway-analyzer';
import { analyzeCrossAZCosts } from './analyzers/cross-az-analyzer';
import { analyzeVpcEndpoints } from './analyzers/vpc-endpoint-analyzer';
import { analyzeLoadBalancers } from './analyzers/load-balancer-analyzer';
import { analyzeElasticIPs } from './analyzers/elastic-ip-analyzer';
import { generateHtmlReport } from './utils/report-generator';
import { uploadReports } from './utils/s3-uploader';
import { publishSummaryNotification } from './utils/sns-notifier';
import { NetworkCostReport, SavingsRecommendation } from './utils/types';

function accountIdFromContext(context: Context): string {
  // arn:aws:lambda:<region>:<accountId>:function:<name>
  const parts = context.invokedFunctionArn?.split(':') ?? [];
  return parts[4] ?? 'unknown-account';
}

/**
 * Lambda entry point. Runs all five analyzers in parallel where possible,
 * assembles the combined NetworkCostReport, writes HTML + JSON to S3, and
 * publishes a summary notification to SNS.
 */
export async function handler(event: ScheduledEvent | Record<string, unknown>, context: Context): Promise<{
  statusCode: number;
  body: string;
}> {
  const lookbackDays = Number(process.env.LOOKBACK_DAYS ?? '7') || 7;
  const bucketName = process.env.REPORT_BUCKET_NAME;
  const topicArn = process.env.SNS_TOPIC_ARN;

  if (!bucketName || !topicArn) {
    throw new Error('REPORT_BUCKET_NAME and SNS_TOPIC_ARN environment variables are required.');
  }

  console.log(`Starting network cost analysis. lookbackDays=${lookbackDays}`);

  // NAT Gateway + Load Balancer + Elastic IP analyzers only touch EC2/ELB/CloudWatch
  // read-only APIs and are independent of each other, so run them concurrently.
  const [natResult, lbResult, eipResult, crossAzResult] = await Promise.all([
    analyzeNatGateways(lookbackDays),
    analyzeLoadBalancers(lookbackDays),
    analyzeElasticIPs(),
    analyzeCrossAZCosts(lookbackDays),
  ]);

  // VPC endpoint analysis benefits from knowing how much traffic each VPC's
  // NAT Gateways processed, so it runs after the NAT analysis completes.
  const natTrafficGbByVpc = new Map<string, number>();
  for (const nat of natResult.analyses) {
    const existing = natTrafficGbByVpc.get(nat.vpcId) ?? 0;
    natTrafficGbByVpc.set(nat.vpcId, existing + nat.totalGigabytesProcessed);
  }
  const vpcEndpointResult = await analyzeVpcEndpoints(natTrafficGbByVpc);

  const recommendations: SavingsRecommendation[] = [
    ...natResult.recommendations,
    ...crossAzResult.recommendations,
    ...vpcEndpointResult.recommendations,
    ...lbResult.recommendations,
    ...eipResult.recommendations,
  ];

  const natMonthlySpend = natResult.analyses.reduce((acc, n) => acc + n.estimatedMonthlyCostUsd, 0);
  const crossAzMonthlySpend =
    crossAzResult.analysis.lookbackDays > 0
      ? (crossAzResult.analysis.totalCrossAzCostUsd / crossAzResult.analysis.lookbackDays) * 30
      : 0;
  const lbMonthlySpend = lbResult.analyses.reduce((acc, lb) => acc + lb.estimatedMonthlyCostUsd, 0);
  const eipMonthlySpend = eipResult.analyses.reduce((acc, e) => acc + e.estimatedMonthlyCostUsd, 0);
  const interfaceEndpointMonthlySpend = vpcEndpointResult.recommendationsByVpc.reduce(
    (acc, v) => acc + v.existingInterfaceEndpoints.reduce((sum, e) => sum + e.estimatedMonthlyCostUsd, 0),
    0,
  );

  const totalEstimatedMonthlyNetworkSpendUsd =
    natMonthlySpend + crossAzMonthlySpend + lbMonthlySpend + eipMonthlySpend + interfaceEndpointMonthlySpend;
  const totalEstimatedMonthlySavingsUsd = recommendations.reduce(
    (acc, rec) => acc + rec.estimatedMonthlySavingsUsd,
    0,
  );

  const report: NetworkCostReport = {
    generatedAt: new Date().toISOString(),
    accountId: accountIdFromContext(context),
    region: process.env.AWS_REGION ?? 'us-east-1',
    lookbackDays,
    natGateways: natResult.analyses,
    crossAz: crossAzResult.analysis,
    vpcEndpoints: vpcEndpointResult.recommendationsByVpc,
    loadBalancers: lbResult.analyses,
    elasticIps: eipResult.analyses,
    recommendations,
    totalEstimatedMonthlyNetworkSpendUsd,
    totalEstimatedMonthlySavingsUsd,
  };

  const htmlReport = generateHtmlReport(report);
  const { htmlUrl, htmlKey, jsonKey } = await uploadReports(bucketName, report, htmlReport);
  console.log(`Uploaded report. htmlKey=${htmlKey} jsonKey=${jsonKey}`);

  await publishSummaryNotification(topicArn, report, htmlUrl);
  console.log('Published SNS summary notification.');

  // Reference the NAT data-processing rate so it's clearly part of the public
  // contract analyzers rely on (also used in README cost-math examples).
  console.log(`NAT data processing rate in effect: $${NAT_GATEWAY_DATA_PROCESSING_RATE_USD_PER_GB}/GB`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Network cost analysis complete.',
      totalEstimatedMonthlyNetworkSpendUsd,
      totalEstimatedMonthlySavingsUsd,
      recommendationCount: recommendations.length,
      reportUrl: htmlUrl,
    }),
  };
}

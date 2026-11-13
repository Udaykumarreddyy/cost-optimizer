import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  LoadBalancer,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { LoadBalancerAnalysis, SavingsRecommendation } from '../utils/types';

// Published base pricing (us-east-1) for an always-on ALB/NLB, excluding LCU/
// NLCU usage charges. This is the "it's just sitting there" floor cost that
// an idle load balancer still accrues.
const ALB_HOURLY_RATE_USD = 0.0225; // ~$16.20/month
const NLB_HOURLY_RATE_USD = 0.0225; // ~$16.20/month (NLCU-hours billed separately)
const HOURS_PER_MONTH = 24 * 30;

const elbClient = new ElasticLoadBalancingV2Client({});
const cloudWatchClient = new CloudWatchClient({});

async function listLoadBalancers(): Promise<LoadBalancer[]> {
  const loadBalancers: LoadBalancer[] = [];
  let marker: string | undefined;
  do {
    const response = await elbClient.send(new DescribeLoadBalancersCommand({ Marker: marker }));
    loadBalancers.push(...(response.LoadBalancers ?? []));
    marker = response.NextMarker;
  } while (marker);
  return loadBalancers;
}

async function getTargetHealthCounts(
  loadBalancerArn: string,
): Promise<{ healthy: number; unhealthy: number; total: number }> {
  let healthy = 0;
  let unhealthy = 0;
  let total = 0;

  const tgResponse = await elbClient.send(
    new DescribeTargetGroupsCommand({ LoadBalancerArn: loadBalancerArn }),
  );

  for (const targetGroup of tgResponse.TargetGroups ?? []) {
    if (!targetGroup.TargetGroupArn) continue;
    const healthResponse = await elbClient.send(
      new DescribeTargetHealthCommand({ TargetGroupArn: targetGroup.TargetGroupArn }),
    );
    for (const desc of healthResponse.TargetHealthDescriptions ?? []) {
      total += 1;
      const state = desc.TargetHealth?.State;
      if (state === 'healthy') healthy += 1;
      if (state === 'unhealthy') unhealthy += 1;
    }
  }

  return { healthy, unhealthy, total };
}

async function getTrafficMetricSum(
  loadBalancerArn: string,
  type: 'application' | 'network' | 'gateway',
  startTime: Date,
  endTime: Date,
): Promise<number> {
  // ELBv2 CloudWatch dimension value is the trailing part of the ARN, e.g.
  // "app/my-alb/50dc6c495c0c9188" or "net/my-nlb/50dc6c495c0c9188".
  const arnParts = loadBalancerArn.split(':loadbalancer/');
  const dimensionValue = arnParts[1] ?? loadBalancerArn;
  const metricName = type === 'application' ? 'RequestCount' : 'ActiveFlowCount';
  const namespace = type === 'application' ? 'AWS/ApplicationELB' : 'AWS/NetworkELB';
  const stat = type === 'application' ? 'Sum' : 'Average';

  const periodSeconds = Math.max(
    300,
    Math.ceil((endTime.getTime() - startTime.getTime()) / 1000 / 1440) * 60,
  );

  const response = await cloudWatchClient.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        {
          Id: 'traffic',
          MetricStat: {
            Metric: {
              Namespace: namespace,
              MetricName: metricName,
              Dimensions: [{ Name: 'LoadBalancer', Value: dimensionValue }],
            },
            Period: periodSeconds,
            Stat: stat,
          },
          ReturnData: true,
        },
      ],
      ScanBy: 'TimestampAscending',
    }),
  );

  const values = response.MetricDataResults?.[0]?.Values ?? [];
  return values.reduce((acc, v) => acc + v, 0);
}

/**
 * Inventories every ALB/NLB, checks target health, and pulls request/flow
 * traffic over the lookback window to flag load balancers that are running
 * (and billing) but serving essentially no traffic, or whose entire target
 * fleet is unhealthy.
 */
export async function analyzeLoadBalancers(lookbackDays: number): Promise<{
  analyses: LoadBalancerAnalysis[];
  recommendations: SavingsRecommendation[];
}> {
  const loadBalancers = await listLoadBalancers();
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const analyses: LoadBalancerAnalysis[] = [];
  const recommendations: SavingsRecommendation[] = [];

  for (const lb of loadBalancers) {
    if (!lb.LoadBalancerArn || !lb.LoadBalancerName) continue;

    const type = (lb.Type ?? 'application') as 'application' | 'network' | 'gateway';
    const [trafficTotal, targetHealth] = await Promise.all([
      getTrafficMetricSum(lb.LoadBalancerArn, type, startTime, endTime),
      getTargetHealthCounts(lb.LoadBalancerArn),
    ]);

    const hourlyRate = type === 'network' ? NLB_HOURLY_RATE_USD : ALB_HOURLY_RATE_USD;
    const estimatedMonthlyCostUsd = hourlyRate * HOURS_PER_MONTH;

    const isIdle = trafficTotal === 0;
    const allTargetsUnhealthy = targetHealth.total > 0 && targetHealth.healthy === 0;
    const wastedMonthlyCostUsd = isIdle ? estimatedMonthlyCostUsd : 0;

    const notes: string[] = [];
    if (isIdle) {
      notes.push(
        `Zero traffic recorded over the last ${lookbackDays} days, but still billing ~$${estimatedMonthlyCostUsd.toFixed(
          2,
        )}/month in base load balancer charges.`,
      );
    }
    if (allTargetsUnhealthy) {
      notes.push(`All ${targetHealth.total} registered target(s) are unhealthy - this LB cannot serve traffic.`);
    }
    if (targetHealth.total === 0) {
      notes.push('No targets registered to any target group.');
    }

    const analysis: LoadBalancerAnalysis = {
      loadBalancerArn: lb.LoadBalancerArn,
      loadBalancerName: lb.LoadBalancerName,
      type,
      scheme: lb.Scheme ?? 'unknown',
      state: lb.State?.Code ?? 'unknown',
      lookbackDays,
      totalRequestOrFlowCount: trafficTotal,
      healthyHostCount: targetHealth.healthy,
      unhealthyHostCount: targetHealth.unhealthy,
      isIdle,
      allTargetsUnhealthy,
      estimatedMonthlyCostUsd,
      wastedMonthlyCostUsd,
      notes,
    };
    analyses.push(analysis);

    if (isIdle) {
      recommendations.push({
        id: `lb-idle-${lb.LoadBalancerName}`,
        category: 'LOAD_BALANCER',
        severity: 'MEDIUM',
        title: `Idle load balancer: ${lb.LoadBalancerName}`,
        description:
          `${type.toUpperCase()} load balancer "${lb.LoadBalancerName}" received 0 requests/flows in the last ` +
          `${lookbackDays} days but still costs ~$${estimatedMonthlyCostUsd.toFixed(2)}/month ($16-18/mo base charge).`,
        resourceId: lb.LoadBalancerArn,
        estimatedMonthlySavingsUsd: estimatedMonthlyCostUsd,
        actionItems: [
          'Confirm no DNS records, clients, or health checks still point at this load balancer.',
          'Delete the load balancer if it is a leftover from a decommissioned environment.',
          'If it is intentionally idle (e.g. DR standby), consider recreating it on-demand via IaC instead of leaving it running.',
        ],
      });
    }

    if (allTargetsUnhealthy) {
      recommendations.push({
        id: `lb-unhealthy-${lb.LoadBalancerName}`,
        category: 'LOAD_BALANCER',
        severity: 'HIGH',
        title: `All targets unhealthy: ${lb.LoadBalancerName}`,
        description:
          `Load balancer "${lb.LoadBalancerName}" has ${targetHealth.total} registered target(s), all unhealthy. ` +
          'It is both costing money and failing to serve traffic - likely a production issue, not just a cost issue.',
        resourceId: lb.LoadBalancerArn,
        estimatedMonthlySavingsUsd: 0,
        actionItems: [
          'Investigate target health check failures immediately (security groups, health check path/port, app health).',
          'If the service is decommissioned, delete the load balancer and target group to stop paying for a dead endpoint.',
        ],
      });
    }
  }

  return { analyses, recommendations };
}

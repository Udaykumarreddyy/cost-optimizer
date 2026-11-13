import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  ListTaskDefinitionFamiliesCommand,
} from '@aws-sdk/client-ecs';
import { ECSServiceAnalysis, EKSNodeGroupAnalysis, IdleResource } from '../utils/types';

const ecsClient = new ECSClient({});

const IDLE_THRESHOLD_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function listAllClusterArns(): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await ecsClient.send(new ListClustersCommand({ nextToken, maxResults: 100 }));
    arns.push(...(resp.clusterArns ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);
  return arns;
}

async function countServicesInCluster(clusterArn: string): Promise<number> {
  const resp = await ecsClient.send(
    new ListServicesCommand({ cluster: clusterArn, maxResults: 1 })
  );
  // maxResults limits the page, but serviceArns.length tells us whether >=1 exists;
  // for an exact count we'd paginate fully, but presence/absence is all we need here.
  if ((resp.serviceArns ?? []).length > 0) return (resp.serviceArns ?? []).length;
  return 0;
}

/**
 * Returns ACTIVE task definition families that are NOT referenced by any currently
 * active ECS service (across any revision of that family). These are candidates for
 * deregistration - they consume no direct cost but create operational clutter and
 * count against the (soft) 1,000,000 task-definition-revision account limit.
 */
async function findOrphanedTaskDefinitionFamilies(
  serviceAnalyses: ECSServiceAnalysis[]
): Promise<string[]> {
  const referencedFamilies = new Set<string>();
  for (const svc of serviceAnalyses) {
    // ARN format: arn:aws:ecs:region:account:task-definition/family:revision
    const match = svc.taskDefinitionArn.match(/task-definition\/([^:]+):/);
    if (match) referencedFamilies.add(match[1]);
  }

  const allFamilies: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await ecsClient.send(
      new ListTaskDefinitionFamiliesCommand({ status: 'ACTIVE', nextToken, maxResults: 100 })
    );
    allFamilies.push(...(resp.families ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);

  return allFamilies.filter((family) => !referencedFamilies.has(family));
}

/**
 * Estimates how long a service has been sitting at desiredCount=0 using the most
 * recent deployment's updatedAt timestamp as a proxy for "when it was last scaled".
 */
function estimateIdleDays(rawUpdatedAt: Date | undefined): number | null {
  if (!rawUpdatedAt) return null;
  const diffMs = Date.now() - rawUpdatedAt.getTime();
  return Math.floor(diffMs / MS_PER_DAY);
}

export interface IdleResourceDetectorInput {
  serviceAnalyses: ECSServiceAnalysis[];
  nodeGroupAnalyses: EKSNodeGroupAnalysis[];
  /** Map of serviceArn -> last deployment update time, passed through from DescribeServices. */
  serviceLastUpdatedAt: Map<string, Date | undefined>;
}

/**
 * Entry point: aggregates idle/wasted container resources across ECS and EKS:
 *  - ECS services parked at desiredCount=0 for more than IDLE_THRESHOLD_DAYS
 *  - ECS clusters with zero services (dead clusters still billed nothing but
 *    represent config/IAM/log-group clutter worth cleaning up)
 *  - ACTIVE task definition families with no service referencing any revision
 *  - EKS node groups scaled to desiredSize=0 but still provisioned (control plane
 *    cost continues to accrue at $0.10/hr regardless of node count)
 *
 * Fargate and most managed-service costs are billed per running task/node, so most
 * idle resources here carry $0 *direct* compute cost - the value is cleanup and
 * governance (unused IAM roles, log groups, security groups, soft-limit pressure).
 * Where a real recurring cost exists (e.g. EKS control plane continuing to run for
 * a node-group-less cluster), it is reflected in wastedMonthlyCostUsd.
 */
export async function detectIdleResources(
  input: IdleResourceDetectorInput
): Promise<IdleResource[]> {
  const idleResources: IdleResource[] = [];

  // 1. Idle ECS services (desiredCount == 0, idle > 7 days)
  for (const svc of input.serviceAnalyses) {
    if (!svc.isZombie) continue;
    const idleSinceDays = estimateIdleDays(input.serviceLastUpdatedAt.get(svc.serviceArn));
    if (idleSinceDays === null || idleSinceDays >= IDLE_THRESHOLD_DAYS) {
      idleResources.push({
        resourceType: 'idle-ecs-service',
        resourceId: svc.serviceArn || `${svc.clusterName}/${svc.serviceName}`,
        clusterName: svc.clusterName,
        idleSinceDays,
        wastedMonthlyCostUsd: 0,
        details:
          `Service "${svc.serviceName}" in cluster "${svc.clusterName}" has desiredCount=0` +
          (idleSinceDays !== null ? ` for an estimated ${idleSinceDays} day(s).` : ' (idle duration unknown).') +
          ' No running Fargate tasks means no direct compute cost, but the service, its ' +
          'task definition references, and any attached load balancer target groups remain as clutter. Consider deleting if no longer needed.',
      });
    }
  }

  // 2. ECS clusters with zero services
  const clusterArns = await listAllClusterArns();
  for (const clusterArn of clusterArns) {
    const clusterName = clusterArn.split('/').pop() ?? clusterArn;
    const serviceCount = await countServicesInCluster(clusterArn);
    if (serviceCount === 0) {
      idleResources.push({
        resourceType: 'empty-ecs-cluster',
        resourceId: clusterArn,
        clusterName,
        idleSinceDays: null,
        wastedMonthlyCostUsd: 0,
        details: `Cluster "${clusterName}" has zero services. ECS clusters are free to keep, but this likely indicates a decommissioned environment worth removing along with its CloudWatch log groups and IAM roles.`,
      });
    }
  }

  // 3. Orphaned task definition families
  const orphanedFamilies = await findOrphanedTaskDefinitionFamilies(input.serviceAnalyses);
  for (const family of orphanedFamilies) {
    idleResources.push({
      resourceType: 'orphaned-task-definition',
      resourceId: family,
      clusterName: null,
      idleSinceDays: null,
      wastedMonthlyCostUsd: 0,
      details: `Task definition family "${family}" has active revisions but no ECS service currently references any revision of it. Safe to review and deregister if unused.`,
    });
  }

  // 4. EKS node groups scaled to 0 but still provisioned
  for (const ng of input.nodeGroupAnalyses) {
    if (ng.desiredSize === 0) {
      idleResources.push({
        resourceType: 'scaled-to-zero-nodegroup',
        resourceId: ng.nodeGroupArn || `${ng.clusterName}/${ng.nodeGroupName}`,
        clusterName: ng.clusterName,
        idleSinceDays: null,
        wastedMonthlyCostUsd: 0,
        details: `Node group "${ng.nodeGroupName}" in EKS cluster "${ng.clusterName}" is scaled to 0 desired nodes. No EC2 cost is being incurred, but the EKS control plane ($0.10/hr, ~$73/mo) continues to run regardless of node count - if this cluster has no other active node groups, consider whether the cluster itself is still needed.`,
      });
    }
  }

  return idleResources;
}

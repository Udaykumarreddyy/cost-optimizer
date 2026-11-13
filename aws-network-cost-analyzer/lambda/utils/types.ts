/**
 * Shared types for the AWS Network Cost Analyzer.
 */

export interface SavingsRecommendation {
  /** Short machine-friendly id, e.g. "nat-low-traffic-natgw-0123" */
  id: string;
  category: 'NAT_GATEWAY' | 'CROSS_AZ' | 'VPC_ENDPOINT' | 'LOAD_BALANCER' | 'ELASTIC_IP';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  description: string;
  resourceId?: string;
  estimatedMonthlySavingsUsd: number;
  actionItems: string[];
}

export interface NatGatewayMetrics {
  bytesOutToDestination: number;
  bytesOutToSource: number;
  bytesInFromDestination: number;
  bytesInFromSource: number;
  activeConnectionCount: number;
  packetsDropCount: number;
}

export interface NatGatewayAnalysis {
  natGatewayId: string;
  vpcId: string;
  subnetId: string;
  state: string;
  lookbackDays: number;
  metrics: NatGatewayMetrics;
  totalGigabytesProcessed: number;
  hourlyCostUsd: number;
  dataProcessingCostUsd: number;
  estimatedMonthlyCostUsd: number;
  isLowTraffic: boolean;
  recommendsVpcEndpoint: boolean;
  notes: string[];
}

export interface CrossAZServiceCost {
  serviceName: string;
  usageType: string;
  costUsd: number;
  usageAmountGb: number;
}

export interface CrossAZCost {
  lookbackDays: number;
  totalCrossAzCostUsd: number;
  costByService: CrossAZServiceCost[];
  topOffendingServices: CrossAZServiceCost[];
}

export interface VpcEndpointRecommendation {
  vpcId: string;
  hasS3GatewayEndpoint: boolean;
  hasDynamoDbGatewayEndpoint: boolean;
  existingInterfaceEndpoints: {
    serviceName: string;
    vpcEndpointId: string;
    azCount: number;
    estimatedMonthlyCostUsd: number;
  }[];
  natGatewaysInVpc: string[];
  estimatedMonthlySavingsFromGatewayEndpointsUsd: number;
  recommendations: string[];
}

export interface LoadBalancerAnalysis {
  loadBalancerArn: string;
  loadBalancerName: string;
  type: 'application' | 'network' | 'gateway';
  scheme: string;
  state: string;
  lookbackDays: number;
  totalRequestOrFlowCount: number;
  healthyHostCount: number;
  unhealthyHostCount: number;
  isIdle: boolean;
  allTargetsUnhealthy: boolean;
  estimatedMonthlyCostUsd: number;
  wastedMonthlyCostUsd: number;
  notes: string[];
}

export interface ElasticIPAnalysis {
  allocationId: string;
  publicIp: string;
  associationId?: string;
  instanceId?: string;
  networkInterfaceId?: string;
  isAssociated: boolean;
  estimatedMonthlyCostUsd: number;
  isWaste: boolean;
  notes: string[];
}

export interface NetworkCostReport {
  generatedAt: string;
  accountId: string;
  region: string;
  lookbackDays: number;
  natGateways: NatGatewayAnalysis[];
  crossAz: CrossAZCost;
  vpcEndpoints: VpcEndpointRecommendation[];
  loadBalancers: LoadBalancerAnalysis[];
  elasticIps: ElasticIPAnalysis[];
  recommendations: SavingsRecommendation[];
  totalEstimatedMonthlyNetworkSpendUsd: number;
  totalEstimatedMonthlySavingsUsd: number;
}

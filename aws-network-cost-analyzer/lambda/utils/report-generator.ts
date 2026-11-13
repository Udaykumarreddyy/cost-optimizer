import { NetworkCostReport, SavingsRecommendation } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function severityBadge(severity: SavingsRecommendation['severity']): string {
  const colors: Record<SavingsRecommendation['severity'], string> = {
    HIGH: '#d93025',
    MEDIUM: '#e8710a',
    LOW: '#1a73e8',
  };
  return `<span style="background:${colors[severity]};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;">${severity}</span>`;
}

function renderNatGatewayTable(report: NetworkCostReport): string {
  if (report.natGateways.length === 0) {
    return '<p class="empty">No NAT Gateways found in this account/region.</p>';
  }
  const rows = report.natGateways
    .map(
      (n) => `
      <tr>
        <td>${escapeHtml(n.natGatewayId)}</td>
        <td>${escapeHtml(n.vpcId)}</td>
        <td>${n.totalGigabytesProcessed.toFixed(3)} GB</td>
        <td>${usd(n.estimatedMonthlyCostUsd)}</td>
        <td>${n.isLowTraffic ? '&#9888;&#65039; Low traffic' : 'OK'}</td>
      </tr>`,
    )
    .join('');
  return `
    <table>
      <thead><tr><th>NAT Gateway</th><th>VPC</th><th>Data processed (${report.lookbackDays}d)</th><th>Est. monthly cost</th><th>Flag</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderCrossAzTable(report: NetworkCostReport): string {
  if (report.crossAz.costByService.length === 0) {
    return '<p class="empty">No inter-AZ data transfer costs detected.</p>';
  }
  const rows = report.crossAz.costByService
    .map(
      (c) => `
      <tr>
        <td>${escapeHtml(c.serviceName)}</td>
        <td>${escapeHtml(c.usageType)}</td>
        <td>${c.usageAmountGb.toFixed(2)} GB</td>
        <td>${usd(c.costUsd)}</td>
      </tr>`,
    )
    .join('');
  return `
    <table>
      <thead><tr><th>Service</th><th>Usage type</th><th>Usage</th><th>Cost (${report.lookbackDays}d)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderVpcEndpointList(report: NetworkCostReport): string {
  if (report.vpcEndpoints.length === 0) {
    return '<p class="empty">No VPCs found.</p>';
  }
  const items = report.vpcEndpoints
    .filter((v) => v.recommendations.length > 0)
    .map(
      (v) => `
      <li>
        <strong>${escapeHtml(v.vpcId)}</strong> - potential savings ${usd(v.estimatedMonthlySavingsFromGatewayEndpointsUsd)}/mo
        <ul>${v.recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </li>`,
    )
    .join('');
  return items ? `<ul class="vpc-list">${items}</ul>` : '<p class="empty">All VPCs already have recommended gateway endpoints.</p>';
}

function renderLoadBalancerList(report: NetworkCostReport): string {
  const idle = report.loadBalancers.filter((lb) => lb.isIdle || lb.allTargetsUnhealthy);
  if (idle.length === 0) {
    return '<p class="empty">No idle or unhealthy load balancers detected.</p>';
  }
  const rows = idle
    .map(
      (lb) => `
      <tr>
        <td>${escapeHtml(lb.loadBalancerName)}</td>
        <td>${escapeHtml(lb.type)}</td>
        <td>${lb.isIdle ? 'Idle (0 traffic)' : ''} ${lb.allTargetsUnhealthy ? 'All targets unhealthy' : ''}</td>
        <td>${usd(lb.estimatedMonthlyCostUsd)}</td>
      </tr>`,
    )
    .join('');
  return `
    <table>
      <thead><tr><th>Load balancer</th><th>Type</th><th>Issue</th><th>Est. monthly cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderElasticIpList(report: NetworkCostReport): string {
  const wasted = report.elasticIps.filter((e) => e.isWaste);
  if (wasted.length === 0) {
    return '<p class="empty">No unassociated Elastic IPs found.</p>';
  }
  const rows = wasted
    .map(
      (e) => `
      <tr>
        <td>${escapeHtml(e.publicIp)}</td>
        <td>${escapeHtml(e.allocationId)}</td>
        <td>${usd(e.estimatedMonthlyCostUsd)}</td>
      </tr>`,
    )
    .join('');
  return `
    <table>
      <thead><tr><th>Public IP</th><th>Allocation ID</th><th>Monthly cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderRecommendations(report: NetworkCostReport): string {
  if (report.recommendations.length === 0) {
    return '<p class="empty">No recommendations - network footprint looks efficient.</p>';
  }
  const sorted = [...report.recommendations].sort(
    (a, b) => b.estimatedMonthlySavingsUsd - a.estimatedMonthlySavingsUsd,
  );
  const items = sorted
    .map(
      (r) => `
      <div class="rec">
        <div class="rec-header">${severityBadge(r.severity)} <strong>${escapeHtml(r.title)}</strong>
          <span class="rec-savings">${usd(r.estimatedMonthlySavingsUsd)}/mo</span>
        </div>
        <p>${escapeHtml(r.description)}</p>
        <ul>${r.actionItems.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
      </div>`,
    )
    .join('');
  return items;
}

/**
 * Renders the full HTML network cost report: a headline spend/savings card
 * plus one section per analyzer.
 */
export function generateHtmlReport(report: NetworkCostReport): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>AWS Network Cost Report - ${escapeHtml(report.generatedAt)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #f5f6f8; color: #1f2328; margin: 0; padding: 32px; }
  .container { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #57606a; margin-bottom: 24px; font-size: 13px; }
  .cards { display: flex; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
  .card { flex: 1; min-width: 220px; background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card .label { font-size: 12px; color: #57606a; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .value { font-size: 28px; font-weight: 700; margin-top: 6px; }
  .card.savings .value { color: #1a7f37; }
  .card.spend .value { color: #d93025; }
  section { background: #fff; border-radius: 10px; padding: 20px 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h2 { font-size: 16px; margin-top: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eaecef; }
  th { color: #57606a; font-weight: 600; }
  .empty { color: #57606a; font-size: 13px; }
  .rec { border: 1px solid #eaecef; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
  .rec-header { display: flex; align-items: center; gap: 10px; }
  .rec-savings { margin-left: auto; font-weight: 700; color: #1a7f37; }
  .rec ul { margin: 8px 0 0 0; padding-left: 20px; font-size: 13px; color: #40464d; }
  .rec p { margin: 8px 0 0 0; font-size: 13px; color: #40464d; }
  .vpc-list { font-size: 13px; }
  footer { text-align: center; color: #8b949e; font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<div class="container">
  <h1>AWS Network Cost Report</h1>
  <div class="subtitle">Account ${escapeHtml(report.accountId)} &middot; Region ${escapeHtml(report.region)} &middot; Lookback ${report.lookbackDays} days &middot; Generated ${escapeHtml(report.generatedAt)}</div>

  <div class="cards">
    <div class="card spend">
      <div class="label">Est. Monthly Network Spend</div>
      <div class="value">${usd(report.totalEstimatedMonthlyNetworkSpendUsd)}</div>
    </div>
    <div class="card savings">
      <div class="label">Total Potential Savings / mo</div>
      <div class="value">${usd(report.totalEstimatedMonthlySavingsUsd)}</div>
    </div>
    <div class="card">
      <div class="label">Open Recommendations</div>
      <div class="value">${report.recommendations.length}</div>
    </div>
  </div>

  <section>
    <h2>NAT Gateway Cost Breakdown</h2>
    ${renderNatGatewayTable(report)}
  </section>

  <section>
    <h2>Cross-AZ Data Transfer Cost by Service</h2>
    ${renderCrossAzTable(report)}
  </section>

  <section>
    <h2>VPC Endpoint Recommendations</h2>
    ${renderVpcEndpointList(report)}
  </section>

  <section>
    <h2>Idle / Unhealthy Load Balancers</h2>
    ${renderLoadBalancerList(report)}
  </section>

  <section>
    <h2>Unused Elastic IPs</h2>
    ${renderElasticIpList(report)}
  </section>

  <section>
    <h2>All Savings Recommendations</h2>
    ${renderRecommendations(report)}
  </section>

  <footer>Generated by aws-network-cost-analyzer</footer>
</div>
</body>
</html>`;
}

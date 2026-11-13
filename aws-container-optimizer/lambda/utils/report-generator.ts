import { ContainerOptReport } from './types';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Maps a 0-100 utilization percentage to a traffic-light color for the gauge cells. */
function gaugeColor(pct: number | null): string {
  if (pct === null) return '#9e9e9e';
  if (pct < 20) return '#d32f2f'; // red - severely over-provisioned
  if (pct < 40) return '#f9a825'; // amber - over-provisioned
  if (pct <= 75) return '#2e7d32'; // green - healthy
  return '#c62828'; // red - running hot, risk of throttling/OOM
}

function gaugeCell(pct: number | null): string {
  if (pct === null) {
    return `<td style="padding:8px;border:1px solid #ddd;color:#999;">no data</td>`;
  }
  const color = gaugeColor(pct);
  return `
    <td style="padding:8px;border:1px solid #ddd;">
      <div style="background:#eee;border-radius:4px;overflow:hidden;width:120px;height:14px;display:inline-block;vertical-align:middle;">
        <div style="background:${color};width:${Math.min(pct, 100).toFixed(0)}%;height:14px;"></div>
      </div>
      <span style="margin-left:8px;font-weight:600;color:${color};">${pct.toFixed(1)}%</span>
    </td>`;
}

function statusBadge(text: string, color: string): string {
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${esc(text)}</span>`;
}

function renderEcsServiceTable(report: ContainerOptReport): string {
  if (report.ecsServiceAnalyses.length === 0) {
    return '<p style="color:#666;">No ECS services found.</p>';
  }
  const rows = report.ecsServiceAnalyses
    .map((s) => {
      let badge = statusBadge('HEALTHY', '#2e7d32');
      if (s.isFailing) badge = statusBadge('FAILING', '#c62828');
      else if (s.isZombie) badge = statusBadge('ZOMBIE', '#616161');
      else if (s.isOverProvisioned) badge = statusBadge('OVER-PROVISIONED', '#f9a825');

      return `
      <tr>
        <td style="padding:8px;border:1px solid #ddd;">${esc(s.clusterName)}</td>
        <td style="padding:8px;border:1px solid #ddd;font-weight:600;">${esc(s.serviceName)}</td>
        <td style="padding:8px;border:1px solid #ddd;">${esc(s.launchType)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center;">${s.desiredCount} / ${s.runningCount}</td>
        ${gaugeCell(s.cpuUtilization?.average ?? null)}
        ${gaugeCell(s.memoryUtilization?.average ?? null)}
        <td style="padding:8px;border:1px solid #ddd;text-align:right;">${usd(s.estimatedMonthlyCostUsd)}</td>
        <td style="padding:8px;border:1px solid #ddd;">${badge}</td>
      </tr>`;
    })
    .join('');

  return `
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;">
    <thead>
      <tr style="background:#f5f5f5;">
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Cluster</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Service</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Launch Type</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Desired/Running</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Avg CPU (7d)</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Avg Memory (7d)</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:right;">Est. Monthly Cost</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Status</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderRightsizingTable(report: ContainerOptReport): string {
  if (report.taskRightsizings.length === 0) {
    return '<p style="color:#666;">No right-sizing opportunities found - all Fargate task definitions are appropriately sized.</p>';
  }
  const rows = report.taskRightsizings
    .map(
      (t) => `
      <tr>
        <td style="padding:8px;border:1px solid #ddd;">${esc(t.clusterName)}/${esc(t.serviceName)}</td>
        <td style="padding:8px;border:1px solid #ddd;">${esc(t.taskDefinitionFamily)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center;">${t.currentCpuUnits} / ${t.currentMemoryMiB}MiB</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center;font-weight:600;color:#2e7d32;">${t.recommendedCpuUnits} / ${t.recommendedMemoryMiB}MiB</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:right;">${usd(t.currentMonthlyCostUsd)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:right;">${usd(t.recommendedMonthlyCostUsd)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:right;font-weight:700;color:#2e7d32;">${usd(t.monthlySavingsUsd)} (${t.savingsPercent.toFixed(0)}%)</td>
      </tr>`
    )
    .join('');

  return `
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;">
    <thead>
      <tr style="background:#f5f5f5;">
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Service</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Task Family</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:center;">Current</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:center;">Recommended</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:right;">Current $/mo</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:right;">Recommended $/mo</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:right;">Savings</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderEksTable(report: ContainerOptReport): string {
  if (report.eksNodeGroupAnalyses.length === 0) {
    return '<p style="color:#666;">No EKS node groups found.</p>';
  }
  const rows = report.eksNodeGroupAnalyses
    .map((ng) => {
      const flags: string[] = [];
      if (ng.isUnderUtilized) flags.push(statusBadge('UNDER-UTILIZED', '#f9a825'));
      if (ng.spotEligible) flags.push(statusBadge('SPOT-ELIGIBLE', '#1565c0'));
      if (!ng.hasClusterAutoscaler && !ng.hasKarpenter) flags.push(statusBadge('NO AUTOSCALER', '#616161'));
      if (ng.desiredSize === 0) flags.push(statusBadge('SCALED TO 0', '#c62828'));

      return `
      <tr>
        <td style="padding:8px;border:1px solid #ddd;">${esc(ng.clusterName)}</td>
        <td style="padding:8px;border:1px solid #ddd;font-weight:600;">${esc(ng.nodeGroupName)}</td>
        <td style="padding:8px;border:1px solid #ddd;">${esc(ng.instanceTypes.join(', '))}</td>
        <td style="padding:8px;border:1px solid #ddd;">${esc(ng.capacityType)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center;">${ng.desiredSize} (${ng.minSize}-${ng.maxSize})</td>
        ${gaugeCell(ng.cpuUtilization?.average ?? null)}
        <td style="padding:8px;border:1px solid #ddd;text-align:right;">${usd(ng.estimatedMonthlyCostUsd)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:right;color:#2e7d32;font-weight:600;">${usd(ng.potentialMonthlySavingsUsd)}</td>
        <td style="padding:8px;border:1px solid #ddd;">${flags.join(' ')}</td>
      </tr>`;
    })
    .join('');

  return `
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;">
    <thead>
      <tr style="background:#f5f5f5;">
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">EKS Cluster</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Node Group</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Instance Type(s)</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Capacity</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Nodes (min-max)</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Avg CPU (7d)</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:right;">Est. Monthly Cost</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:right;">Potential Savings</th>
        <th style="padding:8px;border:1px solid #ddd;text-align:left;">Flags</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderIdleResourcesList(report: ContainerOptReport): string {
  if (report.idleResources.length === 0) {
    return '<p style="color:#666;">No idle container resources detected.</p>';
  }
  const items = report.idleResources
    .map(
      (r) => `
      <li style="margin-bottom:10px;">
        ${statusBadge(r.resourceType.replace(/-/g, ' ').toUpperCase(), '#616161')}
        <strong>${esc(r.resourceId)}</strong>
        ${r.clusterName ? `<span style="color:#666;"> (cluster: ${esc(r.clusterName)})</span>` : ''}
        <div style="color:#444;font-size:12px;margin-top:2px;">${esc(r.details)}</div>
      </li>`
    )
    .join('');
  return `<ul style="padding-left:16px;">${items}</ul>`;
}

export function generateHtmlReport(report: ContainerOptReport): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Container Cost Optimization Report</title>
</head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#fafafa;margin:0;padding:24px;color:#222;">
  <div style="max-width:1100px;margin:0 auto;">
    <h1 style="margin-bottom:4px;">Container Cost Optimization Report</h1>
    <p style="color:#666;margin-top:0;">
      Generated ${esc(report.generatedAt)} &middot; Account ${esc(report.accountId)} &middot; Region ${esc(report.region)}
    </p>

    <div style="display:flex;gap:16px;flex-wrap:wrap;margin:24px 0;">
      <div style="flex:1;min-width:220px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:20px;">
        <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">Total Est. Monthly Container Spend</div>
        <div style="font-size:28px;font-weight:700;margin-top:4px;">${usd(report.totalEstimatedMonthlySpendUsd)}</div>
      </div>
      <div style="flex:1;min-width:220px;background:#e8f5e9;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:20px;border:2px solid #2e7d32;">
        <div style="color:#2e7d32;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;">Total Potential Monthly Savings</div>
        <div style="font-size:32px;font-weight:800;margin-top:4px;color:#2e7d32;">${usd(report.totalPotentialMonthlySavingsUsd)}</div>
      </div>
      <div style="flex:1;min-width:220px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:20px;">
        <div style="color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">Scanned</div>
        <div style="font-size:16px;margin-top:4px;line-height:1.6;">
          ${report.clustersScanned} ECS cluster(s), ${report.servicesAnalyzed} service(s)<br/>
          ${report.eksClustersScanned} EKS cluster(s), ${report.nodeGroupsAnalyzed} node group(s)
        </div>
      </div>
    </div>

    <h2>ECS Service Utilization</h2>
    ${renderEcsServiceTable(report)}

    <h2 style="margin-top:32px;">Task Right-Sizing Recommendations (Fargate)</h2>
    ${renderRightsizingTable(report)}

    <h2 style="margin-top:32px;">EKS Node Group Utilization</h2>
    ${renderEksTable(report)}

    <h2 style="margin-top:32px;">Idle / Wasted Resources</h2>
    ${renderIdleResourcesList(report)}

    <p style="color:#999;font-size:11px;margin-top:40px;border-top:1px solid #eee;padding-top:12px;">
      Generated by aws-container-optimizer. Pricing based on on-demand Fargate (us-east-1) and representative EC2 on-demand/Spot rates; actual AWS invoices may vary by region, Savings Plans, and Reserved Instance coverage.
    </p>
  </div>
</body>
</html>`;
}

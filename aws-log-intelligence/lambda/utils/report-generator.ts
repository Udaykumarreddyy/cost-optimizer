import { IntelligenceReport, LogGroupAnalysis, ErrorDetection, RetentionRecommendation, IngestionAnalysis } from './types';

/**
 * Renders the IntelligenceReport as a self-contained HTML document (inline CSS, no external
 * dependencies) suitable for upload to S3 and viewing directly in a browser via a presigned
 * URL or public report link.
 */
export function generateHtmlReport(report: IntelligenceReport): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>AWS Log Intelligence Report - ${escapeHtml(report.generatedAt)}</title>
<style>
  :root {
    --bg: #0f172a;
    --card-bg: #ffffff;
    --accent: #2563eb;
    --danger: #dc2626;
    --warn: #d97706;
    --good: #16a34a;
    --text: #111827;
    --muted: #6b7280;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
         margin: 0; padding: 0; background: #f3f4f6; color: var(--text); }
  header { background: var(--bg); color: #fff; padding: 24px 32px; }
  header h1 { margin: 0 0 4px 0; font-size: 22px; }
  header p { margin: 0; color: #cbd5e1; font-size: 13px; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 32px 64px; }
  h2 { font-size: 16px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
       border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-top: 40px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 16px; }
  .card { background: var(--card-bg); border-radius: 10px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .card .value { font-size: 28px; font-weight: 700; margin-top: 6px; }
  .card.savings .value { color: var(--good); }
  .card.cost .value { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; background: #fff; border-radius: 8px;
          overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  th, td { text-align: left; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #f1f5f9; }
  th { background: #f8fafc; color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 11px; }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .badge.spike { background: #fee2e2; color: var(--danger); }
  .badge.no-retention { background: #fef3c7; color: var(--warn); }
  .badge.ok { background: #dcfce7; color: var(--good); }
  .muted { color: var(--muted); font-size: 12px; }
  .empty { padding: 16px; color: var(--muted); font-style: italic; }
  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 24px; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
  .bar-track { flex: 1; background: #e5e7eb; border-radius: 4px; height: 10px; overflow: hidden; }
  .bar-fill { background: var(--accent); height: 10px; }
  .bar-label { width: 260px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-value { width: 90px; font-size: 12px; text-align: right; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>AWS Log Intelligence Report</h1>
  <p>Account ${escapeHtml(report.accountId)} &middot; Region ${escapeHtml(report.region)} &middot; Generated ${escapeHtml(
    report.generatedAt
  )} &middot; ${report.totalLogGroupsScanned} log groups scanned</p>
</header>
<main>

  <h2>Cost Summary</h2>
  <div class="cards">
    <div class="card cost">
      <div class="label">Total Storage Cost</div>
      <div class="value">$${report.costBreakdown.totalMonthlyStorageCost.toFixed(2)}/mo</div>
      <div class="muted">${report.costBreakdown.totalStorageGB.toFixed(1)} GB stored &middot; $0.03/GB</div>
    </div>
    <div class="card cost">
      <div class="label">Total Ingestion Cost</div>
      <div class="value">$${report.costBreakdown.totalMonthlyIngestionCost.toFixed(2)}/mo</div>
      <div class="muted">${report.costBreakdown.totalDailyIngestionGB.toFixed(2)} GB/day avg &middot; $0.50/GB</div>
    </div>
    <div class="card cost">
      <div class="label">Total Estimated Spend</div>
      <div class="value">$${report.costBreakdown.totalEstimatedMonthlySpend.toFixed(2)}/mo</div>
      <div class="muted">storage + ingestion</div>
    </div>
    <div class="card savings">
      <div class="label">Potential Monthly Savings</div>
      <div class="value">$${report.costBreakdown.totalPotentialMonthlySavings.toFixed(2)}/mo</div>
      <div class="muted">from retention policy changes</div>
    </div>
  </div>

  <h2>Top Expensive Log Groups</h2>
  ${renderExpensiveGroupsTable(report.topExpensiveGroups)}

  <h2>Error Spike Alerts</h2>
  ${renderErrorSpikesTable(report.errorSpikes)}

  <h2>Retention Recommendations</h2>
  ${renderRetentionTable(report.retentionRecommendations)}

  <h2>Ingestion Hotspots</h2>
  ${renderIngestionHotspots(report.ingestionHotspots)}

</main>
<footer>Generated automatically by aws-log-intelligence &middot; weekly EventBridge schedule</footer>
</body>
</html>`;
}

function renderExpensiveGroupsTable(groups: LogGroupAnalysis[]): string {
  if (groups.length === 0) {
    return '<div class="empty">No log groups found.</div>';
  }
  const rows = groups
    .map((g) => {
      const retentionBadge = g.hasNoRetention
        ? '<span class="badge no-retention">NO RETENTION</span>'
        : `<span class="badge ok">${g.retentionInDays}d</span>`;
      return `<tr>
        <td>${escapeHtml(g.logGroupName)}</td>
        <td>${g.storedGB.toFixed(2)} GB</td>
        <td>$${g.monthlyStorageCost.toFixed(2)}/mo</td>
        <td>${retentionBadge}</td>
        <td>${g.isLarge ? '<span class="badge no-retention">&gt;10GB</span>' : '<span class="muted">-</span>'}</td>
      </tr>`;
    })
    .join('\n');

  return `<table>
    <thead><tr><th>Log Group</th><th>Stored Size</th><th>Monthly Cost</th><th>Retention</th><th>Flag</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderErrorSpikesTable(spikes: ErrorDetection[]): string {
  if (spikes.length === 0) {
    return '<div class="empty">No error spikes detected in the last 24 hours.</div>';
  }
  const rows = spikes
    .map(
      (s) => `<tr>
        <td>${escapeHtml(s.logGroupName)}</td>
        <td>${s.previousPeriodErrorCount}</td>
        <td>${s.currentPeriodErrorCount}</td>
        <td><span class="badge spike">+${s.percentChange.toFixed(0)}%</span></td>
        <td>${s.errorRatePerHour.toFixed(1)}/hr</td>
      </tr>`
    )
    .join('\n');

  return `<table>
    <thead><tr><th>Log Group</th><th>Previous 24h</th><th>Current 24h</th><th>Change</th><th>Rate</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderRetentionTable(recs: RetentionRecommendation[]): string {
  if (recs.length === 0) {
    return '<div class="empty">All log groups already have a retention policy set.</div>';
  }
  const rows = recs
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.logGroupName)}</td>
        <td><span class="badge no-retention">${escapeHtml(r.currentRetention)}</span></td>
        <td>${r.recommendedRetentionDays} days <span class="muted">(${escapeHtml(r.matchedRule)})</span></td>
        <td>${r.storedGB.toFixed(2)} GB</td>
        <td><span class="badge ok">$${r.estimatedMonthlySavings.toFixed(2)}/mo</span></td>
      </tr>`
    )
    .join('\n');

  return `<table>
    <thead><tr><th>Log Group</th><th>Current</th><th>Recommended</th><th>Stored Size</th><th>Est. Savings</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderIngestionHotspots(hotspots: IngestionAnalysis[]): string {
  if (hotspots.length === 0) {
    return '<div class="empty">No log groups exceeded 1 GB/day average ingestion.</div>';
  }
  const maxGB = Math.max(...hotspots.map((h) => h.avgDailyIngestionGB), 1);
  const bars = hotspots
    .map((h) => {
      const pct = Math.min((h.avgDailyIngestionGB / maxGB) * 100, 100);
      return `<div class="bar-row">
        <div class="bar-label" title="${escapeHtml(h.logGroupName)}">${escapeHtml(h.logGroupName)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="bar-value">${h.avgDailyIngestionGB.toFixed(2)} GB/day</div>
      </div>`;
    })
    .join('\n');

  const rows = hotspots
    .map(
      (h) => `<tr>
        <td>${escapeHtml(h.logGroupName)}</td>
        <td>${h.avgDailyIngestionGB.toFixed(2)} GB</td>
        <td>${h.peakDailyIngestionGB.toFixed(2)} GB</td>
        <td>$${h.estimatedMonthlyIngestionCost.toFixed(2)}/mo</td>
        <td class="muted">${h.recommendation ? escapeHtml(h.recommendation) : '-'}</td>
      </tr>`
    )
    .join('\n');

  return `<div>${bars}</div>
  <table>
    <thead><tr><th>Log Group</th><th>Avg/day</th><th>Peak/day</th><th>Est. Monthly Cost</th><th>Recommendation</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

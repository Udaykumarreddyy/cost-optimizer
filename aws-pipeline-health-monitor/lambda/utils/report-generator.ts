import { BuildProjectHealth, DORACategory, HealthReport, PipelineHealth } from './types';

const CATEGORY_COLORS: Record<DORACategory, { bg: string; fg: string; border: string }> = {
  Elite: { bg: '#e6f4ea', fg: '#1e7e34', border: '#34a853' },
  High: { bg: '#e8f0fe', fg: '#1a53c6', border: '#4285f4' },
  Medium: { bg: '#fef7e0', fg: '#8a6d00', border: '#f4b400' },
  Low: { bg: '#fce8e6', fg: '#c5221f', border: '#ea4335' }
};

function badge(category: DORACategory): string {
  const c = CATEGORY_COLORS[category];
  return `<span class="badge" style="background:${c.bg};color:${c.fg};border:1px solid ${c.border};">${category}</span>`;
}

function statusPillClass(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized.includes('SUCCEED')) return 'pill-success';
  if (normalized.includes('FAIL')) return 'pill-fail';
  if (normalized.includes('TIMED_OUT')) return 'pill-fail';
  if (normalized.includes('IN_PROGRESS') || normalized.includes('INPROGRESS')) return 'pill-progress';
  return 'pill-neutral';
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPipelineRows(pipelines: PipelineHealth[]): string {
  if (pipelines.length === 0) {
    return `<tr><td colspan="7" class="empty-state">No pipelines found in this account/region.</td></tr>`;
  }

  return pipelines
    .sort((a, b) => a.successRatePct - b.successRatePct)
    .map((p) => {
      const mttr = p.meanTimeToRecoveryMinutes !== null ? `${p.meanTimeToRecoveryMinutes} min` : 'n/a';
      return `
        <tr>
          <td>${escapeHtml(p.pipelineName)}</td>
          <td class="num">${p.totalExecutions}</td>
          <td class="num ${p.successRatePct < 70 ? 'cell-warn' : ''}">${p.successRatePct}%</td>
          <td class="num">${p.deploymentsPerWeek}/wk</td>
          <td class="num">${p.averageDurationMinutes} min</td>
          <td class="num">${mttr}</td>
          <td><span class="pill ${statusPillClass(p.lastExecutionStatus)}">${escapeHtml(p.lastExecutionStatus)}</span></td>
        </tr>`;
    })
    .join('\n');
}

function renderBuildRows(projects: BuildProjectHealth[]): string {
  if (projects.length === 0) {
    return `<tr><td colspan="8" class="empty-state">No CodeBuild projects found in this account/region.</td></tr>`;
  }

  return projects
    .sort((a, b) => a.successRatePct - b.successRatePct)
    .map((p) => {
      const phases =
        p.topFailingPhases.length > 0
          ? p.topFailingPhases.map((f) => `${escapeHtml(f.phaseType)} (${f.failureCount})`).join(', ')
          : 'none';
      const p90 = p.p90DurationMinutes !== null ? `${p.p90DurationMinutes} min` : 'n/a';
      return `
        <tr>
          <td>${escapeHtml(p.projectName)}</td>
          <td class="num">${p.totalBuilds}</td>
          <td class="num ${p.successRatePct < 70 ? 'cell-warn' : ''}">${p.successRatePct}%</td>
          <td class="num ${p.timeoutRatePct > 10 ? 'cell-warn' : ''}">${p.timeoutRatePct}%</td>
          <td class="num">${p.averageDurationMinutes} min</td>
          <td class="num">${p90}</td>
          <td>${phases}</td>
          <td><span class="pill ${statusPillClass(p.lastBuildStatus)}">${escapeHtml(p.lastBuildStatus)}</span></td>
        </tr>`;
    })
    .join('\n');
}

function renderFailureTrends(pipelines: PipelineHealth[], projects: BuildProjectHealth[]): string {
  const topFailingPipelines = [...pipelines]
    .filter((p) => p.failedExecutions > 0)
    .sort((a, b) => b.failedExecutions - a.failedExecutions)
    .slice(0, 5);

  const topFailingProjects = [...projects]
    .filter((p) => p.failedBuilds + p.timedOutBuilds > 0)
    .sort((a, b) => b.failedBuilds + b.timedOutBuilds - (a.failedBuilds + a.timedOutBuilds))
    .slice(0, 5);

  const pipelineItems = topFailingPipelines.length
    ? topFailingPipelines
        .map(
          (p) =>
            `<li><strong>${escapeHtml(p.pipelineName)}</strong> - ${p.failedExecutions} failed execution(s), ${p.successRatePct}% success rate</li>`
        )
        .join('\n')
    : '<li>No pipeline failures in this period. Nice work.</li>';

  const buildItems = topFailingProjects.length
    ? topFailingProjects
        .map((p) => {
          const phase = p.topFailingPhases[0];
          const phaseNote = phase ? ` - most common failing phase: ${escapeHtml(phase.phaseType)}` : '';
          return `<li><strong>${escapeHtml(p.projectName)}</strong> - ${p.failedBuilds} failed, ${p.timedOutBuilds} timed out${phaseNote}</li>`;
        })
        .join('\n')
    : '<li>No build failures in this period. Nice work.</li>';

  return `
    <section class="card">
      <h2>Failure Trends</h2>
      <div class="trend-grid">
        <div>
          <h3>Top Failing Pipelines</h3>
          <ul>${pipelineItems}</ul>
        </div>
        <div>
          <h3>Top Failing Build Projects</h3>
          <ul>${buildItems}</ul>
        </div>
      </div>
    </section>`;
}

function renderDoraCards(report: HealthReport): string {
  const m = report.doraMetrics;
  const cards = [m.deploymentFrequency, m.leadTimeForChanges, m.changeFailureRate, m.meanTimeToRecovery];

  return cards
    .map(
      (metric) => `
      <div class="dora-card">
        <div class="dora-card-header">
          <span class="dora-metric-name">${escapeHtml(metric.metricName)}</span>
          ${badge(metric.category)}
        </div>
        <div class="dora-value">${metric.value} <span class="dora-unit">${escapeHtml(metric.unit)}</span></div>
        <div class="dora-benchmark">${escapeHtml(metric.benchmarkDescription)}</div>
      </div>`
    )
    .join('\n');
}

/**
 * Render the full self-contained HTML report (inline CSS, no external
 * assets) for the given health report.
 */
export function generateHtmlReport(report: HealthReport): string {
  const overall = report.doraMetrics.overallCategory;
  const overallColor = CATEGORY_COLORS[overall];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>AWS Pipeline Health Report - ${escapeHtml(report.generatedAt)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 0;
    background: #f5f6f8;
    color: #202124;
  }
  header {
    background: linear-gradient(135deg, #1a237e, #283593);
    color: #fff;
    padding: 32px 40px;
  }
  header h1 { margin: 0 0 8px; font-size: 26px; }
  header p { margin: 0; opacity: 0.85; font-size: 14px; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 20px 60px; }
  .card {
    background: #fff;
    border-radius: 10px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    padding: 24px;
    margin-bottom: 24px;
  }
  .card h2 { margin-top: 0; font-size: 18px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
  .overall-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-radius: 10px;
    margin-bottom: 24px;
    background: ${overallColor.bg};
    border: 1px solid ${overallColor.border};
  }
  .overall-banner .label { font-size: 14px; color: #444; }
  .overall-banner .category { font-size: 22px; font-weight: 700; color: ${overallColor.fg}; }
  .dora-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
  }
  .dora-card {
    border: 1px solid #e0e0e0;
    border-radius: 10px;
    padding: 16px;
    background: #fafafa;
  }
  .dora-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }
  .dora-metric-name { font-size: 13px; font-weight: 600; color: #444; }
  .dora-value { font-size: 28px; font-weight: 700; color: #1a237e; }
  .dora-unit { font-size: 13px; font-weight: 400; color: #777; }
  .dora-benchmark { margin-top: 8px; font-size: 12px; color: #777; }
  .badge {
    font-size: 11px;
    font-weight: 700;
    padding: 3px 9px;
    border-radius: 12px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #eee; }
  th { color: #555; font-weight: 600; background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.cell-warn { color: #c5221f; font-weight: 600; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .pill-success { background: #e6f4ea; color: #1e7e34; }
  .pill-fail { background: #fce8e6; color: #c5221f; }
  .pill-progress { background: #e8f0fe; color: #1a53c6; }
  .pill-neutral { background: #eee; color: #555; }
  .empty-state { text-align: center; color: #888; padding: 24px; }
  .trend-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .trend-grid h3 { font-size: 14px; margin: 0 0 8px; }
  .trend-grid ul { margin: 0; padding-left: 18px; font-size: 13px; }
  .trend-grid li { margin-bottom: 6px; }
  .summary-stats { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
  .summary-stat { flex: 1; min-width: 140px; }
  .summary-stat .value { font-size: 24px; font-weight: 700; color: #1a237e; }
  .summary-stat .label { font-size: 12px; color: #777; }
  footer { text-align: center; color: #999; font-size: 12px; padding: 20px; }
  @media (max-width: 800px) {
    .dora-grid { grid-template-columns: repeat(2, 1fr); }
    .trend-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header>
  <h1>AWS Pipeline &amp; Build Health Report</h1>
  <p>Generated ${escapeHtml(report.generatedAt)} &middot; Account ${escapeHtml(report.accountId)} &middot; Region ${escapeHtml(report.region)} &middot; Lookback ${report.lookbackDays} day(s)</p>
</header>
<main>

  <div class="overall-banner">
    <div>
      <div class="label">Overall DORA Performance</div>
      <div class="category">${overall} Performer</div>
    </div>
    ${badge(overall)}
  </div>

  <section class="card">
    <h2>Scan Summary</h2>
    <div class="summary-stats">
      <div class="summary-stat"><div class="value">${report.totals.pipelineCount}</div><div class="label">Pipelines Scanned</div></div>
      <div class="summary-stat"><div class="value">${report.totals.buildProjectCount}</div><div class="label">Build Projects Scanned</div></div>
      <div class="summary-stat"><div class="value">${report.totals.totalExecutions}</div><div class="label">Pipeline Executions</div></div>
      <div class="summary-stat"><div class="value">${report.totals.totalBuilds}</div><div class="label">Builds Analyzed</div></div>
    </div>
  </section>

  <section class="card">
    <h2>DORA Metrics</h2>
    <div class="dora-grid">
      ${renderDoraCards(report)}
    </div>
  </section>

  <section class="card">
    <h2>Pipeline Health</h2>
    <table>
      <thead>
        <tr>
          <th>Pipeline</th>
          <th class="num">Executions</th>
          <th class="num">Success Rate</th>
          <th class="num">Deploy Frequency</th>
          <th class="num">Avg Duration</th>
          <th class="num">MTTR</th>
          <th>Last Status</th>
        </tr>
      </thead>
      <tbody>
        ${renderPipelineRows(report.pipelines)}
      </tbody>
    </table>
  </section>

  <section class="card">
    <h2>CodeBuild Project Health</h2>
    <table>
      <thead>
        <tr>
          <th>Project</th>
          <th class="num">Builds</th>
          <th class="num">Success Rate</th>
          <th class="num">Timeout Rate</th>
          <th class="num">Avg Duration</th>
          <th class="num">P90 Duration</th>
          <th>Top Failing Phases</th>
          <th>Last Status</th>
        </tr>
      </thead>
      <tbody>
        ${renderBuildRows(report.buildProjects)}
      </tbody>
    </table>
  </section>

  ${renderFailureTrends(report.pipelines, report.buildProjects)}

</main>
<footer>
  aws-pipeline-health-monitor &middot; automatically generated, no action required unless metrics are trending Low
</footer>
</body>
</html>`;
}

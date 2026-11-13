import { OptimizerReport } from './types';

/**
 * Renders the full OptimizerReport as a self-contained HTML document (inline CSS, no external
 * assets) so it can be uploaded as a single object to S3 and opened directly in a browser.
 */

function esc(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function badge(text: string, kind: 'ok' | 'warn' | 'bad'): string {
  const colors: Record<string, string> = {
    ok: '#1a7f37',
    warn: '#9a6700',
    bad: '#cf222e',
  };
  const bg: Record<string, string> = {
    ok: '#dafbe1',
    warn: '#fff8c5',
    bad: '#ffebe9',
  };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;color:${colors[kind]};background:${bg[kind]};">${esc(
    text,
  )}</span>`;
}

function summaryCard(label: string, value: string, sub?: string): string {
  return `
    <div style="flex:1;min-width:200px;background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:16px 20px;">
      <div style="font-size:13px;color:#57606a;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
      <div style="font-size:28px;font-weight:700;color:#1f2328;margin-top:4px;">${esc(value)}</div>
      ${sub ? `<div style="font-size:13px;color:#57606a;margin-top:4px;">${esc(sub)}</div>` : ''}
    </div>`;
}

function tableWrapper(title: string, description: string, tableHtml: string): string {
  return `
    <section style="margin-top:32px;">
      <h2 style="font-size:18px;margin-bottom:4px;">${esc(title)}</h2>
      <p style="color:#57606a;font-size:13px;margin-top:0;margin-bottom:12px;">${esc(description)}</p>
      <div style="overflow-x:auto;border:1px solid #e1e4e8;border-radius:8px;">
        ${tableHtml}
      </div>
    </section>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return `<div style="padding:20px;color:#57606a;font-size:14px;">No functions matched this check. &#x1F389;</div>`;
  }
  const thead = headers.map((h) => `<th style="text-align:left;padding:10px 14px;border-bottom:1px solid #e1e4e8;font-size:12px;color:#57606a;text-transform:uppercase;">${esc(h)}</th>`).join('');
  const tbody = rows
    .map(
      (row, i) =>
        `<tr style="background:${i % 2 === 0 ? '#fff' : '#f6f8fa'};">${row
          .map((cell) => `<td style="padding:10px 14px;border-bottom:1px solid #eaeef2;font-size:13px;">${cell}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;">
    <thead><tr>${thead}</tr></thead>
    <tbody>${tbody}</tbody>
  </table>`;
}

export function generateHtmlReport(report: OptimizerReport): string {
  const overProvisioned = report.memoryRecommendations.filter((m) => m.isOverProvisioned);
  const deadFunctions = report.invocationAnalyses.filter((i) => i.isDeadFunction);
  const highErrorFunctions = report.invocationAnalyses.filter((i) => i.hasHighErrorRate);
  const throttled = report.invocationAnalyses.filter((i) => i.isHighlyThrottled);
  const coldStartHotspots = report.coldStartAnalyses.filter((c) => c.hasSlowColdStart || c.hasFrequentColdStarts);
  const armCandidates = report.architectureRecommendations.filter((a) => a.isGravitonCompatible);
  const timeoutIssues = report.timeoutRecommendations.filter((t) => t.isTimeoutExcessive || t.isReliabilityRisk);

  const memoryTable = table(
    ['Function', 'Current', 'Used (est.)', 'Utilization', 'Recommended', 'Monthly Savings', 'Confidence'],
    overProvisioned.map((m) => [
      esc(m.functionName),
      `${m.configuredMemoryMb} MB`,
      `${m.estimatedMaxMemoryUsedMb} MB`,
      `${m.memoryUtilizationPct}%`,
      `${m.recommendedMemoryMb} MB`,
      `<strong>${formatUsd(m.estimatedMonthlySavingsUsd)}</strong> (${m.savingsPct}%)`,
      badge(m.confidence, m.confidence === 'high' ? 'ok' : 'warn'),
    ]),
  );

  const deadTable = table(
    ['Function', 'Invocations (window)', 'Est. Monthly Storage Cost'],
    deadFunctions.map((d) => [
      esc(d.functionName),
      String(d.invocationCount),
      d.estimatedMonthlyStorageCostUsd !== undefined ? formatUsd(d.estimatedMonthlyStorageCostUsd) : 'n/a',
    ]),
  );

  const errorTable = table(
    ['Function', 'Invocations', 'Errors', 'Error Rate', 'Throttle Rate'],
    highErrorFunctions.map((e) => [
      esc(e.functionName),
      String(e.invocationCount),
      String(e.errorCount),
      badge(`${e.errorRatePct}%`, 'bad'),
      `${e.throttleRatePct}%`,
    ]),
  );

  const throttleTable = table(
    ['Function', 'Invocations', 'Throttles', 'Throttle Rate'],
    throttled.map((t) => [esc(t.functionName), String(t.invocationCount), String(t.throttleCount), badge(`${t.throttleRatePct}%`, 'bad')]),
  );

  const coldStartTable = table(
    ['Function', 'Avg Cold Start', 'Cold Start Ratio', 'Recommend PC', 'PC Units', 'Current Cold-Start Cost/mo', 'PC Cost/mo'],
    coldStartHotspots.map((c) => [
      esc(c.functionName),
      `${c.averageColdStartMs} ms`,
      badge(`${c.coldStartRatioPct}%`, c.coldStartRatioPct > 30 ? 'warn' : 'ok'),
      c.provisionedConcurrencyRecommended ? badge('Yes', 'warn') : badge('No', 'ok'),
      String(c.recommendedProvisionedConcurrencyUnits),
      formatUsd(c.estimatedMonthlyColdStartCostUsd),
      formatUsd(c.estimatedProvisionedConcurrencyCostUsd),
    ]),
  );

  const armTable = table(
    ['Function', 'Runtime', 'Current Arch', 'Monthly Savings', 'Savings %'],
    armCandidates.map((a) => [
      esc(a.functionName),
      esc(a.runtime),
      esc(a.currentArchitecture),
      `<strong>${formatUsd(a.estimatedMonthlySavingsUsd)}</strong>`,
      `${a.savingsPct}%`,
    ]),
  );

  const timeoutTable = table(
    ['Function', 'Configured Timeout', 'Avg Duration', 'Max Duration', 'Timeout/Avg Ratio', 'Recommended', 'Risk'],
    timeoutIssues.map((t) => [
      esc(t.functionName),
      `${t.configuredTimeoutSeconds}s`,
      `${t.averageDurationMs} ms`,
      `${t.maxDurationMs} ms`,
      `${t.timeoutToAverageRatio}x`,
      `${t.recommendedTimeoutSeconds}s`,
      t.isReliabilityRisk ? badge('Zombie risk', 'bad') : badge('Excessive', 'warn'),
    ]),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Lambda Cost Optimizer Report - ${esc(report.generatedAt)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2328;">
  <div style="max-width:1100px;margin:0 auto;padding:32px 20px 60px;">
    <header>
      <h1 style="margin-bottom:4px;">AWS Lambda Cost Optimizer</h1>
      <p style="color:#57606a;margin-top:0;">
        Account <strong>${esc(report.accountId)}</strong> &middot; Region <strong>${esc(report.region)}</strong> &middot;
        Generated ${esc(report.generatedAt)} &middot; Lookback ${esc(report.lookbackDays)} days
      </p>
    </header>

    <div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:20px;">
      ${summaryCard('Functions Scanned', String(report.totalFunctionsScanned))}
      ${summaryCard('Functions Analyzed', String(report.totalFunctionsAnalyzed), `>= ${report.minInvocations} invocations in window`)}
      ${summaryCard('Est. Monthly Spend', formatUsd(report.totalEstimatedMonthlySpendUsd))}
      ${summaryCard('Est. Monthly Savings', formatUsd(report.totalEstimatedMonthlySavingsUsd), 'if all recommendations applied')}
    </div>

    ${tableWrapper(
      'Memory Right-Sizing',
      'Functions using less than 40% of configured memory. Recommended size = actual usage rounded up to nearest 128MB + 20% buffer.',
      memoryTable,
    )}

    ${tableWrapper(
      'Dead Functions',
      'Zero invocations across the entire lookback window. Still billed for code/layer storage and represent unmanaged operational risk.',
      deadTable,
    )}

    ${tableWrapper('High Error Rate', 'Functions with an error rate above 5% over the lookback window.', errorTable)}

    ${tableWrapper('Highly Throttled Functions', 'Functions with a throttle rate above 1% - check reserved/account concurrency limits.', throttleTable)}

    ${tableWrapper(
      'Cold Start Hotspots',
      'Average cold start > 3,000ms and/or cold starts affecting more than 30% of invocations. Provisioned Concurrency cost shown for comparison.',
      coldStartTable,
    )}

    ${tableWrapper(
      'ARM64 / Graviton2 Migration Candidates',
      'x86_64 functions on a Graviton2-compatible runtime. Switching architecture is a ~20% GB-second cost reduction with equal or better performance for most workloads.',
      armTable,
    )}

    ${tableWrapper(
      'Timeout Recommendations',
      'Configured timeout far exceeds actual execution time. Not a direct cost issue, but a reliability risk - a hung invocation can run for the full timeout ("zombie function").',
      timeoutTable,
    )}

    <footer style="margin-top:40px;color:#8b949e;font-size:12px;border-top:1px solid #e1e4e8;padding-top:16px;">
      Generated automatically by aws-lambda-cost-optimizer. Pricing assumptions: on-demand us-east-1 rates,
      $0.0000166667/GB-second (x86_64), $0.0000133334/GB-second (arm64). Figures are estimates for prioritization,
      not a substitute for AWS Cost Explorer / Billing data.
    </footer>
  </div>
</body>
</html>`;
}

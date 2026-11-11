/**
 * HTML Report Generator
 *
 * Creates a professional HTML report with:
 * - Executive summary with total savings
 * - Table for each scan category
 * - Color-coded severity
 * - Timestamp and scan duration
 */
import { ScanResult } from "./types";

export function generateHtmlReport(
  results: ScanResult[],
  totalEstimatedSavings: number,
  durationMs: number
): string {
  const scanDate = new Date().toISOString().split("T")[0];
  const scanTime = new Date().toLocaleTimeString("en-US", { hour12: true });
  const totalIssues = results.reduce((sum, r) => sum + r.items.length, 0);

  let categorySections = "";

  for (const result of results) {
    const categoryTotal = result.items.reduce(
      (sum, item) => sum + (item.estimatedMonthlyCost || 0),
      0
    );

    let tableRows = "";
    if (result.error) {
      tableRows = `<tr><td colspan="5" class="error">Scanner error: ${escapeHtml(result.error)}</td></tr>`;
    } else if (result.items.length === 0) {
      tableRows = `<tr><td colspan="5" class="clean">No issues found — all clean!</td></tr>`;
    } else {
      for (const item of result.items) {
        const detailsList = Object.entries(item.details)
          .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`)
          .join("<br/>");

        tableRows += `
          <tr>
            <td><code>${escapeHtml(item.resourceId)}</code></td>
            <td>${escapeHtml(item.region)}</td>
            <td>${escapeHtml(item.reason)}</td>
            <td class="cost">$${item.estimatedMonthlyCost.toFixed(2)}</td>
            <td class="details">${detailsList}</td>
          </tr>`;
      }
    }

    const statusBadge =
      result.items.length === 0
        ? '<span class="badge green">CLEAN</span>'
        : `<span class="badge red">${result.items.length} ISSUE${result.items.length > 1 ? "S" : ""}</span>`;

    categorySections += `
      <div class="category">
        <h2>${escapeHtml(result.category)} ${statusBadge}
          <span class="cat-cost">${result.items.length > 0 ? `$${categoryTotal.toFixed(2)}/mo` : ""}</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>Resource ID</th>
              <th>Region</th>
              <th>Reason</th>
              <th>Est. Cost/mo</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AWS Cost Optimizer Report — ${scanDate}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    .header { background: linear-gradient(135deg, #1a237e, #0d47a1); color: white; padding: 30px; border-radius: 12px; margin-bottom: 20px; }
    .header h1 { font-size: 28px; margin-bottom: 8px; }
    .header p { opacity: 0.85; font-size: 14px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; }
    .card .value { font-size: 32px; font-weight: 700; color: #1a237e; }
    .card .label { font-size: 13px; color: #666; margin-top: 4px; }
    .card.savings .value { color: #c62828; }
    .category { background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; overflow: hidden; }
    .category h2 { padding: 16px 20px; background: #fafafa; border-bottom: 1px solid #eee; font-size: 18px; display: flex; align-items: center; gap: 12px; }
    .cat-cost { margin-left: auto; font-size: 14px; color: #c62828; font-weight: 600; }
    .badge { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; }
    .badge.red { background: #ffebee; color: #c62828; }
    .badge.green { background: #e8f5e9; color: #2e7d32; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #f5f5f5; padding: 10px 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e0e0e0; }
    td { padding: 10px 12px; border-bottom: 1px solid #eee; vertical-align: top; }
    td code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .cost { font-weight: 600; color: #c62828; white-space: nowrap; }
    .details { font-size: 12px; color: #666; line-height: 1.6; }
    .clean { text-align: center; padding: 20px; color: #2e7d32; font-weight: 500; }
    .error { text-align: center; padding: 20px; color: #c62828; }
    .footer { text-align: center; padding: 20px; color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>AWS Cost Optimizer Report</h1>
      <p>Scan Date: ${scanDate} at ${scanTime} | Duration: ${(durationMs / 1000).toFixed(1)}s</p>
    </div>

    <div class="summary">
      <div class="card">
        <div class="value">${totalIssues}</div>
        <div class="label">Total Issues Found</div>
      </div>
      <div class="card savings">
        <div class="value">$${totalEstimatedSavings.toFixed(2)}</div>
        <div class="label">Estimated Monthly Savings</div>
      </div>
      <div class="card">
        <div class="value">${results.length}</div>
        <div class="label">Categories Scanned</div>
      </div>
      <div class="card">
        <div class="value">$${(totalEstimatedSavings * 12).toFixed(0)}</div>
        <div class="label">Potential Annual Savings</div>
      </div>
    </div>

    ${categorySections}

    <div class="footer">
      Generated by AWS Cost Optimizer | Account: ${process.env.AWS_ACCOUNT_ID || "N/A"} | Region: ${process.env.AWS_REGION || "N/A"}
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

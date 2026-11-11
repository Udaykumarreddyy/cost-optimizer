/**
 * SNS Notifier — Sends a summary email notification
 *
 * The email includes:
 * - Total issues found per category
 * - Estimated monthly savings
 * - Link to the full HTML report in S3
 */
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { ScanResult } from "./types";

const sns = new SNSClient({});

export async function sendSnsNotification(
  results: ScanResult[],
  totalIssues: number,
  totalSavings: number,
  reportUrl: string
): Promise<void> {
  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    throw new Error("SNS_TOPIC_ARN environment variable is not set");
  }

  const scanDate = new Date().toISOString().split("T")[0];

  // Build category breakdown
  const breakdown = results
    .map((r) => {
      const count = r.items.length;
      const cost = r.items.reduce((s, i) => s + (i.estimatedMonthlyCost || 0), 0);
      const status = count === 0 ? "CLEAN" : `${count} issue(s) — $${cost.toFixed(2)}/mo`;
      return `  ${r.category}: ${status}`;
    })
    .join("\n");

  const subject =
    totalIssues === 0
      ? `[Cost Optimizer] All Clean — ${scanDate}`
      : `[Cost Optimizer] ${totalIssues} Issues Found — Save $${totalSavings.toFixed(2)}/mo`;

  const message = `
AWS Cost Optimizer — Weekly Report
====================================
Date: ${scanDate}
Total Issues: ${totalIssues}
Estimated Monthly Savings: $${totalSavings.toFixed(2)}
Estimated Annual Savings:  $${(totalSavings * 12).toFixed(2)}

Category Breakdown:
${breakdown}

Full Report: ${reportUrl}

---
To view the report, download it from S3:
  aws s3 cp ${reportUrl} ./report.html && open report.html

To stop receiving these emails, unsubscribe from the SNS topic
or disable the EventBridge rule "cost-optimizer-weekly".
`.trim();

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject,
      Message: message,
    })
  );
}

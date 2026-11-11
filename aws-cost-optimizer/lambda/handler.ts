/**
 * AWS Cost Optimizer — Main Lambda Handler
 *
 * Orchestrates all resource scanners, generates an HTML report,
 * uploads it to S3, and sends a summary via SNS email.
 */
import { scanIdleEC2Instances } from "./scanners/ec2-scanner";
import { scanUnusedEBSVolumes } from "./scanners/ebs-scanner";
import { scanUnattachedEIPs } from "./scanners/eip-scanner";
import { scanOldSnapshots } from "./scanners/snapshot-scanner";
import { scanEmptyS3Buckets } from "./scanners/s3-scanner";
import { generateHtmlReport } from "./utils/report-generator";
import { uploadToS3 } from "./utils/s3-uploader";
import { sendSnsNotification } from "./utils/sns-notifier";
import { ScanResult } from "./utils/types";

export const handler = async (): Promise<void> => {
  console.log("=== AWS Cost Optimizer Scan Started ===");
  const startTime = Date.now();

  const results: ScanResult[] = [];

  // ─── Run all scanners ───────────────────────────────────────
  try {
    console.log("[1/5] Scanning idle EC2 instances...");
    const ec2Results = await scanIdleEC2Instances();
    results.push(ec2Results);
    console.log(`  Found ${ec2Results.items.length} idle EC2 instances`);
  } catch (err) {
    console.error("EC2 scan failed:", err);
    results.push({ category: "Idle EC2 Instances", items: [], error: String(err) });
  }

  try {
    console.log("[2/5] Scanning unused EBS volumes...");
    const ebsResults = await scanUnusedEBSVolumes();
    results.push(ebsResults);
    console.log(`  Found ${ebsResults.items.length} unused EBS volumes`);
  } catch (err) {
    console.error("EBS scan failed:", err);
    results.push({ category: "Unused EBS Volumes", items: [], error: String(err) });
  }

  try {
    console.log("[3/5] Scanning unattached Elastic IPs...");
    const eipResults = await scanUnattachedEIPs();
    results.push(eipResults);
    console.log(`  Found ${eipResults.items.length} unattached EIPs`);
  } catch (err) {
    console.error("EIP scan failed:", err);
    results.push({ category: "Unattached Elastic IPs", items: [], error: String(err) });
  }

  try {
    console.log("[4/5] Scanning old EBS snapshots...");
    const snapResults = await scanOldSnapshots();
    results.push(snapResults);
    console.log(`  Found ${snapResults.items.length} old snapshots`);
  } catch (err) {
    console.error("Snapshot scan failed:", err);
    results.push({ category: "Old EBS Snapshots", items: [], error: String(err) });
  }

  try {
    console.log("[5/5] Scanning empty S3 buckets...");
    const s3Results = await scanEmptyS3Buckets();
    results.push(s3Results);
    console.log(`  Found ${s3Results.items.length} empty S3 buckets`);
  } catch (err) {
    console.error("S3 scan failed:", err);
    results.push({ category: "Empty S3 Buckets", items: [], error: String(err) });
  }

  // ─── Generate report ────────────────────────────────────────
  const totalIssues = results.reduce((sum, r) => sum + r.items.length, 0);
  const totalEstimatedSavings = results.reduce(
    (sum, r) => sum + r.items.reduce((s, item) => s + (item.estimatedMonthlyCost || 0), 0),
    0
  );

  const durationMs = Date.now() - startTime;
  console.log(`Scan completed in ${(durationMs / 1000).toFixed(1)}s — ${totalIssues} issues found`);

  // Generate HTML report
  const htmlReport = generateHtmlReport(results, totalEstimatedSavings, durationMs);

  // Upload to S3
  const reportUrl = await uploadToS3(htmlReport);
  console.log(`Report uploaded: ${reportUrl}`);

  // Send SNS notification
  await sendSnsNotification(results, totalIssues, totalEstimatedSavings, reportUrl);
  console.log("SNS notification sent");

  console.log("=== AWS Cost Optimizer Scan Completed ===");
};

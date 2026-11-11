/**
 * S3 Uploader — Uploads the HTML report to the reports bucket
 *
 * Files are stored with a date-based key so you get a history:
 *   reports/2026-11-11/cost-report.html
 *   reports/2026-11-18/cost-report.html
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export async function uploadToS3(htmlContent: string): Promise<string> {
  const bucket = process.env.REPORT_BUCKET;
  if (!bucket) {
    throw new Error("REPORT_BUCKET environment variable is not set");
  }

  const today = new Date().toISOString().split("T")[0]; // 2026-11-11
  const key = `reports/${today}/cost-report.html`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: htmlContent,
      ContentType: "text/html",
      Metadata: {
        "generated-by": "aws-cost-optimizer",
        "scan-date": today,
      },
    })
  );

  return `s3://${bucket}/${key}`;
}

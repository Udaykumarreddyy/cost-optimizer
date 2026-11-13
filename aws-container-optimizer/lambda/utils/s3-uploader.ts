import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});

/**
 * Builds a date-partitioned S3 key so reports can be browsed/queried by date
 * (e.g. with S3 Select, Athena, or just the console), and uploads the HTML report.
 * Example key: reports/2026/11/13/container-optimizer-report-2026-11-13T08-00-00Z.html
 */
export function buildReportKey(date: Date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const timestamp = date.toISOString().replace(/[:.]/g, '-');
  return `reports/${yyyy}/${mm}/${dd}/container-optimizer-report-${timestamp}.html`;
}

export async function uploadReport(
  bucketName: string,
  htmlContent: string,
  date: Date = new Date()
): Promise<{ key: string; bucket: string }> {
  const key = buildReportKey(date);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: htmlContent,
      ContentType: 'text/html',
      ServerSideEncryption: 'AES256',
      Metadata: {
        'generated-by': 'aws-container-optimizer',
        'generated-at': date.toISOString(),
      },
    })
  );

  return { key, bucket: bucketName };
}

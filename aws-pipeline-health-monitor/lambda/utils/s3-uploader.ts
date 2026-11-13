import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export interface UploadResult {
  bucket: string;
  key: string;
  url: string;
}

/**
 * Upload the generated HTML report to S3 under a date-partitioned key, e.g.
 * reports/2026/11/13/pipeline-health-report-2026-11-13T08-00-00Z.html
 *
 * Also writes/overwrites a "latest.html" pointer at the root of the reports
 * prefix so there's always a stable link to the most recent report.
 */
export async function uploadReport(
  bucketName: string,
  htmlContent: string,
  generatedAt: Date = new Date()
): Promise<UploadResult> {
  const year = generatedAt.getUTCFullYear();
  const month = String(generatedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(generatedAt.getUTCDate()).padStart(2, '0');
  const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');

  const key = `reports/${year}/${month}/${day}/pipeline-health-report-${timestamp}.html`;
  const latestKey = 'reports/latest.html';

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: htmlContent,
      ContentType: 'text/html; charset=utf-8',
      CacheControl: 'no-cache'
    })
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: latestKey,
      Body: htmlContent,
      ContentType: 'text/html; charset=utf-8',
      CacheControl: 'no-cache'
    })
  );

  const region = process.env.AWS_REGION ?? 'us-east-1';
  const url = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;

  return { bucket: bucketName, key, url };
}

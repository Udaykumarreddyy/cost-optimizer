import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});

/**
 * Uploads the generated HTML report to the report bucket under a date-partitioned key, e.g.
 *   reports/2026/11/13/log-intelligence-report-2026-11-13T08-00-00.html
 * Returns the S3 key and a console-friendly S3 URI for inclusion in the SNS notification.
 */
export async function uploadReport(
  bucketName: string,
  htmlContent: string,
  generatedAt: Date = new Date()
): Promise<{ key: string; s3Uri: string }> {
  const year = generatedAt.getUTCFullYear();
  const month = String(generatedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(generatedAt.getUTCDate()).padStart(2, '0');
  const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');

  const key = `reports/${year}/${month}/${day}/log-intelligence-report-${timestamp}.html`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: htmlContent,
      ContentType: 'text/html',
      Metadata: {
        'generated-at': generatedAt.toISOString()
      }
    })
  );

  return { key, s3Uri: `s3://${bucketName}/${key}` };
}

/** Also persists the raw JSON report alongside the HTML, for programmatic consumption / history. */
export async function uploadJsonReport(
  bucketName: string,
  jsonContent: string,
  generatedAt: Date = new Date()
): Promise<{ key: string; s3Uri: string }> {
  const year = generatedAt.getUTCFullYear();
  const month = String(generatedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(generatedAt.getUTCDate()).padStart(2, '0');
  const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');

  const key = `reports/${year}/${month}/${day}/log-intelligence-report-${timestamp}.json`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: jsonContent,
      ContentType: 'application/json',
      Metadata: {
        'generated-at': generatedAt.toISOString()
      }
    })
  );

  return { key, s3Uri: `s3://${bucketName}/${key}` };
}

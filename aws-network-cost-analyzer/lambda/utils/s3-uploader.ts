import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { NetworkCostReport } from './types';

const s3Client = new S3Client({});

function dateBasedKey(prefix: string, extension: string, generatedAt: Date): string {
  const year = generatedAt.getUTCFullYear();
  const month = String(generatedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(generatedAt.getUTCDate()).padStart(2, '0');
  const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  return `${prefix}/${year}/${month}/${day}/network-cost-report-${timestamp}.${extension}`;
}

/**
 * Uploads both the rendered HTML report and the raw JSON report data to the
 * report bucket, keyed by date (YYYY/MM/DD/...) so reports naturally sort
 * and age out under the bucket's 90-day lifecycle rule.
 */
export async function uploadReports(
  bucketName: string,
  report: NetworkCostReport,
  htmlReport: string,
): Promise<{ htmlKey: string; jsonKey: string; htmlUrl: string }> {
  const generatedAt = new Date(report.generatedAt);
  const htmlKey = dateBasedKey('reports', 'html', generatedAt);
  const jsonKey = dateBasedKey('reports', 'json', generatedAt);

  await Promise.all([
    s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: htmlKey,
        Body: htmlReport,
        ContentType: 'text/html; charset=utf-8',
      }),
    ),
    s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: jsonKey,
        Body: JSON.stringify(report, null, 2),
        ContentType: 'application/json',
      }),
    ),
  ]);

  return {
    htmlKey,
    jsonKey,
    htmlUrl: `https://${bucketName}.s3.amazonaws.com/${htmlKey}`,
  };
}

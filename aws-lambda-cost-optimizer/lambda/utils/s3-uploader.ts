import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * Uploads the generated HTML report to S3 using a date-partitioned key so that reports are
 * naturally organized by year/month/day and the bucket's 90-day lifecycle rule expires them
 * automatically without needing a custom cleanup job.
 *
 * Key format: reports/YYYY/MM/DD/lambda-cost-report-<ISO-timestamp>.html
 */
export interface UploadReportParams {
  s3Client: S3Client;
  bucketName: string;
  htmlContent: string;
  generatedAt?: Date;
}

export interface UploadReportResult {
  bucketName: string;
  key: string;
  s3Uri: string;
}

export function buildReportKey(generatedAt: Date = new Date()): string {
  const year = generatedAt.getUTCFullYear();
  const month = String(generatedAt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(generatedAt.getUTCDate()).padStart(2, '0');
  const isoStamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  return `reports/${year}/${month}/${day}/lambda-cost-report-${isoStamp}.html`;
}

export async function uploadReport(params: UploadReportParams): Promise<UploadReportResult> {
  const { s3Client, bucketName, htmlContent, generatedAt = new Date() } = params;
  const key = buildReportKey(generatedAt);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: htmlContent,
      ContentType: 'text/html; charset=utf-8',
      CacheControl: 'no-cache',
      Metadata: {
        'generated-at': generatedAt.toISOString(),
        'generator': 'aws-lambda-cost-optimizer',
      },
    }),
  );

  return {
    bucketName,
    key,
    s3Uri: `s3://${bucketName}/${key}`,
  };
}

/**
 * S3 Scanner — Finds empty S3 buckets
 *
 * How it works:
 * 1. Lists all S3 buckets in the account
 * 2. For each bucket, tries to list objects (limit 1)
 * 3. If the bucket has zero objects, it's flagged as empty
 *
 * Why this matters:
 * Empty S3 buckets don't cost much themselves, but they:
 * - Clutter your account and make management harder
 * - May have been created for testing and forgotten
 * - Can accumulate request charges from probes/scanners
 * - Indicate incomplete cleanup after project teardown
 *
 * Note: S3 bucket names are globally unique, so empty buckets also
 * "waste" a namespace slot that others could use.
 */
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetBucketLocationCommand,
} from "@aws-sdk/client-s3";
import { ScanResult, ResourceItem } from "../utils/types";

const s3 = new S3Client({});

export async function scanEmptyS3Buckets(): Promise<ScanResult> {
  const items: ResourceItem[] = [];

  const bucketsResult = await s3.send(new ListBucketsCommand({}));

  for (const bucket of bucketsResult.Buckets || []) {
    const bucketName = bucket.Name!;

    try {
      // Check if bucket has any objects (limit 1 for speed)
      const objects = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          MaxKeys: 1,
        })
      );

      if (!objects.Contents || objects.Contents.length === 0) {
        // Get bucket region
        let region = "us-east-1";
        try {
          const location = await s3.send(
            new GetBucketLocationCommand({ Bucket: bucketName })
          );
          region = location.LocationConstraint || "us-east-1";
        } catch {
          // Ignore location errors
        }

        items.push({
          resourceId: bucketName,
          resourceType: "S3 Bucket",
          reason: "Bucket is empty — contains zero objects",
          region,
          estimatedMonthlyCost: 0, // Empty buckets have minimal cost
          details: {
            createdAt: bucket.CreationDate?.toISOString() || "Unknown",
          },
        });
      }
    } catch (err: any) {
      // Skip buckets we can't access (cross-region, permissions, etc.)
      if (err.name !== "AccessDenied" && err.name !== "NoSuchBucket") {
        console.warn(`Could not scan bucket ${bucketName}:`, err.message);
      }
    }
  }

  return { category: "Empty S3 Buckets", items };
}

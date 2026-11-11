/**
 * Shared types for the Cost Optimizer scanners.
 */

/** A single resource that was flagged during scanning */
export interface ResourceItem {
  /** Resource ID (e.g., i-0abc123, vol-xyz, eipalloc-xxx) */
  resourceId: string;

  /** Resource type label for display */
  resourceType: string;

  /** Human-readable description of the issue */
  reason: string;

  /** AWS region where the resource lives */
  region: string;

  /** Estimated monthly cost in USD (0 if unknown) */
  estimatedMonthlyCost: number;

  /** Additional metadata (tags, sizes, etc.) */
  details: Record<string, string>;
}

/** Result from one scanner category */
export interface ScanResult {
  /** Category name (e.g., "Idle EC2 Instances") */
  category: string;

  /** Flagged resources */
  items: ResourceItem[];

  /** If the scanner errored, the message goes here */
  error?: string;
}

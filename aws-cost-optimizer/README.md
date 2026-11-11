# AWS Cost Optimizer & Reporting Tool

A fully automated AWS cost optimization tool built with **AWS CDK (TypeScript)**. It scans your AWS account every week, finds idle/unused resources that are wasting money, generates a professional HTML report, and emails you a summary.

---

## What Does This Project Do?

This tool automatically scans your AWS account and finds **5 types of wasteful resources**:

| # | Resource Type | What It Finds | Why It Costs Money |
|---|--------------|---------------|-------------------|
| 1 | **Idle EC2 Instances** | Running EC2 instances with CPU < 5% over 7 days | A t3.medium costs ~$30/month even if nobody uses it |
| 2 | **Unused EBS Volumes** | EBS volumes not attached to any EC2 instance | A 100GB gp3 volume costs ~$8/month sitting idle |
| 3 | **Unattached Elastic IPs** | EIPs allocated but not assigned to any instance | AWS charges $3.65/month per unattached EIP |
| 4 | **Old EBS Snapshots** | Snapshots older than 30 days (configurable) | A 100GB snapshot costs $5/month, hundreds add up |
| 5 | **Empty S3 Buckets** | Buckets with zero objects | Clutters your account, indicates incomplete cleanup |

After scanning, it:
- Generates a **beautiful HTML report** with tables, cost estimates, and severity badges
- Uploads the report to **S3** (auto-deletes after 90 days)
- Sends a **summary email via SNS** with the breakdown and S3 link

---

## Architecture

```
┌─────────────────┐         ┌─────────────────────┐
│  EventBridge     │────────▶│   Lambda Function    │
│  (Every Monday)  │         │   (cost-scanner)     │
└─────────────────┘         └──────────┬──────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
                    ▼                  ▼                  ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │  EC2 API      │  │  CloudWatch   │  │  S3 API      │
            │  (Describe*)  │  │  (CPU Metrics)│  │  (ListBuckets)│
            └──────────────┘  └──────────────┘  └──────────────┘
                    │                  │                  │
                    └──────────────────┼──────────────────┘
                                       │
                                       ▼
                             ┌─────────────────┐
                             │  Generate HTML   │
                             │  Report          │
                             └────────┬────────┘
                                      │
                           ┌──────────┴──────────┐
                           │                     │
                           ▼                     ▼
                    ┌──────────────┐      ┌──────────────┐
                    │  S3 Bucket   │      │  SNS Topic   │
                    │  (reports/)  │      │  (email)     │
                    └──────────────┘      └──────────────┘
```

### AWS Services Used

| Service | Purpose |
|---------|---------|
| **AWS CDK** | Infrastructure as Code — defines all resources in TypeScript |
| **Lambda** | Runs the scanner code (serverless, no server to manage) |
| **EventBridge** | Triggers the Lambda every Monday at 8:00 AM UTC |
| **S3** | Stores the HTML reports with 90-day lifecycle |
| **SNS** | Sends email notifications with scan results |
| **IAM** | Least-privilege role — Lambda can only read resources, not modify them |
| **CloudWatch** | Provides CPU metrics for EC2 idle detection |
| **CloudFormation** | CDK deploys via CloudFormation stacks |

---

## How Each Scanner Works (Detailed)

### 1. Idle EC2 Scanner (`ec2-scanner.ts`)

**Question:** How does it know an EC2 instance is idle?

**Answer:** It checks CPU usage from CloudWatch:

1. Calls `ec2:DescribeInstances` with filter `state = running` to get all running instances
2. For each instance, calls `cloudwatch:GetMetricStatistics` for the `CPUUtilization` metric over the last 7 days
3. Calculates the average CPU across all 7 days
4. If average CPU < 5% (configurable), the instance is flagged as "idle"

**Example:**
- You have 10 EC2 instances running
- 3 of them have average CPU of 1.2%, 0.8%, and 3.5% over 7 days
- These 3 are flagged as idle because they're below the 5% threshold
- The other 7 instances with higher CPU usage are NOT flagged

**Cost estimation:** Uses a built-in price map (t3.medium = $30/month, m5.large = $70/month, etc.)

### 2. Unused EBS Scanner (`ebs-scanner.ts`)

**Question:** How does it find unused volumes?

**Answer:** Checks the volume status:

1. Calls `ec2:DescribeVolumes` with filter `status = available`
2. In AWS, an EBS volume has two states:
   - `in-use` = attached to an EC2 instance (this is normal)
   - `available` = exists but NOT attached to anything (this is waste)
3. Every volume with status "available" is flagged

**Why do unused volumes exist?**
- When you terminate an EC2 instance, the root volume may be deleted, but additional volumes are NOT deleted by default
- Someone created a volume for testing and forgot to delete it
- A volume was detached during maintenance and never reattached

**Cost estimation:** Volume size (GB) × price per GB ($0.08/GB for gp3)

### 3. Unattached EIP Scanner (`eip-scanner.ts`)

**Question:** How does it detect unattached EIPs?

**Answer:** Checks the association:

1. Calls `ec2:DescribeAddresses` to list all Elastic IPs
2. Each EIP has an `AssociationId` field:
   - If `AssociationId` exists → EIP is attached to an instance (no charge, skip)
   - If `AssociationId` is empty → EIP is unattached (AWS charges $3.65/month)

**Why do unattached EIPs exist?**
- Instance was terminated but the EIP was not released
- Instance was stopped (EIP detaches when instance stops in some configs)
- Created for future use but never assigned

### 4. Old Snapshot Scanner (`snapshot-scanner.ts`)

**Question:** How does it find old snapshots?

**Answer:** Checks the creation date:

1. Calls `ec2:DescribeSnapshots` with `OwnerIds = [current account]` (to skip AWS public snapshots)
2. For each snapshot, compares `StartTime` with the cutoff date (default: 30 days ago)
3. Any snapshot older than 30 days is flagged

**Why do old snapshots accumulate?**
- Automated backup scripts create snapshots but never clean them up
- Manual "before change" snapshots that were never deleted
- Snapshots of volumes that no longer exist

**Cost estimation:** Snapshot size (GB) × $0.05/GB/month

### 5. Empty S3 Bucket Scanner (`s3-scanner.ts`)

**Question:** How does it check if a bucket is empty?

**Answer:** Lists objects with a limit of 1:

1. Calls `s3:ListAllMyBuckets` to get all buckets
2. For each bucket, calls `s3:ListObjectsV2` with `MaxKeys: 1`
3. If the response has zero objects, the bucket is flagged as empty

**Why use MaxKeys: 1?** Speed. We don't need to count all objects — we just need to know if there's at least one. This makes the scan very fast even for accounts with many buckets.

---

## Project Structure

```
aws-cost-optimizer/
├── bin/
│   └── app.ts                      # CDK app entry point
├── lib/
│   └── cost-optimizer-stack.ts      # CDK stack — all AWS resources
├── lambda/
│   ├── handler.ts                   # Lambda entry — orchestrates scanners
│   ├── scanners/
│   │   ├── ec2-scanner.ts           # Idle EC2 instance detection
│   │   ├── ebs-scanner.ts           # Unused EBS volume detection
│   │   ├── eip-scanner.ts           # Unattached Elastic IP detection
│   │   ├── snapshot-scanner.ts      # Old EBS snapshot detection
│   │   └── s3-scanner.ts            # Empty S3 bucket detection
│   └── utils/
│       ├── types.ts                 # Shared TypeScript interfaces
│       ├── report-generator.ts      # HTML report builder
│       ├── s3-uploader.ts           # Upload report to S3
│       └── sns-notifier.ts          # Send email via SNS
├── test/
│   └── cost-optimizer-stack.test.ts # CDK unit tests
├── cdk.json                         # CDK configuration
├── package.json                     # Dependencies
├── tsconfig.json                    # TypeScript configuration
├── jest.config.js                   # Test configuration
├── .gitignore
└── README.md                        # This file
```

---

## Prerequisites

Before deploying, make sure you have:

1. **Node.js 18+** installed: `node --version`
2. **AWS CLI** configured with credentials: `aws sts get-caller-identity`
3. **AWS CDK** installed globally: `npm install -g aws-cdk`
4. **CDK bootstrapped** in your account/region: `cdk bootstrap`

---

## Deployment — Step by Step

### Step 1: Clone and install dependencies

```bash
cd aws-cost-optimizer
npm install
```

### Step 2: Build the TypeScript code

```bash
npm run build
```

### Step 3: Preview what will be created (optional)

```bash
cdk synth
cdk diff
```

### Step 4: Deploy to AWS

```bash
cdk deploy --parameters NotificationEmail=your-email@gmail.com
```

This creates all resources (Lambda, S3, SNS, EventBridge, IAM). After deployment:
- **Check your email** — you'll get an SNS subscription confirmation. Click the link to start receiving reports.

### Step 5: Test it manually (don't wait for Monday!)

```bash
aws lambda invoke \
  --function-name cost-optimizer-scanner \
  --payload '{}' \
  /dev/stdout
```

### Step 6: View the report

```bash
# Find the latest report
aws s3 ls s3://cost-optimizer-reports-YOUR_ACCOUNT_ID/reports/ --recursive

# Download and open it
aws s3 cp s3://cost-optimizer-reports-YOUR_ACCOUNT_ID/reports/2026-11-11/cost-report.html ./report.html
open report.html    # macOS
# or: xdg-open report.html   # Linux
```

---

## Configuration

You can customize these parameters during deployment:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `NotificationEmail` | (required) | Email to receive weekly reports |
| `SnapshotAgeDays` | 30 | Snapshots older than this are flagged |
| `EC2IdleCpuThreshold` | 5 | EC2 instances with avg CPU below this % are flagged |

```bash
# Example: Flag snapshots older than 60 days, CPU threshold 10%
cdk deploy \
  --parameters NotificationEmail=you@gmail.com \
  --parameters SnapshotAgeDays=60 \
  --parameters EC2IdleCpuThreshold=10
```

---

## How to Customize / Extend

### Add a new scanner (example: idle RDS databases)

1. Create `lambda/scanners/rds-scanner.ts`
2. Follow the same pattern: query AWS API → check condition → return `ScanResult`
3. Add required IAM permissions in `lib/cost-optimizer-stack.ts`
4. Call the new scanner from `lambda/handler.ts`

### Change the schedule

In `lib/cost-optimizer-stack.ts`, modify the EventBridge cron:

```typescript
// Every day at 8 AM UTC
schedule: events.Schedule.cron({ minute: "0", hour: "8", weekDay: "*" })

// Every Monday and Thursday
schedule: events.Schedule.cron({ minute: "0", hour: "8", weekDay: "MON,THU" })

// First day of every month
schedule: events.Schedule.cron({ minute: "0", hour: "8", day: "1" })
```

### Scan multiple regions

Modify each scanner to loop through regions using `ec2:DescribeRegions` and create clients for each region.

---

## Cleanup / Teardown

To delete all resources and stop charges:

```bash
cdk destroy
```

This removes: Lambda function, S3 bucket (and all reports), SNS topic, EventBridge rule, IAM role.

---

## Security

- **Read-only permissions**: The Lambda can only DESCRIBE/LIST resources. It cannot stop, terminate, or delete anything.
- **Least privilege IAM**: Only the specific API actions needed are allowed.
- **Encrypted S3**: Reports bucket uses S3-managed encryption.
- **No public access**: S3 bucket blocks all public access.
- **No secrets in code**: All configuration via environment variables and CloudFormation parameters.

---

## Cost of Running This Tool

This tool itself costs almost nothing:

| Resource | Cost |
|----------|------|
| Lambda (runs once/week, ~30s) | ~$0.00 (free tier) |
| S3 (small HTML files) | ~$0.01/month |
| SNS (1 email/week) | Free |
| EventBridge | Free |
| **Total** | **< $0.01/month** |

The tool finds savings that are typically **100x–1000x** its own cost.

---

## Resume Bullet Points

Add these to your resume under Projects:

- Built an automated AWS cost optimization tool using CDK (TypeScript) that scans for idle EC2 instances, unused EBS volumes, unattached Elastic IPs, stale snapshots, and empty S3 buckets
- Designed a serverless architecture using Lambda, EventBridge, S3, and SNS to generate weekly HTML cost reports with estimated savings
- Implemented CloudWatch-based idle detection for EC2 instances by analyzing 7-day CPU utilization metrics against configurable thresholds
- Applied least-privilege IAM policies granting read-only access for resource scanning with zero write/delete permissions
- Achieved infrastructure-as-code deployment with CDK, enabling one-command provisioning and teardown of the entire stack

---

## Interview Talking Points

**Q: How does your tool detect idle EC2 instances?**
A: It queries CloudWatch for the CPUUtilization metric over the past 7 days using GetMetricStatistics. If the average CPU is below a configurable threshold (default 5%), the instance is flagged as idle. I chose 7 days to avoid false positives from temporary low usage.

**Q: Why did you choose CDK over Terraform or CloudFormation YAML?**
A: CDK lets me write infrastructure in TypeScript, the same language as my Lambda code. This means type safety, autocompletion, and the ability to use programming constructs like loops and conditions. It's also what we use at Diligent, so I'm experienced with it.

**Q: How do you ensure the tool doesn't accidentally delete resources?**
A: The IAM role only has Describe/List/Get permissions — it cannot stop, terminate, or delete anything. It's purely a reporting tool. The team reviews the report and makes manual decisions about what to clean up.

**Q: What would you add next?**
A: Multi-region scanning (currently single-region), idle RDS database detection, underutilized NAT Gateway detection, and a cost trend dashboard showing savings over time. I'd also add Slack integration for real-time alerts.

**Q: How does the weekly schedule work?**
A: EventBridge fires a cron rule every Monday at 8 AM UTC. This invokes the Lambda function, which runs all 5 scanners, generates the report, uploads it to S3, and publishes a summary to SNS which sends the email.

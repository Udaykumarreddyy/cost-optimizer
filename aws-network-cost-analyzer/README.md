# AWS Network Cost Analyzer

A serverless AWS CDK (TypeScript) application that scans your AWS account every week and tells you exactly where your networking bill is going — and how much of it you can get back.

---

## Table of Contents

1. [What it does](#what-it-does)
2. [Why network costs are the "hidden killer"](#why-network-costs-are-the-hidden-killer)
3. [Architecture](#architecture)
4. [How each analyzer works](#how-each-analyzer-works)
5. [Real cost examples](#real-cost-examples)
6. [VPC endpoint savings math](#vpc-endpoint-savings-math)
7. [Deployment](#deployment)
8. [Configuration](#configuration)
9. [Project structure](#project-structure)
10. [Resume bullet points](#resume-bullet-points)
11. [Interview Q&A](#interview-qa)

---

## What it does

Every Monday at 08:00 UTC, a Lambda function wakes up and runs five independent cost analyzers against your account:

| Analyzer | What it checks | What it flags |
|---|---|---|
| **NAT Gateway** | `DescribeNatGateways` + CloudWatch (`BytesOut/InTo/FromDestination/Source`, `ActiveConnectionCount`, `PacketsDropCount`) | NAT Gateways paying the hourly fee while moving almost no traffic; traffic volume high enough to justify a VPC endpoint |
| **Cross-AZ transfer** | Cost Explorer `GetCostAndUsage` filtered to inter-AZ data transfer usage types | Which services are generating cross-AZ charges, and how much |
| **VPC Endpoints** | `DescribeVpcEndpoints` + `DescribeNatGateways` per VPC | VPCs missing free S3/DynamoDB Gateway Endpoints; existing Interface Endpoints and their hourly cost |
| **Load Balancers** | `DescribeLoadBalancers`, `DescribeTargetGroups`, `DescribeTargetHealth` + CloudWatch (`RequestCount` / `ActiveFlowCount`, healthy/unhealthy host counts) | ALBs/NLBs with zero traffic in the lookback window (still billing ~$16-18/mo); load balancers where every target is unhealthy |
| **Elastic IPs** | `DescribeAddresses` | Unassociated EIPs (pure waste under the Feb 2024 public IPv4 pricing change) |

The results are assembled into a single `NetworkCostReport`, rendered as an HTML dashboard, written to S3 (JSON + HTML, 90-day lifecycle), and summarized in an email via SNS: total spend, top 3 cost items, and total potential savings.

This is a **read-only, reporting-only** tool. It never deletes, modifies, or disables any AWS resource — it tells a human what to do and why.

---

## Why network costs are the "hidden killer"

Compute and storage costs show up where you'd expect — EC2 and EBS line items you're already watching. Network costs are different:

- **They're spread across dozens of line items** (NAT data processing, NAT hourly, inter-AZ transfer, inter-region transfer, public IPv4 hours, load balancer hours, interface endpoint hours...), so no single Cost Explorer view makes them obvious.
- **They scale with success, not with mistakes.** A NAT Gateway doesn't get more expensive because something is broken — it gets expensive because your application is working and moving data. Teams often don't notice until the bill is already large.
- **They're architectural, not operational.** You can't "stop" an inter-AZ cost the way you stop an idle EC2 instance — fixing it means changing where things run relative to each other, which is a design decision, not a cleanup task.
- **The defaults are expensive by default.** A fresh VPC with a NAT Gateway per AZ, no VPC endpoints, and multi-AZ everything is the *textbook* "best practice" architecture — and it is also the most expensive one. Nobody turns this off because turning it off looks like removing redundancy.
- **Small per-unit costs compound silently.** $0.045/GB and $0.01/GB-equivalent for cross-AZ sound trivial until you're moving terabytes a month between a chatty app tier and a database in a different AZ.

In a typical mid-size production AWS account, networking (NAT + cross-AZ + load balancers + public IPs) routinely accounts for **10-25% of the total bill** — and almost none of it appears as a single, obviously-named line item that a FinOps dashboard highlights by default. That's the "hidden" part.

---

## Architecture

```
                    ┌─────────────────────────┐
                    │   EventBridge Rule        │
                    │   cron(0 8 ? * MON *)      │
                    │   (every Monday 08:00 UTC) │
                    └────────────┬─────────────┘
                                 │ invokes
                                 ▼
                    ┌─────────────────────────────────────┐
                    │  Lambda: network-cost-analyzer        │
                    │  512 MB / 10 min timeout / arm64      │
                    │                                        │
                    │  ┌──────────────────────────────────┐ │
                    │  │ handler.ts (orchestrator)         │ │
                    │  │                                    │ │
                    │  │  ├─ nat-gateway-analyzer.ts        │ │
                    │  │  ├─ cross-az-analyzer.ts           │ │
                    │  │  ├─ vpc-endpoint-analyzer.ts        │ │
                    │  │  ├─ load-balancer-analyzer.ts       │ │
                    │  │  └─ elastic-ip-analyzer.ts          │ │
                    │  │                                    │ │
                    │  │  → report-generator.ts (HTML)      │ │
                    │  │  → s3-uploader.ts                  │ │
                    │  │  → sns-notifier.ts                 │ │
                    │  └──────────────────────────────────┘ │
                    └───────┬───────────────────┬───────────┘
                            │                    │
                 PutObject  │                    │ Publish
                            ▼                    ▼
                  ┌───────────────────┐  ┌──────────────────┐
                  │ S3 Report Bucket   │  │  SNS Topic         │
                  │ (90-day lifecycle) │  │  → Email           │
                  │ reports/YYYY/MM/DD │  │  subscription      │
                  └───────────────────┘  └──────────────────┘

  Read-only IAM permissions used by the Lambda:
    ec2:Describe*
    elasticloadbalancing:Describe*
    cloudwatch:GetMetricData / ListMetrics / GetMetricStatistics
    ce:GetCostAndUsage / GetCostForecast / GetDimensionValues
```

All AWS SDK calls are read-only `Describe*` / `Get*` / `List*` calls. The function cannot create, modify, or delete any infrastructure.

---

## How each analyzer works

### 1. NAT Gateway Analyzer (`lambda/analyzers/nat-gateway-analyzer.ts`)

1. `DescribeNatGateways` to list every NAT Gateway in `available`/`pending` state.
2. For each one, `GetMetricData` against the `AWS/NATGateway` namespace for:
   - `BytesOutToDestination`, `BytesOutToSource`, `BytesInFromDestination`, `BytesInFromSource` (summed → total GB processed)
   - `ActiveConnectionCount` (averaged)
   - `PacketsDropCount` (summed — nonzero means you may be hitting port/bandwidth limits)
3. Cost model:
   - Hourly: `hours_in_lookback × $0.045`
   - Data processing: `total_GB_processed × $0.045/GB`
   - Normalized to a 30-day month for comparability across different lookback windows.
4. Flags:
   - **Low traffic** — under 1 GB moved in the lookback window while still paying the full hourly rate.
   - **VPC endpoint candidate** — more than 5 GB moved, worth checking whether S3/DynamoDB traffic is riding through NAT unnecessarily.

### 2. Cross-AZ Analyzer (`lambda/analyzers/cross-az-analyzer.ts`)

1. Calls Cost Explorer `GetCostAndUsage`, grouped by `SERVICE` and `USAGE_TYPE`, filtered to the `EC2: Data Transfer - Inter AZ` usage type group (with a usage-type substring fallback filter for accounts where that group isn't available).
2. Aggregates cost and usage (GB) per service/usage-type pair across the lookback window.
3. Surfaces the top 3 offending services and projects a monthly cost.
4. Recommends single-AZ placement for non-critical workloads, AZ-aware/topology-aware routing, and VPC endpoints for AWS service traffic.

### 3. VPC Endpoint Analyzer (`lambda/analyzers/vpc-endpoint-analyzer.ts`)

1. `DescribeVpcs` to enumerate every VPC.
2. `DescribeVpcEndpoints` to see what's already there — specifically whether a **Gateway** endpoint exists for `.s3` and `.dynamodb`.
3. `DescribeNatGateways` grouped by VPC, cross-referenced with NAT traffic volume from the NAT analyzer, to estimate how much of the NAT data-processing bill could move to a free gateway endpoint instead (conservatively assumes 30% of NAT-routed traffic is S3/DynamoDB-bound).
4. Inventories existing **Interface** endpoints and their per-AZ hourly cost (`$0.01/hr × AZ count × 24 × 30`).

### 4. Load Balancer Analyzer (`lambda/analyzers/load-balancer-analyzer.ts`)

1. `DescribeLoadBalancers` for every ALB/NLB.
2. `DescribeTargetGroups` + `DescribeTargetHealth` per load balancer to count healthy/unhealthy targets.
3. `GetMetricData` against `AWS/ApplicationELB` (`RequestCount`, summed) or `AWS/NetworkELB` (`ActiveFlowCount`, averaged) over the lookback window.
4. Flags:
   - **Idle** — zero traffic in the lookback window, still billing the ~$0.0225/hr base rate (~$16.20/mo).
   - **All targets unhealthy** — a reliability problem as much as a cost one; the LB is running and billing but can't serve anything.

### 5. Elastic IP Analyzer (`lambda/analyzers/elastic-ip-analyzer.ts`)

1. `DescribeAddresses` for every Elastic IP in the account/region.
2. Checks for an `AssociationId` / `InstanceId` / `NetworkInterfaceId` to determine association.
3. Since **February 1, 2024**, AWS bills ~$0.005/hr (~$3.60/mo) for every public IPv4 address, including Elastic IPs, whether associated or not. Unassociated EIPs are flagged as **100% avoidable waste** since there is zero reason to keep paying for one that's attached to nothing.

---

## Real cost examples

**NAT Gateway processing 100 GB/month:**

```
Hourly charge:    24 hrs/day × 30 days × $0.045/hr   = $32.40
Data processing:  100 GB × $0.045/GB                  =  $4.50
---------------------------------------------------------------
Total monthly cost                                     = $36.90
```

Notice that the *hourly* charge ($32.40) dwarfs the *data processing* charge ($4.50) at this volume — this is exactly why a NAT Gateway that's barely used is such a bad deal: you're paying $32.40/month almost entirely for the privilege of having it exist, regardless of how little it's used.

**Three NAT Gateways (one per AZ) in a dev VPC that's lightly used:**

```
3 × $32.40/month (hourly only, minimal data)   = $97.20/month = $1,166.40/year
```

For many dev/staging VPCs, a single NAT Gateway (or none, if only AWS-service traffic is needed) is enough — this one change alone can save $60-$800+/month depending on AZ count.

**Idle Application Load Balancer:**

```
ALB hourly rate:  $0.0225/hr × 24 hrs × 30 days = $16.20/month
```

Multiply by every forgotten load balancer from a decommissioned environment, and "idle LB cleanup" becomes a surprisingly large line item across a fleet of accounts.

**10 unassociated Elastic IPs left over from old instances:**

```
10 × $3.60/month = $36.00/month = $432/year, for zero business value
```

---

## VPC endpoint savings math

Gateway VPC Endpoints for **S3** and **DynamoDB** are free — no hourly charge, no data processing charge — and they let traffic to those services skip the NAT Gateway entirely (and skip inter-AZ charges too, if the endpoint is reachable from the same AZ as the caller).

Worked example — an app that reads/writes **500 GB/month to S3** through a NAT Gateway today:

```
WITHOUT a Gateway Endpoint (routed through NAT):
  Data processing: 500 GB × $0.045/GB  = $22.50/month
  (NAT hourly charge is unavoidable if other traffic still needs it,
   but this 500 GB specifically costs $22.50 in processing fees)

WITH an S3 Gateway Endpoint:
  Data processing: 500 GB × $0.00/GB   = $0.00/month
  Hourly endpoint charge (Gateway type) = $0.00/month

Savings: $22.50/month, or $270/year, per 500 GB/month of S3 traffic.
```

If that same app also used an **Interface Endpoint** instead (e.g., for a service without gateway-endpoint support), spread across 3 AZs:

```
3 AZs × $0.01/hr × 24 hrs × 30 days = $21.60/month, PLUS data processing
```

This is why the analyzer specifically distinguishes **Gateway** endpoints (free, use for S3/DynamoDB) from **Interface** endpoints (paid per AZ per hour, use for everything else that needs PrivateLink) — using the wrong one, or using NAT when a Gateway endpoint would do, is one of the most common avoidable AWS networking costs.

---

## Deployment

### Prerequisites

- Node.js 20+
- AWS CLI configured with credentials that have CDK bootstrap + deploy permissions
- `npm install -g aws-cdk` (or use `npx cdk`)
- An AWS account already bootstrapped for CDK (`cdk bootstrap`)

### Install and deploy

```bash
cd aws-network-cost-analyzer
npm install

# One-time per account/region
npx cdk bootstrap

# Review the generated CloudFormation
npx cdk synth

# Deploy, providing your notification email
npx cdk deploy --parameters NotificationEmail=you@example.com
```

You'll receive an SNS subscription confirmation email immediately after deploy — **confirm it**, or you won't receive weekly reports.

### Running the analysis on demand

```bash
aws lambda invoke \
  --function-name network-cost-analyzer \
  --payload '{}' \
  response.json
```

### Running tests

```bash
npm test
```

### Tear down

```bash
npx cdk destroy
```

Note: the S3 report bucket has `RemovalPolicy.RETAIN`, so historical reports survive a stack teardown. Delete the bucket manually if you want a full cleanup.

---

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `NotificationEmail` | *(required)* | Email address subscribed to the SNS topic for weekly summaries |
| `LookbackDays` | `7` | Number of days of CloudWatch metrics / Cost Explorer usage to analyze per run (1-90) |

| Environment variable (set automatically by CDK) | Purpose |
|---|---|
| `REPORT_BUCKET_NAME` | S3 bucket the Lambda writes HTML/JSON reports to |
| `SNS_TOPIC_ARN` | SNS topic the Lambda publishes summaries to |
| `LOOKBACK_DAYS` | Passed through from the `LookbackDays` CFN parameter |

To change the schedule, edit the `events.Schedule.cron(...)` call in `lib/network-cost-stack.ts`.

---

## Project structure

```
aws-network-cost-analyzer/
├── bin/
│   └── app.ts                        # CDK app entry point
├── lib/
│   └── network-cost-stack.ts         # S3 bucket, SNS topic, Lambda, EventBridge rule, IAM
├── lambda/
│   ├── handler.ts                    # Orchestrates all analyzers, builds + ships the report
│   ├── analyzers/
│   │   ├── nat-gateway-analyzer.ts
│   │   ├── cross-az-analyzer.ts
│   │   ├── vpc-endpoint-analyzer.ts
│   │   ├── load-balancer-analyzer.ts
│   │   └── elastic-ip-analyzer.ts
│   └── utils/
│       ├── types.ts                  # Shared interfaces
│       ├── report-generator.ts       # HTML report rendering
│       ├── s3-uploader.ts            # Date-keyed S3 upload
│       └── sns-notifier.ts           # Summary email
├── test/
│   └── network-cost-stack.test.ts    # CDK assertions
├── package.json
├── tsconfig.json
├── cdk.json
├── jest.config.js
└── README.md
```

---

## Resume bullet points

- Designed and shipped a serverless AWS CDK (TypeScript) application that automatically audits NAT Gateway usage, inter-AZ data transfer, VPC endpoint coverage, idle load balancers, and unused Elastic IPs across an AWS account, surfacing actionable savings recommendations via a weekly automated report.
- Built five independent cost-analysis modules using the AWS SDK v3 (EC2, ELBv2, CloudWatch, Cost Explorer) to compute real-dollar cost breakdowns (NAT hourly + per-GB processing, inter-AZ transfer by service, idle load balancer base charges, unassociated Elastic IP waste) without requiring any third-party cost tooling.
- Implemented a fully read-only, least-privilege IAM model (`ec2:Describe*`, `elasticloadbalancing:Describe*`, `cloudwatch:GetMetricData`, `ce:GetCostAndUsage`) so the tool can run safely in production accounts with zero risk of modifying infrastructure.
- Automated weekly cost visibility via EventBridge-scheduled Lambda, S3-based HTML/JSON reporting with lifecycle-managed retention, and SNS email summaries highlighting total spend, top cost drivers, and total potential monthly savings.
- Quantified and documented common AWS networking cost traps (NAT Gateway over-provisioning, missing Gateway VPC Endpoints, cross-AZ chatty services, idle load balancers, orphaned Elastic IPs) with concrete savings math, turning tribal FinOps knowledge into a repeatable automated check.

---

## Interview Q&A

**Q: Why is a NAT Gateway often the single most expensive "invisible" resource in an AWS account?**
A: Because it charges an always-on hourly fee ($0.045/hr, ~$32.40/month) regardless of usage, on top of a per-GB data processing fee ($0.045/GB). A lightly-used dev VPC with one NAT Gateway per AZ (a very common "best practice" default) can rack up $90-100+/month in pure hourly charges before a single meaningful byte of traffic is considered. It's expensive by default, not expensive by misconfiguration.

**Q: How do you tell the difference between a NAT Gateway that's "fine" versus one that should be removed?**
A: Look at both ends: is total GB processed over a representative window (this tool defaults to 7 days) near zero, and is `ActiveConnectionCount` consistently low? If so, it's a hourly-fee sink with no offsetting value. If traffic is high, the better question isn't "remove the NAT Gateway" but "should this traffic be going through NAT at all" — e.g., S3/DynamoDB traffic should go through free Gateway VPC Endpoints instead.

**Q: What's the difference between a Gateway VPC Endpoint and an Interface VPC Endpoint, cost-wise?**
A: Gateway endpoints (S3, DynamoDB only) are completely free — no hourly charge, no data processing charge — and work by adding a route table entry. Interface endpoints (PrivateLink, used for most other AWS services) cost $0.01/hr per AZ they're deployed in, plus data processing charges, because they provision an ENI with a private IP in each AZ. The rule of thumb: always use the Gateway endpoint for S3/DynamoDB; only use Interface endpoints for services that don't offer a Gateway option.

**Q: How do you measure cross-AZ data transfer cost without a dedicated network cost tool?**
A: Cost Explorer's `GetCostAndUsage` API supports filtering by usage type / usage type group, including inter-AZ data transfer. Grouping by `SERVICE` and `USAGE_TYPE` lets you attribute the cost to specific services (e.g., a chatty RDS-to-EC2 pattern, or a multi-AZ ElastiCache cluster) without needing VPC Flow Logs analysis, though Flow Logs can pinpoint the exact resource pairs if you need to go deeper.

**Q: Since February 2024, AWS charges for all public IPv4 addresses. Doesn't that make the "unassociated EIP" check less useful?**
A: It makes it more useful, not less. Before Feb 2024, only unassociated EIPs cost money — an associated one was free, so there was a "use it or lose it" incentive. Now every public IPv4 address costs ~$3.60/month whether it's attached to a running instance or sitting unused. That means an unassociated EIP isn't just "potentially wasteful" anymore, it's **guaranteed** pure waste with zero offsetting benefit — there's no scenario where keeping an unattached EIP around makes financial sense, which makes this one of the easiest, lowest-risk savings opportunities to act on.

**Q: Why build this as a scheduled Lambda instead of a one-off script?**
A: Network costs drift — new NAT Gateways get created by new VPCs, load balancers get decommissioned without cleanup, Elastic IPs get released from terminated instances but the allocation lingers. A weekly automated check with email summaries turns a one-time audit into continuous visibility, catching regressions (like a load balancer that went idle after a migration) within a week instead of at the next quarterly cost review.

**Q: How did you keep the IAM permissions safe for a tool that runs unattended on a schedule in production?**
A: Every permission is a read-only `Describe*`, `List*`, or `Get*` action — `ec2:Describe*`, `elasticloadbalancing:Describe*`, `cloudwatch:GetMetricData`, `ce:GetCostAndUsage` — scoped to a dedicated execution role with no write/delete permissions on any networking resource. The Lambda can inform a human with exact resource IDs and dollar amounts, but it is architecturally incapable of deleting or modifying anything itself, which removes the "automation that broke prod" risk class entirely.

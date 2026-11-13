# AWS Pipeline Health Monitor

A serverless, CDK-deployed tool that scans every **AWS CodePipeline** pipeline and **AWS CodeBuild** project in an account/region on a weekly schedule, computes the four **DORA metrics** (Deployment Frequency, Lead Time for Changes, Change Failure Rate, Mean Time to Recovery), renders an HTML health dashboard, publishes it to S3, and emails a plain-text summary via SNS.

No agents, no third-party SaaS, no persistent infrastructure to patch - just a scheduled Lambda function reading directly from the CodePipeline, CodeBuild, and CloudWatch APIs.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [DORA Metrics Explained](#dora-metrics-explained)
3. [How Each Metric Is Calculated](#how-each-metric-is-calculated)
4. [Architecture](#architecture)
5. [Repository Layout](#repository-layout)
6. [Deployment](#deployment)
7. [Configuration](#configuration)
8. [Sample Report](#sample-report)
9. [Cost](#cost)
10. [Resume Bullet Points](#resume-bullet-points)
11. [Interview Q&A](#interview-qa)

---

## What It Does

Every **Monday at 08:00 UTC**, an EventBridge rule invokes a Lambda function that:

1. **Discovers** every CodePipeline pipeline (`ListPipelines`) and every CodeBuild project (`ListProjects`) in the account/region.
2. **Pulls execution/build history** for the configured lookback window (default **7 days**, override via the `LookbackDays` CloudFormation parameter or a one-off `{ "lookbackDays": N }` test invocation):
   - `ListPipelineExecutions` for each pipeline.
   - `ListBuildsForProject` + `BatchGetBuilds` for each CodeBuild project.
   - `cloudwatch:GetMetricData` against the `AWS/CodeBuild` namespace for a p90 build-duration cross-check (CloudWatch retains aggregated metrics longer than the ~300 most-recent build records the Builds API conveniently returns).
3. **Calculates** per-pipeline and per-project health (success rate, average duration, failure patterns, timeout rate, last status) and rolls everything up into the four DORA metrics.
4. **Categorizes** each DORA metric - and an overall score - as **Elite / High / Medium / Low** against the published DORA benchmark thresholds.
5. **Renders** a single self-contained HTML report (inline CSS, no external assets) with color-coded DORA cards, a sortable-by-eye pipeline table, a CodeBuild table, and a "top failing pipelines/builds" trend section.
6. **Uploads** the report to S3 under a date-partitioned key, plus a `reports/latest.html` pointer that always resolves to the newest report.
7. **Publishes** a plain-text summary (DORA scores + top failing pipelines/projects + report link) to an SNS topic, which emails the subscriber(s) configured at deploy time.

Nothing is mutated - every API call made by this project is read-only (`List*`, `Get*`, `BatchGet*`, `GetMetricData`). It cannot start, stop, or modify a single pipeline or build.

---

## DORA Metrics Explained

[DORA](https://dora.dev) (DevOps Research and Assessment, now part of Google Cloud) found, across years of research surveying tens of thousands of engineering teams, that four metrics are the strongest predictors of software delivery performance *and* organizational performance:

| Metric | What it measures | Why it matters |
|---|---|---|
| **Deployment Frequency** | How often an organization successfully releases to production. | Throughput. Elite teams deploy on demand, multiple times a day; low performers deploy less than once a month. |
| **Lead Time for Changes** | Time from code committed to code running in production. | Throughput. Short lead time means fast feedback loops and smaller, safer changes. |
| **Change Failure Rate** | Percentage of deployments that cause a failure in production (requiring a hotfix, rollback, or patch). | Stability. Elite teams ship fast *and* safely - throughput and stability are not a trade-off. |
| **Mean Time to Recovery (MTTR)** | How long it takes to restore service after a production failure. | Stability. Fast recovery limits the blast radius of the failures that do happen. |

Teams are bucketed into four performance tiers - **Elite, High, Medium, Low** - based on where their numbers land against the published benchmark table (see below). This tool automates that classification so you don't have to eyeball pipeline dashboards and do the math by hand every week.

---

## How Each Metric Is Calculated

This tool derives all four metrics **directly from CodePipeline execution history and CodeBuild build history** - no manual tagging, no separate incident-management integration required. That means two of the four metrics are necessarily *proxies* rather than textbook-perfect measurements; this is documented below so the numbers are interpreted correctly.

### 1. Deployment Frequency (exact)

```
deploysPerWeek(pipeline) = succeededExecutions(pipeline) / (lookbackDays / 7)
```

Computed per pipeline from `ListPipelineExecutions`, then **averaged across all pipelines** for the account-wide DORA number. A pipeline execution counts as a "deployment" when its final status is `Succeeded`.

### 2. Lead Time for Changes (proxy: execution duration)

CodePipeline's `ListPipelineExecutions`/`GetPipelineExecution` APIs do not return the original source-commit timestamp - only when the *pipeline execution* started and last updated. True lead time (commit → production) would require correlating with the source provider (CodeCommit/GitHub/CodeStar connection commit metadata), which is out of scope for a read-only, source-agnostic monitor.

As a practical proxy, this tool uses **average successful pipeline execution duration** (source change detected → pipeline finishes deploying) as Lead Time for Changes. This under-counts true lead time (it excludes PR review time, time sitting in a backlog, etc.) but accurately reflects the portion of lead time your delivery pipeline itself controls - which is exactly the part an infra/platform team can act on.

```
leadTimeHours = avg(pipeline.averageDurationMinutes for pipeline in pipelinesWithExecutions) / 60
```

> If you need textbook-exact Lead Time for Changes, extend `pipeline-analyzer.ts` to call `GetPipelineExecution` and resolve the `sourceRevisions` commit SHA + timestamp.

### 3. Change Failure Rate (exact, by execution)

```
changeFailureRate = totalFailedExecutions / totalExecutions * 100   (across all pipelines)
```

A "change failure" is any pipeline execution with a final status of `Failed`. This intentionally does **not** attempt to distinguish "failed because of a flaky test" from "failed because the deploy broke prod" - CodePipeline's API doesn't carry that distinction. If you wire incident data into this later, replace this calculation with failed-deploys-that-triggered-an-incident / total-deploys for a stricter interpretation.

### 4. Mean Time to Recovery (exact, derived from execution sequence)

For each pipeline, executions are sorted chronologically. Every time a `Failed` execution is followed later by a `Succeeded` execution, the gap between them is recorded as one "recovery." MTTR is the average of those gaps, in minutes, per pipeline - then averaged again across all pipelines with at least one recovery for the account-wide number.

```
for each pipeline, chronologically:
  on Failed execution  -> open an incident clock (if not already open)
  on Succeeded execution with an open clock -> close it, record (closedAt - openedAt)
pipelineMTTR = average(recorded recovery durations)
accountMTTR  = average(pipelineMTTR across pipelines that had >= 1 recovery)
```

This treats "the next successful deploy of the same pipeline" as the recovery event, which is the standard CI/CD interpretation of MTTR when you don't have a separate incident-management system (PagerDuty, Jira, etc.) feeding real incident timestamps.

### DORA Benchmark Thresholds Used

Based on the publicly published DORA research benchmarks ([dora.dev](https://dora.dev/guides/dora-metrics-four-keys/)):

| Category | Deployment Frequency | Lead Time for Changes | Change Failure Rate | MTTR |
|---|---|---|---|---|
| **Elite** | ≥ 7/week (on-demand, multiple/day) | < 1 hour | 0% - 15% | < 1 hour |
| **High** | 1 - 6.9/week (daily to weekly) | 1 hour - 1 day | 16% - 30% | ≤ 1 day |
| **Medium** | 0.25 - 0.99/week (weekly to monthly) | 1 day - 1 week | 31% - 45% | 1 day - 1 week |
| **Low** | < 0.25/week (less than monthly) | > 1 week | > 45% | > 1 week |

These thresholds live in `lambda/analyzers/metrics-calculator.ts` as small, independently testable `categorizeX()` functions - tune them if your organization's published benchmark table differs (DORA refreshes exact cut points slightly year to year).

The **overall category** reported for the account/region is the *worst* (lowest-ranked) of the four individual categories - a team isn't "Elite" overall if its change failure rate is "Low," even if it deploys constantly.

---

## Architecture

```
                         ┌────────────────────────┐
                         │  EventBridge Rule       │
                         │  cron(0 8 ? * MON *)    │   Monday 08:00 UTC, weekly
                         └───────────┬─────────────┘
                                     │ invoke
                                     ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     Lambda: PipelineHealthFunction                    │
│                     (Node.js 20, arm64, 512MB, 10 min timeout)        │
│                                                                         │
│   1. ListPipelines -> ListPipelineExecutions (per pipeline)           │
│   2. ListProjects -> ListBuildsForProject -> BatchGetBuilds           │
│   3. CloudWatch GetMetricData (AWS/CodeBuild p90 Duration)             │
│   4. Calculate DORA metrics + Elite/High/Medium/Low categorization    │
│   5. Render self-contained HTML report                                │
│   6. PutObject -> S3 (dated key + reports/latest.html)                │
│   7. Publish -> SNS (plain-text summary)                               │
└───────────────┬───────────────────────────────────┬───────────────────┘
                │                                     │
                ▼                                     ▼
     ┌────────────────────┐                ┌───────────────────────┐
     │ S3: ReportBucket    │                │ SNS: PipelineHealth   │
     │ 90-day lifecycle    │                │ Topic -> Email sub    │
     │ reports/YYYY/MM/DD/ │                └───────────────────────┘
     └────────────────────┘
```

IAM for the Lambda's execution role is scoped to exactly what it needs and nothing else:

- `codepipeline:List*`, `codepipeline:Get*`
- `codebuild:List*`, `codebuild:BatchGet*`
- `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`
- `sts:GetCallerIdentity` (for labeling the report with the account ID)
- `s3:PutObject` on the report bucket only (via `grantPut`)
- `sns:Publish` on the health topic only (via `grantPublish`)
- The AWS-managed `AWSLambdaBasicExecutionRole` for CloudWatch Logs

All resource-level actions use `*` for the read-only list/get/batch-get verbs since CodePipeline/CodeBuild ARNs aren't known until scan time - this mirrors how AWS Config/Trusted Advisor-style auditing tools are typically scoped (read-only, account-wide, zero mutation permissions).

---

## Repository Layout

```
aws-pipeline-health-monitor/
├── bin/
│   └── app.ts                        CDK app entry point
├── lib/
│   └── pipeline-health-stack.ts      S3, SNS, Lambda, EventBridge, IAM
├── lambda/
│   ├── handler.ts                    Orchestrates the weekly scan
│   ├── analyzers/
│   │   ├── pipeline-analyzer.ts      CodePipeline scan + per-pipeline health
│   │   ├── codebuild-analyzer.ts     CodeBuild scan + per-project health
│   │   └── metrics-calculator.ts     DORA metric math + categorization
│   └── utils/
│       ├── types.ts                  Shared interfaces
│       ├── report-generator.ts       HTML report rendering
│       ├── s3-uploader.ts            Date-partitioned S3 upload
│       ├── sns-notifier.ts           Plain-text email summary
│       └── cloudwatch-metrics.ts     p90 build duration via GetMetricData
├── test/
│   └── pipeline-health-stack.test.ts CDK assertions (fine-grained)
├── cdk.json / tsconfig.json / jest.config.js / package.json / .gitignore
└── README.md
```

---

## Deployment

### Prerequisites

- Node.js 20+
- AWS CLI configured with credentials for the target account
- AWS CDK v2 (`npm install -g aws-cdk` or use the local `npx cdk` via the scripts below)
- CDK already bootstrapped in the target account/region (`cdk bootstrap`), if this is the first CDK stack deployed there

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Compile and run unit tests
npm run build
npm test

# 3. (optional) review the generated CloudFormation template
npm run synth

# 4. Deploy, providing the required parameters
npx cdk deploy \
  --parameters NotificationEmail=platform-team@example.com \
  --parameters LookbackDays=7

# 5. Confirm the SNS email subscription
#    AWS sends a "Subscription Confirmation" email to NotificationEmail -
#    the subscriber MUST click "Confirm subscription" or no emails will
#    be delivered.
```

After deployment, CDK prints outputs including the report bucket name, the SNS topic ARN, and the Lambda function name.

### Running it on demand (without waiting for Monday)

```bash
aws lambda invoke \
  --function-name <LambdaFunctionName-from-output> \
  --payload '{"lookbackDays": 14}' \
  --cli-binary-format raw-in-base64-out \
  response.json
cat response.json
```

### Tearing it down

```bash
npx cdk destroy
```

The S3 report bucket is created with `RemovalPolicy.RETAIN`, so historical reports survive a stack deletion - delete the bucket manually (after emptying it) if you want a full clean-up.

---

## Configuration

| Setting | How to change it | Default |
|---|---|---|
| Notification email | `NotificationEmail` CloudFormation parameter at deploy time | *(required, no default)* |
| Lookback window (days) | `LookbackDays` CloudFormation parameter, or `{"lookbackDays": N}` on a manual Lambda invocation | 7 |
| Schedule | `events.Schedule.expression(...)` in `lib/pipeline-health-stack.ts` | `cron(0 8 ? * MON *)` (Mondays, 08:00 UTC) |
| Lambda memory / timeout | `memorySize` / `timeout` props on the `NodejsFunction` in `lib/pipeline-health-stack.ts` | 512 MB / 10 minutes |
| Report retention | `lifecycleRules` on the S3 bucket in `lib/pipeline-health-stack.ts` | 90 days |
| DORA benchmark thresholds | `categorizeX()` functions in `lambda/analyzers/metrics-calculator.ts` | Published DORA benchmarks (see table above) |
| Max executions/builds scanned per resource | `MAX_EXECUTION_PAGES` / `MAX_BUILD_IDS_PER_PROJECT` constants in the two analyzer files | 1,000 executions / 300 builds per pipeline/project |

---

## Sample Report

The generated HTML report (`reports/latest.html` in the S3 bucket) looks roughly like this:

```
┌──────────────────────────────────────────────────────────────────────┐
│  AWS Pipeline & Build Health Report                                   │
│  Generated 2026-11-09T08:00:12Z · Account 123456789012 · us-east-1    │
├──────────────────────────────────────────────────────────────────────┤
│  Overall DORA Performance:  HIGH PERFORMER                   [High]  │
├──────────────────────────────────────────────────────────────────────┤
│  Scan Summary: 14 pipelines · 22 build projects · 187 executions ·   │
│  412 builds analyzed                                                  │
├──────────────────────────────────────────────────────────────────────┤
│  Deployment Frequency   Lead Time         Change Failure   MTTR       │
│  4.3 deploys/week [High] 3.1 hours [High]  9.2% [Elite]    0.8h[Elite]│
├──────────────────────────────────────────────────────────────────────┤
│  Pipeline Health Table                                                 │
│  checkout-service-pipeline   22 exec  86.4%  3.1/wk  6.2min  Succeeded│
│  payments-api-pipeline       18 exec  61.1%  2.0/wk 11.8min  Failed   │
│  ...                                                                    │
├──────────────────────────────────────────────────────────────────────┤
│  CodeBuild Project Health Table                                        │
│  payments-api-build   41 builds  75.6%  2.4% timeout  4.1min  Install │
│  ...                                                                    │
├──────────────────────────────────────────────────────────────────────┤
│  Failure Trends: Top Failing Pipelines / Top Failing Build Projects   │
└──────────────────────────────────────────────────────────────────────┘
```

The companion SNS email is plain text, e.g.:

```
Subject: [High] Pipeline Health Report - 2026-11-09

AWS Pipeline & Build Health Report
Generated: 2026-11-09T08:00:12.481Z
Account: 123456789012  Region: us-east-1  Lookback: 7 day(s)

OVERALL DORA PERFORMANCE: HIGH

DORA Metrics:
  - Deployment Frequency: 4.3 deploys/week  [High]
  - Lead Time for Changes: 3.1 hours  [High]
  - Change Failure Rate: 9.2 %  [Elite]
  - Mean Time to Recovery: 0.8 hours  [Elite]

Scanned 14 pipeline(s) and 22 build project(s).

Top Failing Pipelines:
  - payments-api-pipeline: 7 failed / 18 total (61.1% success)
  ...

Top Failing Build Projects:
  - payments-api-build: 10 failed, 1 timed out (most common failing phase: BUILD)
  ...

Full HTML report: https://s3.console.aws.amazon.com/s3/object/<bucket>?prefix=reports/2026/11/09/pipeline-health-report-2026-11-09T08-00-12-481Z.html
```

---

## Cost

This runs **once a week** for a few seconds to a couple of minutes depending on fleet size:

- Lambda: a handful of GB-seconds/week - effectively free under the always-free tier.
- S3: a few KB per report, 90-day retention - a few cents/year even at hundreds of reports.
- SNS: 1 email/week - free tier covers this many times over.
- CloudWatch GetMetricData: a handful of API calls/week, well within free tier.

Realistic monthly cost for most accounts: **under $0.05/month**, dominated by S3 storage of historical reports.

---

## Resume Bullet Points

- Designed and deployed a serverless **AWS CodePipeline/CodeBuild health monitoring system** (TypeScript, AWS CDK, Lambda, EventBridge, S3, SNS) that automatically computes **DORA metrics** (Deployment Frequency, Lead Time, Change Failure Rate, MTTR) across an entire AWS account and classifies delivery performance against industry-published Elite/High/Medium/Low benchmarks.
- Built a read-only, least-privilege IAM model (scoped to `List*`/`Get*`/`BatchGet*`/`GetMetricData` only) for an automated weekly audit covering every CI/CD pipeline and build project in an account, eliminating the need for manual dashboard review.
- Implemented MTTR calculation from raw CodePipeline execution history by detecting failure→recovery sequences per pipeline, and cross-validated CodeBuild duration metrics using CloudWatch `GetMetricData` percentile statistics (p90) alongside the Builds API.
- Authored a self-contained HTML reporting engine (no external JS/CSS dependencies) with color-coded DORA scorecards, automatically published to S3 with date-partitioned keys and a 90-day lifecycle policy, plus an SNS email digest for stakeholders who don't want to open a dashboard.
- Wrote CDK fine-grained assertion tests (`aws-cdk-lib/assertions`) to lock in IAM policy scope, Lambda sizing, and the weekly EventBridge schedule as part of CI, preventing accidental privilege escalation or schedule drift.

---

## Interview Q&A

**Q: Why compute DORA metrics from raw CodePipeline/CodeBuild API calls instead of using a third-party tool (e.g., LinearB, Sleuth, Faros)?**
A: Those tools are excellent but add cost, another vendor integration, and - critically - require broader access (often write access or OAuth app installs) across your SCM and CI/CD systems. This project trades some precision (see the Lead Time proxy below) for a zero-dependency, read-only, few-cents-a-month alternative that a platform team can own end-to-end and audit by reading ~1,000 lines of TypeScript.

**Q: Your Lead Time for Changes isn't the "textbook" commit-to-production number. Isn't that a problem?**
A: It's a documented limitation, not a hidden one. CodePipeline's execution APIs don't expose the original commit timestamp without also querying the source provider (CodeCommit, GitHub via CodeStar Connections, etc.), which varies per team and adds scope/complexity. I use average pipeline execution duration as a proxy - it's the part of lead time the delivery pipeline actually controls, and it's directionally correct: if execution duration goes up, true lead time goes up too. The README calls this out explicitly and documents exactly what you'd change (`GetPipelineExecution` + `sourceRevisions`) to make it exact.

**Q: How did you implement MTTR without an incident-management integration like PagerDuty?**
A: I treat "the next successful execution of the same pipeline after a failure" as the recovery event. I sort each pipeline's executions chronologically, open a timer on the first `Failed` execution in a streak, and close it on the next `Succeeded` execution, recording the elapsed time. That's the standard interpretation used by CI/CD-only DORA calculators when you don't have a separate incident system feeding "time to detect" and "time to resolve" timestamps.

**Q: Why cap execution/build history at 1,000 executions and 300 builds per resource?**
A: Lambda has a hard 15-minute ceiling (I configured 10 minutes); without a cap, a single extremely active pipeline or build project could page through thousands of API results and starve the time budget for scanning everything else in the account. The caps are generous for a weekly, 7-day-lookback scan and are exposed as named constants so they're trivial to tune for accounts with unusually high deployment volume.

**Q: Why ARM64 for the Lambda function?**
A: The workload is pure I/O-bound JavaScript making AWS SDK calls - no native binaries - so there's no compatibility cost, and Graviton2 Lambda pricing is roughly 20% cheaper per GB-second than x86_64 for identical performance on this kind of workload.

**Q: How would you scale this to run across multiple accounts (an AWS Organization)?**
A: Deploy the stack via **CloudFormation StackSets** (or CDK Pipelines targeting each account) into every account that runs CodePipeline/CodeBuild, then either (a) have each account's Lambda publish its own report/email, or (b) add a cross-account aggregator Lambda that assumes a read-only role in each member account, calls the same analyzer modules, and rolls everything up into one org-wide report. The analyzer/metrics-calculator modules are already decoupled from "how we got the credentials," so option (b) is mostly a change to how the AWS SDK clients in each analyzer are constructed (per-account `fromTemporaryCredentials`).

**Q: What happens if a pipeline or build project has zero executions in the lookback window?**
A: It's still listed in the report (success rate 0%, deployments/week 0, last status "Unknown") but excluded from the DORA aggregate averages (`pipelinesWithExecutions` filters out zero-execution pipelines) so idle/seasonal pipelines don't artificially drag down the account's deployment frequency or lead time numbers. MTTR specifically reports "Elite / no failures observed" rather than penalizing a pipeline that simply never failed.

**Q: Is this safe to run in a production account? What's the blast radius if something goes wrong?**
A: The IAM role only grants `List*`, `Get*`, `BatchGet*`, and `GetMetricData` actions - there is no CodePipeline/CodeBuild mutation permission in the role at all, so even a bug in the Lambda code cannot start, stop, retry, or delete a pipeline/build. The only write permissions are `s3:PutObject` scoped to the one report bucket and `sns:Publish` scoped to the one topic, both granted via CDK's `grantPut`/`grantPublish` (least privilege, resource-scoped, not account-wide).

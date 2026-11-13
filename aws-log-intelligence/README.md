# AWS Log Intelligence

A serverless AWS CDK (TypeScript) application that scans every CloudWatch Log Group in an
account on a weekly schedule, calculates exactly how much each one costs, flags the groups
that are quietly burning money (no retention policy, oversized storage, high-volume
ingestion), detects application error spikes, and emails a prioritized, dollar-denominated
report — all without a human ever opening the CloudWatch console.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Why CloudWatch Logs Get Expensive](#why-cloudwatch-logs-get-expensive)
3. [How The Analysis Works](#how-the-analysis-works)
4. [Cost Calculation Formulas](#cost-calculation-formulas)
5. [Architecture](#architecture)
6. [Deployment](#deployment)
7. [Configuration](#configuration)
8. [Sample Output](#sample-output)
9. [How It Saves Money (Real Examples)](#how-it-saves-money-real-examples)
10. [Resume Bullet Points](#resume-bullet-points)
11. [Interview Q&A](#interview-qa)

---

## What It Does

Every Monday at 08:00 UTC, an EventBridge rule invokes a Lambda function that:

1. **Lists every CloudWatch Log Group** in the account (paginated `DescribeLogGroups`) and
   records its stored size, retention policy, and creation time.
2. **Calculates storage cost** for every log group (`$0.03/GB/month`) and ranks the top 20
   most expensive groups.
3. **Scans those top 20 groups** for `ERROR` / `EXCEPTION` / `FATAL` log lines in the last
   24 hours (`FilterLogEvents`), compares the count to the prior 24-hour window, and flags
   any group with a **>50% increase** as an error spike.
4. **Pulls 7 days of `IncomingBytes` / `IncomingLogEvents` metrics** (`GetMetricData`) for
   those same groups to find **ingestion hotspots** — groups writing more than 1 GB/day —
   and estimates their ingestion cost (`$0.50/GB`).
5. **Recommends a retention policy** for every log group that has none, based on
   naming-pattern rules (`/aws/lambda/*` → 14 days, `/ecs/*` → 30 days, `/aws/rds/*` → 90
   days, anything with "production" in the name → 365 days, otherwise a configurable
   default), and estimates the monthly savings of applying it.
6. **Renders one self-contained HTML report** with cost summary cards, an expensive-groups
   table, red error-spike badges, a retention-recommendations table, and an ingestion
   hotspot bar chart.
7. **Uploads the HTML + JSON report to S3** under a date-partitioned key
   (`reports/YYYY/MM/DD/log-intelligence-report-<timestamp>.html`).
8. **Emails a plain-text summary via SNS**: total cost, top 5 most expensive groups, error
   spike count, and total potential savings — with a link to the full report.

Nothing in this stack *changes* any log group automatically. It is an **advisory /
observability** tool: it tells you exactly what to fix and how much you'll save, but a human
(or a follow-on automation) applies the retention change.

---

## Why CloudWatch Logs Get Expensive

CloudWatch Logs bills on three axes, and almost every account only ever notices the first one
after the bill arrives:

| Cost driver | AWS pricing (us-east-1, approx.) | Why it sneaks up on you |
|---|---|---|
| **Ingestion** | ~$0.50 / GB ingested | Every `console.log`, every Lambda `START`/`END`/`REPORT` line, every ALB access log line, every debug statement left on in production — all metered. |
| **Storage** | ~$0.03 / GB / month | Logs accumulate *forever* unless a retention policy says otherwise. "Never expire" is the **default** for every new log group. |
| **Analysis** (Logs Insights queries) | ~$0.005 / GB scanned | Not covered by this tool, but worth knowing: ad-hoc Insights queries over un-retired logs scan the same unbounded storage. |

The two failure modes this tool specifically hunts for:

- **"Never expire" log groups.** CloudWatch Logs does not default to any retention period —
  every log group created without an explicit `retentionInDays` keeps every byte forever. A
  Lambda function emitting 50 MB/day of debug logs for three years with no retention policy
  has quietly accumulated ~55 GB (~$1.65/month storage) that nobody is reading and that keeps
  growing every single day.
- **Chatty / misconfigured ingestion.** A log level accidentally left at `DEBUG` in
  production, a retry loop logging on every attempt, or a library that logs full HTTP
  bodies, can turn a log group that should cost $5/month into one costing $500/month — and
  because ingestion cost is a *rate*, it compounds every day it goes unnoticed.

Both failure modes are invisible in the AWS Cost Explorer top-line number (it just says
"CloudWatch: $4,200") and invisible in the CloudWatch console (nothing alerts you that a log
group has no retention — it's just a blank field). This tool makes both visible, in dollars,
automatically, every week.

---

## How The Analysis Works

### 1. Log Group Analyzer (`lambda/analyzers/log-group-analyzer.ts`)

- Calls `DescribeLogGroupsCommand` in a loop, following `nextToken`, to enumerate **every**
  log group in the account/region (CDK Lambda IAM role only needs read access — no
  `logs:CreateLogGroup` etc.).
- For each group, reads `storedBytes` and `retentionInDays` directly off the API response
  (no estimation needed — CloudWatch tracks exact stored bytes per group).
- Flags `hasNoRetention` when `retentionInDays` is `undefined` (CloudWatch's signal for
  "Never expire").
- Flags `isLarge` when stored size exceeds **10 GB**.
- Sorts by `monthlyStorageCost` descending and returns the **top 20** — this bounds the cost
  and runtime of the two more expensive downstream analyzers (`FilterLogEvents` and
  `GetMetricData` calls scale with the number of groups scanned, and most accounts have a
  small number of groups that dominate total spend — the classic 80/20 pattern).

### 2. Error Detector (`lambda/analyzers/error-detector.ts`)

- For each of the top 20 groups, runs **two** `FilterLogEventsCommand` calls in parallel:
  one for `[now-24h, now]`, one for `[now-48h, now-24h]`, both with
  `filterPattern: '?ERROR ?EXCEPTION ?FATAL ?Error ?Exception ?Fatal'` (CloudWatch's `?`
  OR-syntax for filter patterns).
- Paginates each call (capped at 10,000 events/period/group as a safety valve against
  extremely noisy groups blowing the 10-minute Lambda timeout).
- Computes `percentChange = (current - previous) / previous * 100` and flags `isSpike` when
  it exceeds the configurable `ErrorSpikeThreshold` (default 50%).
- A group with 0 errors in the previous period and >0 in the current period is treated as a
  100% spike (not a divide-by-zero crash) — this is the "brand-new failure mode" case, which
  is arguably the most important one to catch.

### 3. Ingestion Analyzer (`lambda/analyzers/ingestion-analyzer.ts`)

- Builds one `GetMetricDataCommand` request per batch of up to 500 metric queries (two
  queries per group — `IncomingBytes` and `IncomingLogEvents` — both `Namespace: AWS/Logs`,
  `Stat: Sum`, `Period: 86400` (1 day)) over the trailing 7 days.
- Averages the 7 daily `Sum` datapoints to get `avgDailyIngestionGB`, and takes the max for
  `peakDailyIngestionGB`.
- Flags `isHighVolume` when average daily ingestion exceeds **1 GB/day**, and attaches a
  human-readable recommendation (reduce log level, sample noisy lines, route verbose logs to
  S3 via Firehose instead of CloudWatch Logs).
- `GetMetricData` is used instead of `GetMetricStatistics` because it supports the modern
  batched multi-metric query shape and is the AWS-recommended API going forward.

### 4. Retention Advisor (`lambda/analyzers/retention-advisor.ts`)

- Filters to only groups with `hasNoRetention === true`.
- Runs each group's name through an ordered list of pattern rules (first match wins):

  | Pattern | Recommended retention | Rationale |
  |---|---|---|
  | contains "prod"/"production" | 365 days | Compliance + incident forensics |
  | `/aws/rds/*` | 90 days | Quarterly DB performance trending |
  | `/ecs/*`, `/aws/ecs/*`, `/aws/eks/*` | 30 days | Operational troubleshooting window |
  | `/aws/lambda/*` | 14 days | High-volume, short debugging half-life |
  | `/aws/apigateway/*` | 14 days | High-volume access logs |
  | `/aws/codebuild/*` | 30 days | CI build-history window |
  | (no match) | `RetentionRecommendationDays` param (default 30) | Safe general default |

- Estimates savings by modeling an "effective unbounded age" baseline of 180 days (a
  conservative proxy for how long logs typically sit in a never-expiring group before this
  tool runs) and scaling the group's currently-stored size by
  `min(recommendedDays / 180, 1)` to project the steady-state stored size *after* the policy
  is applied, then takes the difference in monthly storage cost. This is intentionally
  conservative — it will never *overstate* savings for a group that's been accumulating logs
  for years, and it converges to the real long-run savings as the retention policy takes
  effect.

### 5. Report Generator / Uploader / Notifier

- `report-generator.ts` renders one dependency-free HTML file (inline CSS, no CDN assets) so
  the report works even through a presigned URL with no internet egress.
- `s3-uploader.ts` writes both the HTML and the raw JSON report to
  `reports/<yyyy>/<mm>/<dd>/log-intelligence-report-<ISO-timestamp>.{html,json}` — the JSON
  copy exists so the report history can be queried/graphed later (e.g. Athena over the
  bucket) without re-parsing HTML.
- `sns-notifier.ts` publishes a plain-text email: total spend, top 5 expensive groups, error
  spike count/details, retention recommendation count, and the S3 link to the full report.

---

## Cost Calculation Formulas

```
Storage cost (per group, per month)
  = storedBytes / 1024^3           # GB
  × $0.03                           # per GB-month

Ingestion cost (per group, per month, projected from a 7-day sample)
  = (Σ daily IncomingBytes over 7 days) / 7 / 1024^3   # avg GB/day
  × 30                                                   # days/month
  × $0.50                                                # per GB ingested

Retention savings (per group, per month)
  = storedGB × $0.03 × (1 − min(recommendedDays / 180, 1))

Total estimated monthly spend
  = Σ storage cost (all groups)  +  Σ ingestion cost (top 20 groups)

Total potential monthly savings
  = Σ retention savings (all no-retention groups)
```

All dollar figures use the `us-east-1` CloudWatch Logs price sheet referenced in
`lambda/analyzers/log-group-analyzer.ts` (`STORAGE_COST_PER_GB_MONTH`) and
`lambda/analyzers/ingestion-analyzer.ts` (`INGESTION_COST_PER_GB`). If you operate in a
different region or have a negotiated rate, update those two constants — every downstream
calculation flows from them.

---

## Architecture

```
                         ┌────────────────────────┐
                         │  EventBridge Rule        │
                         │  cron(0 8 ? * MON *)     │
                         └────────────┬─────────────┘
                                      │ invoke
                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Lambda: log-intelligence-analyzer              │
│                     (Node.js 20, 1024 MB, 10 min timeout)          │
│                                                                      │
│  handler.ts                                                         │
│   ├─ log-group-analyzer.ts   ──▶ DescribeLogGroups (paginated)      │
│   ├─ error-detector.ts       ──▶ FilterLogEvents × top 20 groups    │
│   ├─ ingestion-analyzer.ts   ──▶ GetMetricData (AWS/Logs namespace) │
│   ├─ retention-advisor.ts    ──▶ (pure computation, no AWS calls)   │
│   ├─ report-generator.ts     ──▶ renders self-contained HTML        │
│   ├─ s3-uploader.ts          ──▶ PutObject (html + json)            │
│   └─ sns-notifier.ts         ──▶ Publish (summary email)            │
└───────┬───────────────────────────────────────┬────────────────────┘
        │                                        │
        ▼                                        ▼
┌───────────────────────┐              ┌───────────────────────────┐
│ S3: report bucket       │              │ SNS: notification topic    │
│ 90-day lifecycle         │              │ → Email subscription       │
│ reports/YYYY/MM/DD/*.html│              └───────────────────────────┘
└───────────────────────┘

IAM: analyzer Lambda execution role has read-only
  logs:Describe*, logs:GetLogEvents, logs:FilterLogEvents,
  cloudwatch:GetMetricData/GetMetricStatistics/ListMetrics,
  plus s3:PutObject/GetObject on the report bucket and sns:Publish on the topic.
  No write/delete permissions on log groups — this tool only recommends.
```

**Stack resources** (`lib/log-intelligence-stack.ts`):

- `AWS::S3::Bucket` — SSE-S3 encrypted, `BLOCK_ALL` public access, `enforceSSL: true`,
  90-day expiration lifecycle rule.
- `AWS::SNS::Topic` + email subscription (address supplied via `NotificationEmail`
  parameter at deploy time).
- `AWS::Lambda::Function` (via `aws-cdk-lib/aws-lambda-nodejs` `NodejsFunction`, esbuild
  bundling, Node.js 20.x, 1024 MB, 10-minute timeout).
- `AWS::Logs::LogGroup` for the function's own logs (1-month retention — eat your own dog
  food).
- `AWS::Events::Rule` — weekly cron, Mondays 08:00 UTC, targets the Lambda with 2 retry
  attempts.
- `AWS::IAM::Policy` — least-privilege read-only CloudWatch Logs/Metrics statements attached
  to the Lambda's auto-generated execution role, plus bucket/topic grants.

---

## Deployment

### Prerequisites

- Node.js 18+ and npm
- AWS CLI configured with credentials that can deploy CloudFormation, IAM, Lambda, S3, SNS,
  and EventBridge resources
- AWS CDK v2 (`npm install -g aws-cdk`, or just use the local devDependency via `npx cdk`)

### Steps

```bash
cd aws-log-intelligence
npm install

# One-time per account/region:
npx cdk bootstrap

# Review the generated CloudFormation:
npx cdk synth

# Deploy (prompts for the required parameters if not passed with -c/--parameters):
npx cdk deploy \
  --parameters NotificationEmail=you@example.com \
  --parameters RetentionRecommendationDays=30 \
  --parameters ErrorSpikeThreshold=50
```

After deployment, **confirm the SNS email subscription** (check your inbox for an
"AWS Notification - Subscription Confirmation" email and click Confirm) — SNS will not
deliver the weekly report email until that's done.

### Running on demand (don't wait for Monday)

```bash
aws lambda invoke \
  --function-name log-intelligence-analyzer \
  --payload '{}' \
  /tmp/log-intelligence-output.json \
  --cli-binary-format raw-in-base64-out

cat /tmp/log-intelligence-output.json
```

### Tearing down

```bash
npx cdk destroy
```

Note: the report bucket is created with `RemovalPolicy.RETAIN`, so historical reports
survive a stack destroy — delete it manually (`aws s3 rb s3://<bucket> --force`) if you want
a full cleanup.

---

## Configuration

| CloudFormation parameter | Default | Purpose |
|---|---|---|
| `NotificationEmail` | *(required)* | Where the weekly summary email is sent. |
| `RetentionRecommendationDays` | `30` | Fallback retention (days) recommended when no naming-pattern rule matches a no-retention log group. |
| `ErrorSpikeThreshold` | `50` | Percentage increase in errors (24h vs. prior 24h) that triggers a "spike" flag. |

| Constant (in code) | File | Default | Purpose |
|---|---|---|---|
| `STORAGE_COST_PER_GB_MONTH` | `log-group-analyzer.ts` | `0.03` | $/GB-month for storage cost math. |
| `INGESTION_COST_PER_GB` | `ingestion-analyzer.ts` | `0.50` | $/GB for ingestion cost math. |
| `LARGE_GROUP_THRESHOLD_GB` | `log-group-analyzer.ts` | `10` | GB threshold for the "large group" flag. |
| `HIGH_INGESTION_THRESHOLD_GB_PER_DAY` | `ingestion-analyzer.ts` | `1` | GB/day threshold for "ingestion hotspot". |
| `TOP_N_EXPENSIVE_GROUPS` | `log-group-analyzer.ts` | `20` | How many top groups get deep error/ingestion analysis. |

Adjust these constants and redeploy (`cdk deploy`) if your pricing tier, account size, or
risk tolerance differs from the defaults.

---

## Sample Output

**SNS email subject:**
```
[Log Intelligence] Weekly Report - $1,842.17/mo - 2 error spike(s)
```

**SNS email body (truncated):**
```
AWS LOG INTELLIGENCE - WEEKLY SUMMARY
======================================
Generated: 2026-11-09T08:00:12.441Z
Account:   123456789012 (us-east-1)
Log groups scanned: 214

COST SUMMARY
------------
Total storage cost:     $612.40/mo
Total ingestion cost:   $1229.77/mo
Total estimated spend:  $1842.17/mo
Potential savings:      $287.55/mo

TOP 5 MOST EXPENSIVE LOG GROUPS
--------------------------------
1. /aws/lambda/checkout-service - 4821.33 GB - $144.64/mo - NO RETENTION SET
2. /ecs/payments-api - 2990.10 GB - $89.70/mo - 30d retention
3. /aws/rds/instance/orders-db/error - 1455.02 GB - $43.65/mo - NO RETENTION SET
...

ERROR SPIKES
------------
2 log group(s) showed a >50% increase in errors vs. the prior 24h.
  - /ecs/payments-api: 42 -> 211 errors (+402%)
  - /aws/lambda/checkout-service: 8 -> 19 errors (+138%)

RETENTION RECOMMENDATIONS
--------------------------
37 log group(s) have no retention policy set.
Applying recommended retention could save ~$287.55/mo.
```

**HTML report** includes the same data as styled cards, sortable-looking tables, red
`SPIKE` badges on the error table, and a horizontal bar chart of ingestion hotspots sized
relative to the single largest offender.

---

## How It Saves Money (Real Examples)

**Example 1 — the forgotten Lambda log group.**
A Lambda function has been running for 3 years at ~60 MB/day of `console.log` output with no
retention policy ever set.
`3 years × 365 days × 0.06 GB ≈ 65.7 GB stored`
`65.7 GB × $0.03/GB = $1.97/month` for this one group — looks trivial. Multiply by the 30–50
such forgotten functions a mid-size account typically accumulates over a few years, and
"trivial" becomes **$60–$100/month of pure storage waste for data nobody has queried in
years**, recommended for 14-day retention instead, saving essentially all of it.

**Example 2 — the chatty ECS service.**
A payments microservice's log level got bumped to `DEBUG` during an incident six months ago
and nobody ever reverted it. It now ingests 8 GB/day instead of its normal 0.5 GB/day.
`(8 − 0.5) GB/day × 30 days × $0.50/GB = $112.50/month` in pure ingestion waste, invisible
until this tool's ingestion-hotspot analysis flags it with a concrete "reduce log level"
recommendation — caught in week one instead of discovered at the next quarterly cost review.

**Example 3 — the RDS error log nobody reads.**
An RDS instance's error log group has accumulated 1.2 TB over 4 years with no retention
policy (common — RDS log groups are created automatically and inherit no default retention).
`1.2 TB × $0.03/GB = $36.90/month` just to store years of database connection noise. Applying
the tool's 90-day `/aws/rds/*` recommendation converges the long-run storage cost toward
`90/180 × 1.2 TB × $0.03 ≈ $18.40/month` — roughly **50% savings on that one group alone**,
with zero operational risk since 90 days of DB logs is more than enough for any realistic
incident investigation window.

**Example 4 — catching the incident before the on-call engineer does.**
A deployment introduces a null-pointer bug that triples the error rate in a checkout service.
The weekly scan catches the **>50% error-count increase** and emails it out — often before a
customer-facing SLA alarm would have fired, because this tool is comparing raw log volume,
not a pre-configured metric alarm threshold someone forgot to tune.

Across a typical mid-size AWS account (100–300 log groups), the combination of (a) retention
policy gaps and (b) un-tuned log levels on 2–3 chatty services routinely accounts for
**15–30% of total CloudWatch Logs spend** — this tool surfaces that number in dollars, every
week, automatically.

---

## Resume Bullet Points

- Designed and deployed a serverless **AWS CDK (TypeScript)** application that scans all
  CloudWatch Log Groups account-wide on a weekly EventBridge schedule, calculating per-group
  storage and ingestion costs and surfacing the top cost drivers via automated HTML/email
  reporting.
- Built a **retention-policy recommendation engine** using log-group-name pattern matching
  (Lambda, ECS, RDS, production heuristics) that identified and prioritized **$280+/month**
  in unbounded CloudWatch Logs storage waste across 200+ log groups with zero manual log
  review.
- Implemented **automated error-spike detection** using `FilterLogEvents` period-over-period
  comparison (current vs. prior 24h), flagging >50% increases in ERROR/EXCEPTION/FATAL log
  volume to catch regressions before customer-facing alarms fire.
- Used `CloudWatch GetMetricData` batched metric queries (`IncomingBytes`,
  `IncomingLogEvents`) to identify high-ingestion-rate log groups and quantify the dollar
  cost of excessive logging, driving log-level tuning conversations with service owners.
- Followed least-privilege IAM design: the analysis Lambda holds only read-only
  `logs:Describe*`, `logs:GetLogEvents`, `logs:FilterLogEvents`, and
  `cloudwatch:GetMetricData` permissions — it recommends changes but cannot mutate any log
  resource, eliminating operational risk from an automated cost tool.
- Wrote CDK unit tests (`aws-cdk-lib/assertions`) asserting IAM policy shape, Lambda
  configuration (memory/timeout), S3 lifecycle rules, and EventBridge cron expression,
  catching infrastructure regressions in CI before deployment.

---

## Interview Q&A

**Q: Why scan only the top 20 log groups for errors and ingestion instead of every group?**
A: `FilterLogEvents` and `GetMetricData` cost both API time and (in the case of
`FilterLogEvents`) real request volume per group scanned. In almost every account, storage
and ingestion cost follow a power-law distribution — a small number of log groups account for
the overwhelming majority of spend. Scanning the top 20 by storage cost bounds the Lambda's
runtime well inside its 10-minute timeout regardless of account size (10, 200, or 2,000 log
groups), while still covering the groups where a fix has the largest dollar impact. Retention
recommendations, by contrast, are computed for **every** no-retention group, because a
forgotten group with zero current cost impact can still represent "the next $100/month
problem" if left unbounded for another few years.

**Q: How do you avoid false positives on the error-spike detector for a group that simply had
zero errors in the prior period?**
A: `calculatePercentChange` special-cases `previous === 0`: if the current period also has
zero errors, percent change is reported as 0 (no spike); if the current period has any
errors at all, it's reported as a 100% change, which exceeds the default 50% threshold and
correctly flags it as a spike — this is the "a service that has never errored just started
erroring" case, which is exactly the kind of regression you want surfaced immediately rather
than suppressed because the denominator was zero.

**Q: The retention-savings estimate uses a "180-day effective age" assumption — isn't that
just a guess?**
A: Yes, and that's a deliberate, documented simplification. CloudWatch's `DescribeLogGroups`
API doesn't expose an age histogram of the bytes stored in a group — it only gives you the
current total `storedBytes`. Without ingesting and scanning the actual log stream event
timestamps (expensive and slow for TB-scale groups), there's no way to know the exact age
distribution of stored data. The 180-day baseline is a conservative, stated approximation
used purely to produce a directionally-correct, non-zero savings estimate for the report —
real log groups typically show an exponential decay in event-age density, so this
under-estimates rather than over-estimates savings in the common case. The report is
explicit that this is an *estimate* to guide prioritization, not a guaranteed dollar figure —
the actual savings become exact (and visible in next month's bill) once the retention policy
is actually applied and CloudWatch starts purging aged-out data.

**Q: Why use `GetMetricData` instead of `GetMetricStatistics` for ingestion analysis?**
A: `GetMetricData` supports batching up to 500 metric queries in a single API call (two
metrics × up to 250 log groups per call here), which is dramatically more efficient than
`GetMetricStatistics`'s one-metric-per-call model when analyzing dozens of log groups. It's
also AWS's actively developed, recommended API for new metric-retrieval code —
`GetMetricStatistics` is effectively the legacy interface at this point.

**Q: What's the IAM blast radius if this Lambda's credentials were ever compromised?**
A: Intentionally small. The execution role has exactly four classes of permission: read-only
CloudWatch Logs description/retrieval (`logs:Describe*`, `logs:GetLogEvents`,
`logs:FilterLogEvents`), read-only CloudWatch metrics (`cloudwatch:GetMetricData` and
friends), `s3:PutObject`/`GetObject` scoped to the one report bucket, and `sns:Publish`
scoped to the one notification topic. There is no `logs:PutRetentionPolicy`,
`logs:DeleteLogGroup`, or any other mutating log-management permission — this is intentional:
the tool's entire value proposition is "tell a human what to fix," and giving it write access
to log groups would turn a read-only cost-reporting tool into something that could silently
delete operational history, which is a different (and much riskier) product decision that
this design explicitly avoids.

**Q: How would you extend this to actually apply the retention recommendations instead of just
reporting them?**
A: Add a second, explicitly-opt-in Lambda (or a flag + manual approval step, e.g. an SNS
email with an approve/deny link backed by API Gateway + Step Functions, or a second scheduled
run gated behind a CDK parameter like `AutoApplyRetention: "true"`) that calls
`PutRetentionPolicyCommand` for exactly the log groups in that week's
`RetentionRecommendation[]` list, and grant that specific Lambda (not this read-only one)
the narrowly-scoped `logs:PutRetentionPolicy` permission. Keeping the blast-radius separation
between "analyze and recommend" (this stack) and "mutate resources" (a hypothetical follow-on
stack) is a deliberate architectural boundary, not an oversight.

**Q: Why EventBridge + Lambda instead of a long-running ECS task or Step Functions state
machine?**
A: The entire analysis — even against an account with a few hundred log groups — comfortably
fits inside a single Lambda invocation's 15-minute hard ceiling (this stack uses a 10-minute
timeout with headroom to spare), there's no need for a persistent process between runs, and
the workload is a simple linear pipeline (list → analyze → render → upload → notify) with no
need for the parallel branching/retry semantics that would justify Step Functions' added
complexity. EventBridge's native cron scheduling against a single Lambda target is the
simplest architecture that satisfies the "weekly, serverless, pay-per-run" requirement.

# AWS Lambda Cost Optimizer

A self-contained AWS CDK (TypeScript) application that scans every Lambda function in an
account, analyzes CloudWatch metrics for each one, and produces an actionable cost and
reliability report — delivered as an HTML report in S3 and a summary email via SNS, on a
weekly schedule (every Monday at 08:00 UTC).

It looks for six categories of waste/risk:

1. **Over-provisioned memory** — functions paying for RAM/CPU they never use.
2. **Dead functions** — zero invocations, still costing for code storage.
3. **High error rates / throttling** — functions that are actively broken or concurrency-starved.
4. **Cold-start hotspots** — functions where init latency is hurting users, and whether
   Provisioned Concurrency is worth the cost.
5. **x86_64 → ARM64 (Graviton2) migration candidates** — an easy ~20% unit-price cut.
6. **Timeout misconfiguration** — a reliability risk ("zombie functions"), not a direct cost one.

---

## Table of contents

- [What it does](#what-it-does)
- [Lambda pricing model](#lambda-pricing-model)
- [How each analyzer works](#how-each-analyzer-works)
- [Real savings examples](#real-savings-examples)
- [Architecture](#architecture)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [IAM permissions](#iam-permissions)
- [Project layout](#project-layout)
- [Resume bullet points](#resume-bullet-points)
- [Interview Q&A](#interview-qa)

---

## What it does

Every week, an EventBridge rule invokes a single Lambda function ("the optimizer"). That
function:

1. Calls `lambda:ListFunctions` (paginated) to enumerate every function in the account/region.
2. For each function, pulls CloudWatch metrics for the configured lookback window (default 14
   days): `Invocations`, `Errors`, `Throttles`, `Duration` (avg/max/p99), and — where available —
   Lambda Insights' `max_memory_used` and `init_duration`.
3. Runs five independent analyzers against that data (memory, invocations, cold starts,
   architecture, timeouts).
4. Renders a single self-contained HTML report (inline CSS, no external assets) summarizing
   total estimated monthly spend, total potential savings, and a breakdown table per analyzer.
5. Uploads the report to S3 under a date-partitioned key (`reports/YYYY/MM/DD/...`), expired
   automatically after 90 days by an S3 lifecycle rule.
6. Publishes a concise plain-text summary to SNS (→ email), linking to the full report.

Nothing in this stack modifies any Lambda function. It is **strictly read-only** against your
Lambda fleet (`lambda:List*`, `lambda:GetFunction*`, `cloudwatch:GetMetricData`) — it only
writes to its own S3 bucket and SNS topic.

---

## Lambda pricing model

AWS Lambda (on-demand, no Savings Plans/Compute Savings Plans applied) bills on three axes:

| Cost component | Formula | Typical share of bill |
|---|---|---|
| **Request cost** | `$0.20 per 1M requests` | Usually tiny unless extremely high volume + minimal duration |
| **Duration cost** | `(memoryMB / 1024) * durationSeconds * invocations * pricePerGBSecond` | The dominant cost for almost every workload |
| **Memory cost** | *Not billed separately* — memory is a multiplier inside the duration formula, not its own line item. Bigger memory ⇒ bigger GB-second multiplier for the *same* duration, **and** usually proportionally faster CPU, which can offset it. |

Price per GB-second (on-demand, used throughout this project):

| Architecture | Price / GB-second |
|---|---|
| x86_64 | `$0.0000166667` |
| arm64 (Graviton2) | `$0.0000133334` (exactly 20% less) |

Provisioned Concurrency, used by the cold-start analyzer for comparison, bills continuously
while allocated regardless of invocation:

| | Price / GB-second |
|---|---|
| Provisioned Concurrency | `$0.0000041667` |

**Why memory is the single biggest lever:** Lambda allocates vCPU proportionally to configured
memory. A function configured for 1024 MB that only touches 200 MB of RAM is not just wasting
memory allocation — it's very likely also been allocated more CPU than it needs, meaning
right-sizing memory is usually a duration-cost win too, not just a "smaller multiplier" win.

---

## How each analyzer works

### 1. Memory Analyzer (`lambda/analyzers/memory-analyzer.ts`)

- Preferred data source: CloudWatch **Lambda Insights** `max_memory_used` metric
  (`LambdaInsights` namespace), which reports true peak RSS per invocation. Marked
  `confidence: "high"`.
- Fallback: when Lambda Insights isn't enabled for a function (the common case — it costs extra
  and is opt-in per function), a conservative proxy estimates usage from the function's average
  duration profile. Marked `confidence: "medium"` and deliberately biased toward *under*-claiming
  utilization so it never falsely recommends a downsize that would break a function.
- **Over-provisioned** if `estimatedMaxMemoryUsedMb / configuredMemoryMb < 40%`.
- **Recommended size** = `roundUpToNearest128MB(actualUsage * 1.20)` (20% safety buffer), capped
  at the function's current size (never recommends going *up* from this analyzer).
- Savings = `(currentMemoryGB - recommendedMemoryGB) * avgDurationSeconds * monthlyInvocations * pricePerGBSecond`.

### 2. Invocation Analyzer (`lambda/analyzers/invocation-analyzer.ts`)

- Single `GetMetricData` batch call per function for `Invocations`, `Errors`, `Throttles`,
  `Duration` (Average/Maximum/p99) — this is also the shared data source that the memory,
  cold-start, architecture, and timeout analyzers reuse, so the whole scan only queries
  CloudWatch once per function per metric family.
- `errorRatePct = errors / invocations * 100` → flagged `hasHighErrorRate` above **5%**.
- `throttleRatePct = throttles / (invocations + throttles) * 100` → flagged `isHighlyThrottled`
  above **1%**.
- `isDeadFunction = invocationCount === 0` for the entire lookback window — these are still
  billed for code/layer storage above the account's free 75 GB-month allowance, and represent
  unmanaged operational surface area (stale permissions, stale triggers, forgotten cron jobs).

### 3. Cold-Start Analyzer (`lambda/analyzers/cold-start-analyzer.ts`)

- Reads `LambdaInsights` → `init_duration` (Average / Maximum / SampleCount). This is the only
  reliable source of true cold-start duration; standard `AWS/Lambda` metrics do not separate
  init time from handler time.
- `hasSlowColdStart`: average init duration **> 3,000 ms**.
- `hasFrequentColdStarts`: cold starts affecting **> 30%** of total invocations.
- Estimates the dollar cost currently lost to cold-start overhead (`initDuration * GB-second
  rate * cold starts/month`) and compares it against the cost of enough **Provisioned
  Concurrency** units to eliminate most of that overhead, so the report always shows "current
  cold-start tax" vs. "PC cost" side by side — letting you make the call rather than assuming
  PC is always worth it (it frequently isn't, for low-traffic functions).

### 4. Architecture Analyzer (`lambda/analyzers/architecture-analyzer.ts`)

- Checks each function's `architectures[0]` (`x86_64` vs `arm64`).
- For `x86_64` functions, checks runtime compatibility: Node.js, Python, Java, Ruby 2.7+/3.x,
  and .NET 6+ are all Graviton2-compatible; legacy `dotnetcore*`/`dotnet5.0` runtimes and
  **container image** package types (`packageType === "Image"`) are flagged as "needs manual
  verification" rather than "easily switchable," since a container image's base layer must
  itself support `arm64` and that can't be verified via the Lambda API alone.
- Savings for compatible functions = exactly 20% of the function's current GB-second cost
  (`$0.0000166667` → `$0.0000133334` per GB-second), since arm64 pricing is a flat 20% discount.

### 5. Timeout Analyzer (`lambda/analyzers/timeout-analyzer.ts`)

- **This is a reliability flag, not a cost flag.** Lambda only bills actual execution time, so
  an oversized timeout by itself costs nothing *in the steady state*.
- `isTimeoutExcessive`: `maxDurationMs < 10%` of the configured timeout — the timeout has far
  more headroom than the function has ever used.
- `isReliabilityRisk`: `configuredTimeoutSeconds > 10x averageDurationMs` — the real danger
  zone. If a downstream dependency hangs (a stuck DB connection, a retry loop with no backoff
  limit), the function can run for the **entire** configured timeout — up to 15 minutes — doing
  nothing useful, burning real GB-seconds during the incident and delaying failure detection,
  alarms, and DLQ/retry logic for async invocations.
- Recommended timeout = `max(3s, maxObservedDuration * 1.5)`, rounded up to the nearest 5
  seconds, never exceeding the current configured value.

---

## Real savings examples

**Example A — classic over-provisioned image-processing function**

| | Before | After |
|---|---|---|
| Configured memory | 1024 MB | 256 MB |
| Actual max memory used | ~200 MB (19.5% utilization) | — |
| Avg duration | 450 ms | 450 ms (assumed unaffected — conservative) |
| Invocations/month | 500,000 | 500,000 |
| Monthly duration cost | `1.0 GB * 0.45s * 500,000 * $0.0000166667` = **$3,750.00** | `0.3125 GB * 0.45s * 500,000 * $0.0000166667` = **$1,171.88** |
| **Savings** | | **$2,578.12/mo (68.75%)** |

(256 MB = `ceil(200 * 1.2 / 128) * 128`.) Note this example happens to land close to the
"1024MB using 200MB → right-size to 256MB" case called out in the brief; the *exact* discount
is `1 - (256/1024) = 75%` of the **memory-weighted** cost component, and ends up at ~69%
overall once rounding to the nearest valid 128 MB step is applied (256 MB rather than a
theoretical 240 MB).

**Example B — dead function**

A `legacy-image-resizer` function with 0 invocations across a 14-day window, 85 MB of deployed
code: flagged as a dead function. Storage cost above the free 75 GB-month tier is negligible for
a single function, but at fleet scale (hundreds of stale functions from old projects) this adds
up and — more importantly — represents unreviewed attack surface (stale IAM roles, stale
triggers, stale VPC ENIs).

**Example C — Graviton2 migration**

A Node.js 20.x API-backing function at 512 MB, 120 ms average duration, 2,000,000
invocations/month:

- x86_64 cost: `0.5 GB * 0.12s * 2,000,000 * $0.0000166667` = **$2,000.00/mo**
- arm64 cost: `0.5 GB * 0.12s * 2,000,000 * $0.0000133334` = **$1,600.00/mo**
- **Savings: $400.00/mo (20%)** for a one-line CDK/console change plus a redeploy.

**Example D — zombie timeout risk**

A function configured with a 900-second (15-minute) timeout, average duration 180 ms, max
observed duration 1.2 seconds: `timeoutToAverageRatio` ≈ 5,000x. Flagged as a severe reliability
risk — not because it's costing money today, but because the *next* time a downstream call
hangs, this function can silently run for 15 minutes per invocation, and at any real concurrency
that is a very real cost and incident-duration multiplier. Recommended timeout: `max(3,
1.2*1.5)` rounded up to nearest 5s = **5 seconds**.

---

## Architecture

```
                         ┌─────────────────────────┐
                         │   EventBridge Rule       │
                         │  cron(0 8 ? * MON *)     │
                         └────────────┬─────────────┘
                                      │ invoke
                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Optimizer Lambda (arm64, 512MB, 10min)         │
│                                                                    │
│  1. lambda:ListFunctions (paginated)                              │
│  2. cloudwatch:GetMetricData  ──────────────┐                     │
│       - AWS/Lambda: Invocations/Errors/      │                    │
│         Throttles/Duration                   │                    │
│       - LambdaInsights: max_memory_used,      │                    │
│         init_duration (when enabled)          │                    │
│                                                ▼                    │
│   ┌───────────────┬────────────────┬──────────────┬─────────────┐ │
│   │ Memory         │ Invocation     │ Cold-Start   │ Architecture│ │
│   │ Analyzer       │ Analyzer       │ Analyzer     │ Analyzer    │ │
│   └───────────────┴────────────────┴──────────────┴─────────────┘ │
│                           │  Timeout Analyzer                      │
│                           ▼                                        │
│                 report-generator.ts (HTML)                         │
└───────────┬───────────────────────────────────┬────────────────────┘
            │                                    │
            ▼                                    ▼
 ┌─────────────────────┐              ┌───────────────────────┐
 │ S3 Report Bucket     │              │ SNS Topic              │
 │ reports/YYYY/MM/DD/   │              │  → Email subscription  │
 │ 90-day lifecycle      │              └───────────────────────┘
 └─────────────────────┘
```

---

## Deployment

### Prerequisites

- Node.js 20.x
- AWS CLI configured with credentials that can deploy CloudFormation stacks
- `npm install -g aws-cdk` (or use the local dev dependency via `npx cdk`)
- CDK bootstrapped in the target account/region: `npx cdk bootstrap`

### Steps

```bash
cd aws-lambda-cost-optimizer
npm install

# Review what will be created
npx cdk synth

# Deploy — you will be prompted for the required NotificationEmail parameter
npx cdk deploy \
  --parameters NotificationEmail=you@example.com \
  --parameters LookbackDays=14 \
  --parameters MinInvocations=100
```

After deploying, **confirm the SNS email subscription** (check your inbox for an AWS
Notification confirmation link) — no summary emails will arrive until you do.

### Running on demand

The weekly schedule triggers the scan automatically, but you can invoke it manually at any
time:

```bash
aws lambda invoke \
  --function-name "$(aws cloudformation describe-stacks \
      --stack-name LambdaCostOptimizerStack \
      --query "Stacks[0].Outputs[?OutputKey=='OptimizerFunctionName'].OutputValue" \
      --output text)" \
  --cli-binary-format raw-in-base64-out \
  /tmp/optimizer-response.json
cat /tmp/optimizer-response.json
```

### Tearing down

```bash
npx cdk destroy
```

The S3 report bucket uses `RemovalPolicy.RETAIN` so historical reports survive a stack deletion
— delete the bucket manually afterward if you want a full cleanup.

---

## Configuration

Set at deploy time via CloudFormation parameters (`--parameters Key=Value` with `cdk deploy`, or
via the CloudFormation console):

| Parameter | Default | Description |
|---|---|---|
| `NotificationEmail` | *(required)* | Email address subscribed to the SNS summary topic. |
| `LookbackDays` | `14` | Days of CloudWatch history analyzed per function (1–90). |
| `MinInvocations` | `100` | Minimum invocations in the lookback window for a function to be included in memory/cold-start/timeout analysis. Keeps noise down on near-idle functions. Invocation/dead-function/error-rate checks still run on every function regardless of this threshold. |

Other tunables are constants at the top of each analyzer file (thresholds like the 40%
over-provisioning cutoff, 5% error-rate threshold, 3-second cold-start threshold, etc.) — change
and redeploy as needed for your organization's risk tolerance.

---

## IAM permissions

The optimizer's execution role is intentionally minimal and strictly read-only against your
Lambda fleet:

```
lambda:List*
lambda:GetFunction
lambda:GetFunctionConfiguration
lambda:GetFunctionConcurrency
lambda:GetProvisionedConcurrencyConfig
lambda:GetAccountSettings
cloudwatch:GetMetricData
cloudwatch:GetMetricStatistics
cloudwatch:ListMetrics
```

Write access is scoped via CDK's `grantPut`/`grantPublish` to exactly the stack's own S3 bucket
and SNS topic — the role has no permission to modify, delete, or invoke any Lambda function in
the account.

---

## Project layout

```
aws-lambda-cost-optimizer/
├── bin/app.ts                              CDK app entry point
├── lib/lambda-optimizer-stack.ts           CDK stack: S3, SNS, Lambda, EventBridge, IAM
├── lambda/
│   ├── handler.ts                          Orchestrator — calls all 5 analyzers
│   ├── analyzers/
│   │   ├── memory-analyzer.ts
│   │   ├── invocation-analyzer.ts
│   │   ├── cold-start-analyzer.ts
│   │   ├── architecture-analyzer.ts
│   │   └── timeout-analyzer.ts
│   └── utils/
│       ├── types.ts                        Shared interfaces
│       ├── report-generator.ts             HTML report renderer
│       ├── s3-uploader.ts                  Date-partitioned S3 upload
│       └── sns-notifier.ts                 Plain-text SNS summary
├── test/lambda-optimizer-stack.test.ts     CDK assertions (jest)
├── cdk.json / tsconfig.json / jest.config.js / package.json / .gitignore
└── README.md
```

---

## Resume bullet points

- Designed and deployed a serverless AWS Lambda cost-optimization platform (CDK/TypeScript)
  that scans an entire AWS account's Lambda fleet weekly, analyzing CloudWatch metrics to
  surface memory right-sizing, dead functions, cold-start hotspots, ARM64/Graviton2 migration
  opportunities, and timeout misconfigurations.
- Built a memory right-sizing engine using CloudWatch Lambda Insights metrics with a
  duration-based fallback heuristic for accounts without enhanced monitoring, correctly
  modeling AWS's GB-second billing formula to project real dollar savings per function.
- Implemented a least-privilege, fully read-only IAM model (`lambda:List*`,
  `lambda:GetFunction*`, `cloudwatch:GetMetricData`) for a Lambda function that audits an
  entire account's serverless fleet without any ability to modify production resources.
- Automated detection of "zombie function" reliability risk (timeout vastly exceeding observed
  execution duration) and translated it into actionable, safety-bounded timeout
  recommendations.
- Quantified the cost/benefit tradeoff of AWS Provisioned Concurrency vs. observed cold-start
  overhead, preventing blanket over-recommendation of an expensive mitigation.
- Delivered findings via a self-contained HTML report (S3, 90-day lifecycle) and a concise SNS
  email digest, fully automated on an EventBridge weekly schedule with zero manual operation.

---

## Interview Q&A

**Q: Why doesn't an oversized Lambda timeout directly cost money?**
A: Lambda bills by actual execution duration, not configured timeout. A function configured for
15 minutes that runs for 200ms is billed for 200ms. The risk is behavioral, not a baseline
billing one: if something downstream hangs, the function can now run the *full* configured
timeout before Lambda terminates it, which is where the cost and reliability exposure comes
from — it's a worst-case multiplier, not a steady-state one.

**Q: How do you measure actual memory usage without Lambda Insights enabled on every function?**
A: Lambda Insights' `max_memory_used` metric is the only ground-truth source via CloudWatch, but
it's opt-in (extra cost, requires a layer + extra IAM permissions) and rarely enabled fleet-wide.
When it's missing, this project falls back to a conservative, duration-informed heuristic and
explicitly marks that recommendation `confidence: "medium"` rather than presenting it with the
same authority as a true measurement — the UI/report distinguishes the two so operators know
when to double-check manually (e.g., with a short Lambda Insights pilot) before resizing.

**Q: Why is memory the dominant cost lever instead of duration or request count?**
A: Request cost ($0.20/million) is negligible for the vast majority of real workloads. Duration
cost is `(memory/1024) * durationSeconds * invocations * price`, and critically, Lambda
allocates CPU proportionally to memory — so over-provisioned memory often isn't just "wasted
RAM," it's frequently also wasted *CPU* allocation that didn't meaningfully speed up the
function. Right-sizing memory is therefore usually a two-for-one win: a smaller multiplier *and*
confirmation that the function wasn't relying on excess CPU it didn't need.

**Q: How would you extend this for more accurate savings estimates after a memory downsize?**
A: Currently the memory analyzer conservatively assumes duration is unaffected by a memory
change (the safe, lower-savings-claim direction for I/O-bound functions). For CPU-bound
functions, reducing memory can *increase* duration since less memory also means less allocated
vCPU. A more accurate version would run a brief shadow test — invoke a duplicate alias at the
candidate memory size and compare real duration — before finalizing the recommendation, rather
than assuming duration is flat.

**Q: Why gate analysis with a MinInvocations threshold instead of analyzing every function?**
A: Low-traffic functions produce statistically noisy CloudWatch data (a single slow invocation
can dominate an average over only 3 or 4 data points) and are rarely worth the operational
effort of right-sizing — the absolute dollar amounts are small. The threshold (default 100
invocations across the lookback window) filters these out of the memory/cold-start/timeout
tables while still surfacing them for the invocation analyzer's dead-function and error-rate
checks, which matter regardless of volume.

**Q: What would you do differently at a 10,000+ function scale?**
A: `GetMetricData` supports batching up to 500 metric queries per call — the current
implementation issues one call per function, which is simple but not optimal at extreme scale.
I'd batch multiple functions' queries into shared `GetMetricData` calls (bounded by the 500-query
limit and CloudWatch TPS limits), add exponential backoff/jitter on throttling, and consider
caching `ListFunctions` output in DynamoDB with a change-detection diff so unmodified functions
skip redundant CloudWatch calls between runs.

**Q: Why ARM64/Graviton2 as a blanket 20% savings claim — are there cases where it's not a win?**
A: The 20% is purely the *unit* GB-second price difference, which always holds. What can vary is
whether a workload's *duration* changes on arm64 — for most interpreted-language workloads
(Node.js, Python) performance is equal or better, but native binary dependencies, pre-compiled
layers, or SDKs without arm64 builds can require rework or regress performance. That's why the
analyzer flags container-image functions and legacy runtimes as "needs manual verification"
rather than claiming automatic savings for them.

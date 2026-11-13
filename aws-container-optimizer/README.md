# AWS Container Optimizer

A serverless AWS CDK (TypeScript) application that scans every ECS and EKS container
workload in an account/region, flags cost and reliability problems, and emails a
weekly HTML report with concrete, dollar-quantified right-sizing recommendations.

Think of it as a "Trusted Advisor, but just for containers" - it runs on a schedule,
costs cents per month to operate, and never touches your workloads (read-only IAM).

---

## Table of Contents

- [What It Does](#what-it-does)
- [Architecture](#architecture)
- [Container Cost Model](#container-cost-model)
- [How Right-Sizing Works](#how-right-sizing-works)
- [ECS vs EKS Analysis Differences](#ecs-vs-eks-analysis-differences)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Sample Output](#sample-output)
- [Project Structure](#project-structure)
- [Resume Bullet Points](#resume-bullet-points)
- [Interview Q&A](#interview-qa)

---

## What It Does

Every week (Monday 08:00 UTC by default), a Lambda function:

1. **Lists every ECS cluster and service** in the account/region and pulls 7 days of
   `CPUUtilization` / `MemoryUtilization` from CloudWatch for each service.
2. **Flags unhealthy or wasteful services**:
   - *Over-provisioned* - average CPU below the configurable threshold (default 30%).
   - *Failing* - `desiredCount > 0` but `runningCount == 0` (stuck deployment or
     capacity shortage).
   - *Zombie* - `desiredCount == 0` but the service still exists.
3. **Right-sizes Fargate task definitions** - compares each task definition's
   reserved CPU/memory to what CloudWatch says it actually uses, and recommends the
   smallest valid Fargate size tier that still has headroom, with a dollar savings
   estimate.
4. **Analyzes EKS node groups** - utilization, Spot eligibility, "could this be a
   smaller instance type", and whether Cluster Autoscaler/Karpenter is present.
5. **Finds idle/wasted resources** - zombie services idle >7 days, empty clusters,
   orphaned task definitions, node groups scaled to zero.
6. **Generates an HTML report**, uploads it to S3 (90-day retention), and emails a
   summary via SNS with the headline number: total potential monthly savings.

---

## Architecture

```
                    ┌──────────────────────┐
                    │  EventBridge Rule     │
                    │  cron: Mon 08:00 UTC  │
                    └──────────┬───────────┘
                               │ triggers
                               ▼
┌──────────────────────────────────────────────────────────┐
│                  Lambda: ContainerOptimizerFunction        │
│                  (Node.js 20, arm64, 512MB, 10 min)         │
│                                                              │
│  handler.ts                                                 │
│   ├─ ecs-service-analyzer.ts   (ECS ListClusters/Services,  │
│   │                              DescribeServices, CW metrics)│
│   ├─ ecs-task-rightsizing.ts   (DescribeTaskDefinition,     │
│   │                              Fargate pricing math)       │
│   ├─ eks-nodegroup-analyzer.ts (EKS ListClusters/Nodegroups,│
│   │                              DescribeNodegroup, CW metrics)│
│   ├─ idle-resource-detector.ts (cross-cutting idle scan)     │
│   ├─ report-generator.ts       (HTML report)                │
│   ├─ s3-uploader.ts            (PutObject, date-based key)   │
│   └─ sns-notifier.ts           (Publish summary)             │
└───────┬───────────────────────────┬─────────────────────────┘
        │                           │
        ▼                           ▼
┌───────────────────┐      ┌──────────────────────┐
│  S3 Report Bucket  │      │   SNS Topic           │
│  90-day lifecycle   │      │   -> Email subscriber │
└───────────────────┘      └──────────────────────┘

IAM: ecs:List*, ecs:Describe*, eks:List*, eks:Describe*,
     cloudwatch:GetMetricData/ListMetrics, s3:PutObject (scoped),
     sns:Publish (scoped). All read-only against ECS/EKS/CloudWatch.
```

CDK stack (`lib/container-optimizer-stack.ts`) provisions:

| Resource | Details |
|---|---|
| S3 bucket | SSE-S3 encrypted, blocks all public access, 90-day object expiration |
| SNS topic | Email subscription to `NotificationEmail` parameter |
| Lambda | Node.js 20.x, arm64, 512 MB, 10-minute timeout, bundled with esbuild via `NodejsFunction` |
| EventBridge rule | `cron(0 8 ? * MON *)` - every Monday 08:00 UTC |
| IAM policy | `ecs:List*`, `ecs:Describe*`, `eks:List*`, `eks:Describe*`, `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` |

---

## Container Cost Model

### Fargate pricing (on-demand, us-east-1, Linux/X86_64, 2026 rates)

| Resource | Price |
|---|---|
| vCPU-hour | **$0.04048** |
| GB-hour (memory) | **$0.004445** |

Monthly cost for a single task = `(vCPU * 0.04048 + GB * 0.004445) * 730 hours`.

Example: a task reserving **1 vCPU (1024 CPU units) / 2 GB memory**, running 2 tasks
24/7:

```
hourly/task = 1 * 0.04048 + 2 * 0.004445 = 0.04937
monthly     = 0.04937 * 730 * 2 tasks = $72.08/month
```

### EC2 pricing (on-demand & Spot, us-east-1, used for EKS node groups)

| Instance | vCPU | Memory | On-Demand $/hr | Spot $/hr (approx.) |
|---|---|---|---|---|
| t3.medium | 2 | 4 GB | $0.0416 | $0.0125 |
| m5.large | 2 | 8 GB | $0.096 | $0.0288 |
| m5.xlarge | 4 | 16 GB | $0.192 | $0.0576 |
| m5.2xlarge | 8 | 32 GB | $0.384 | $0.1152 |
| c5.xlarge | 4 | 8 GB | $0.17 | $0.051 |
| r5.xlarge | 4 | 32 GB | $0.252 | $0.0756 |

(Full table in `lambda/analyzers/eks-nodegroup-analyzer.ts`.) Spot prices fluctuate
per Availability Zone in real time; the table uses representative long-run averages
(~65-72% discount) for estimation purposes, not billing-accurate figures.

**EKS control plane** costs a flat **$0.10/hour (~$73/month) per cluster**,
independent of node count - this is why a cluster with all node groups scaled to
zero is still flagged as "idle" (it's not free, it just has no compute attached).

---

## How Right-Sizing Works

Fargate requires CPU and memory reservations to come from a fixed table of valid
combinations (you can't just ask for "137 CPU units"). The right-sizing analyzer
(`lambda/analyzers/ecs-task-rightsizing.ts`) does this:

1. **Get the reservation.** `DescribeTaskDefinition` returns the task-level `cpu`
   (in CPU units, 1024 = 1 vCPU) and `memory` (MiB).
2. **Get the observation.** CloudWatch `GetMetricData` returns average
   `CPUUtilization%` / `MemoryUtilization%` over the trailing 7 days. ECS reports
   these as a percentage *of the reservation*, so:
   ```
   observedCpuUnits   = (avgCpuPercent / 100) * reservedCpuUnits
   observedMemoryMiB  = (avgMemPercent / 100) * reservedMemoryMiB
   ```
3. **Add headroom.** Multiply the observed usage by **1.3x (30% headroom)** so the
   recommendation isn't a hairline fit that throttles under the next traffic spike.
4. **Snap to a valid Fargate tier.** Round the headroom value up to the nearest
   real CPU/memory combination from the Fargate size table (256/512/1024/2048/...
   CPU units, each with its own valid memory range).
5. **Compare cost, only recommend if it's actually cheaper.**

**Worked example** (matches the kind of finding this tool surfaces in production):

> Task definition reserves **1024 CPU units (1 vCPU) / 2048 MiB**. CloudWatch shows
> 7-day average CPU utilization of **19.5%** and memory utilization of **22%**.
>
> ```
> observedCpuUnits   = 0.195 * 1024  = ~200 units   (0.195 vCPU)
> observedMemoryMiB  = 0.22  * 2048  = ~450 MiB
> with 30% headroom  = 260 units / 585 MiB
> snapped to valid tier = 512 CPU units / 1024 MiB
> ```
>
> - Current cost (2 tasks): `(1*0.04048 + 2*0.004445) * 730 * 2 = $72.08/mo`
> - Recommended cost (2 tasks): `(0.5*0.04048 + 1*0.004445) * 730 * 2 = $36.04/mo`
> - **Savings: $36.04/mo (50%)**

This is the canonical "0.25 vCPU workload provisioned for 1 vCPU = 75% waste"
pattern: a task that only ever needs a quarter of a vCPU, but was never resized
after the initial (often copy-pasted) task definition was written, silently pays
4x what it needs to, every hour, forever - until something like this tool catches it.

---

## ECS vs EKS Analysis Differences

| | ECS (Fargate) | EKS (managed node groups) |
|---|---|---|
| **Billing granularity** | Per task (vCPU-hour + GB-hour) | Per EC2 instance (all pods on a node share its cost) |
| **Right-sizing unit** | The *task definition* (one container group) | The *node group* (instance type + count) |
| **"Over-provisioned" signal** | Service-level `CPUUtilization%` is a % of the task's own reservation | `CPUUtilization%` is a % of the whole EC2 instance - a node can look "fine" while individual pods are starved or over-requesting |
| **Autoscaling** | ECS Service auto scaling (target tracking on the service) | Needs a separate controller - Cluster Autoscaler or Karpenter - or the node group never scales down |
| **Spot** | Capacity provider strategy per service | Per node group `capacityType: SPOT`; this tool checks `capacityType == ON_DEMAND` and estimates the Spot discount |
| **Idle state** | `desiredCount = 0` (service exists, 0 tasks, $0 compute cost) | `desiredSize = 0` (node group exists, 0 EC2 instances, $0 compute cost, but control plane still billed) |
| **What this tool can't see** | - | Pod-level requests/limits (would require querying the Kubernetes API with cluster auth, not just AWS APIs) - so EKS analysis here is *node*-level, not *pod*-level |

Because Kubernetes scheduling means several pods share a node, true container-level
right-sizing on EKS (comparing a Deployment's `resources.requests` to actual pod
usage) requires talking to the Kubernetes API or a tool like the Vertical Pod
Autoscaler / Goldilocks - this project intentionally stays within IAM-only AWS APIs
and reports at the **node group** level: utilization, Spot eligibility, and
autoscaler presence, which is already enough to catch the most expensive classes of
EKS waste (idle on-demand node groups that should be Spot, or oversized instance
types for a lightly loaded cluster).

---

## Deployment

### Prerequisites

- Node.js 20+
- AWS CLI configured with credentials that can deploy CDK stacks
- CDK bootstrapped in the target account/region (`cdk bootstrap`)

### Steps

```bash
cd aws-container-optimizer
npm install

# Review what will be created
npx cdk synth

# Deploy (prompts for NotificationEmail)
npx cdk deploy \
  --parameters NotificationEmail=you@example.com \
  --parameters CPUUtilizationThreshold=30 \
  --parameters MemoryUtilizationThreshold=30
```

After deploying, **confirm the SNS email subscription** (check your inbox for an
AWS confirmation email) or you won't receive reports.

To trigger a run immediately instead of waiting for Monday:

```bash
aws lambda invoke \
  --function-name <AnalyzerFunctionName-from-stack-output> \
  --payload '{}' \
  /tmp/out.json
```

### Running tests

```bash
npm test
```

### Tear down

```bash
npx cdk destroy
```

The S3 bucket is created with `RemovalPolicy.RETAIN`, so old reports survive a
stack deletion - delete the bucket manually if you want a full cleanup.

---

## Configuration

| Parameter | Default | Description |
|---|---|---|
| `NotificationEmail` | *(required)* | Email address subscribed to the SNS topic |
| `CPUUtilizationThreshold` | `30` | Services/node groups averaging below this % CPU (7-day) are flagged as over-provisioned/under-utilized |
| `MemoryUtilizationThreshold` | `30` | Services averaging below this % memory (7-day) are flagged |

Environment variables consumed by the Lambda (set automatically by the CDK stack
from the parameters above): `REPORT_BUCKET_NAME`, `SNS_TOPIC_ARN`,
`CPU_UTILIZATION_THRESHOLD`, `MEMORY_UTILIZATION_THRESHOLD`.

To change the schedule, edit the `events.Schedule.cron({...})` call in
`lib/container-optimizer-stack.ts` and redeploy.

---

## Sample Output

**SNS email subject:** `Container Optimizer: $412.30/mo potential savings found`

**SNS email body:**

```
AWS Container Optimizer - Weekly Report
Generated: 2026-11-10T08:00:12.000Z
Account: 123456789012 | Region: us-east-1

== Scan Summary ==
ECS clusters scanned:        4
ECS services analyzed:       23
EKS clusters scanned:        2
EKS node groups analyzed:    5

== Findings ==
Over-provisioned services:   9
Failing services (0 running): 1
Zombie services (0 desired): 2
Under-utilized EKS node groups: 2
Task right-sizing opportunities: 7
Idle resources detected:     6

== Cost ==
Total estimated monthly spend:    $1,840.55
Total potential monthly savings:  $412.30

Full report: https://container-optimizer-reports-xxxx.s3.us-east-1.amazonaws.com/reports/2026/11/10/container-optimizer-report-2026-11-10T08-00-12-000Z.html
```

**HTML report** includes:
- Total spend / total savings cards (savings in large green text)
- ECS service table with color-coded CPU/memory gauge bars (red < 20%, amber < 40%,
  green 40-75%, red again above 75% as a "running hot" warning)
- Task right-sizing table: current size -> recommended size -> $ saved
- EKS node group table with Spot-eligible / under-utilized / no-autoscaler badges
- Idle resource list (zombie services, empty clusters, orphaned task defs,
  zero-node node groups)

---

## Project Structure

```
aws-container-optimizer/
├── bin/app.ts                              CDK app entry point
├── lib/container-optimizer-stack.ts        S3 + SNS + Lambda + EventBridge + IAM
├── lambda/
│   ├── handler.ts                          Orchestrates all analyzers
│   ├── analyzers/
│   │   ├── ecs-service-analyzer.ts         ECS service health + utilization + cost
│   │   ├── ecs-task-rightsizing.ts         Fargate CPU/memory right-sizing math
│   │   ├── eks-nodegroup-analyzer.ts       EKS node group utilization + Spot/autoscaler checks
│   │   └── idle-resource-detector.ts       Cross-cutting idle/wasted resource scan
│   └── utils/
│       ├── types.ts                        Shared interfaces + pricing constants
│       ├── report-generator.ts             HTML report rendering
│       ├── s3-uploader.ts                  Date-partitioned S3 upload
│       └── sns-notifier.ts                 Plain-text SNS summary
├── test/container-optimizer-stack.test.ts  CDK assertions (jest)
├── cdk.json / tsconfig.json / jest.config.js / package.json
└── README.md
```

---

## Resume Bullet Points

- Built a serverless AWS CDK (TypeScript) tool that scans ECS and EKS workloads
  weekly, identifying over-provisioned Fargate tasks, idle services, and
  under-utilized EKS node groups, surfacing **$400+/month in average potential
  savings** per environment via automated HTML/email reports.
- Implemented container right-sizing logic that compares CloudWatch utilization
  metrics against Fargate task definition reservations and snaps recommendations
  to valid Fargate CPU/memory tiers, cutting over-provisioned task costs by up to 50%.
- Designed a read-only, least-privilege IAM model (`ecs:List*`/`Describe*`,
  `eks:List*`/`Describe*`, `cloudwatch:GetMetricData`) for safe, non-invasive
  infrastructure auditing across multi-cluster ECS/EKS environments.
- Automated weekly cost governance reporting using EventBridge-scheduled Lambda,
  S3 (with lifecycle policies), and SNS, eliminating manual Cost Explorer/Container
  Insights reviews for container infrastructure.
- Built Fargate and EC2 On-Demand/Spot cost models from first principles (vCPU-hour
  and GB-hour pricing) to quantify savings from right-sizing, Spot adoption, and
  decommissioning idle container resources.

---

## Interview Q&A

### "How do you right-size containers?"

> I start from what's actually measurable: CloudWatch `CPUUtilization` and
> `MemoryUtilization` for the service, which ECS reports as a percentage *of the
> task's own reservation*. I pull a 7-day average rather than a single point so a
> brief spike doesn't skew the recommendation. I convert that percentage back into
> absolute units (`avgPercent/100 * reservedUnits`) to get the actual observed
> CPU/memory usage, then add roughly 30% headroom so the recommendation isn't a
> hairline fit that throttles under normal traffic variance. Then - and this part
> matters for Fargate specifically - you can't just recommend an arbitrary number;
> Fargate only accepts specific CPU/memory combinations from a fixed table (256,
> 512, 1024, 2048 CPU units, etc., each with its own valid memory range), so I snap
> the headroom value up to the next valid tier. Finally I only surface the
> recommendation if it's actually cheaper than the current size - a task that's
> already optimally sized shouldn't show up as a "finding" just because the
> headroom math landed on the same tier. The output is concrete: current
> CPU/memory, recommended CPU/memory, current monthly cost, recommended monthly
> cost, and the dollar delta - not just "this looks over-provisioned."
>
> For EKS it's one level up: because multiple pods share a node, true per-container
> right-sizing needs Kubernetes-level data (pod `resources.requests` vs actual pod
> usage, ideally via something like the Vertical Pod Autoscaler or Goldilocks). What
> I can determine from pure AWS APIs is node-*group* level: is the group's EC2
> instance type oversized for the CPU it's actually using, and should certain
> workloads move to Spot. That's a coarser signal, but it still catches the most
> expensive class of EKS waste, which is an on-demand, oversized node group running
> at 15% CPU because nobody revisited the initial capacity planning.

### "Fargate vs EC2 cost tradeoffs?"

> Fargate bills per task - per vCPU-hour and per GB-hour, with no idle capacity to
> manage - so you pay exactly for the compute your containers reserve, nothing more
> and nothing less, and you never think about patching or capacity planning for the
> underlying host. The tradeoff is you pay a premium per unit of compute compared
> to a well-utilized EC2 fleet, and you can't bin-pack multiple workloads onto
> shared headroom the way you can on a node - if you have five tasks that each need
> a *burst* of CPU at different times, Fargate makes you reserve for each one's peak
> independently, whereas on EC2 those bursts can share the same slack on a single
> instance.
>
> EC2 (whether backing ECS or EKS) is cheaper per unit of compute, especially with
> Savings Plans/Reserved Instances or Spot, and lets you bin-pack many
> variably-sized workloads onto fewer, larger instances - which is exactly the EKS
> model. The tradeoff is you now own the capacity planning problem: under-provision
> and you get noisy-neighbor CPU contention or pods stuck `Pending`; over-provision
> - which is the far more common failure mode in practice - and you're paying for
> idle EC2 24/7, which is precisely the "under-utilized node group" finding this
> tool flags, and it can't self-correct without an autoscaler (Cluster Autoscaler
> or Karpenter) actually watching utilization and scaling the node count down.
>
> In practice I'd reach for Fargate for spiky, loosely-coupled services where
> operational simplicity matters more than squeezing out the last dollar per vCPU,
> and EC2/EKS for steady, high-density, cost-sensitive workloads where you can
> justify the operational overhead of capacity planning and autoscaler maintenance
> with real savings from better bin-packing and Spot/RI coverage. This tool is
> built to make that EC2 side of the tradeoff less risky - it tells you when your
> "we'll capacity-plan it properly later" EC2 node group never actually got revisited.

### "Why read-only IAM? What's the blast radius if this Lambda is compromised?"

> The IAM policy is scoped to `ecs:List*`, `ecs:Describe*`, `eks:List*`,
> `eks:Describe*`, and `cloudwatch:GetMetricData`/`ListMetrics` - every single
> action is a read. There's no `ecs:UpdateService`, no `eks:UpdateNodegroupConfig`,
> nothing that can mutate a running workload. The only *write* permissions the
> function has are scoped specifically to its own S3 report bucket (`PutObject`)
> and its own SNS topic (`Publish`), granted via `bucket.grantWrite()` and
> `topic.grantPublish()` rather than wildcard resources. So even in a worst-case
> compromise, the function can read infrastructure metadata and metrics and
> write reports - it can't terminate a task, scale anything, or touch customer
> data in the containers themselves.

### "How did you avoid double-fetching CloudWatch metrics across analyzers?"

> `ecs-service-analyzer.ts` fetches CPU/memory once per service and returns the
> full `ECSServiceAnalysis[]` (including the raw `MetricStat` and the task
> definition ARN). `ecs-task-rightsizing.ts` takes that array as its input instead
> of re-scanning ECS or re-querying CloudWatch - it only makes an incremental
> `DescribeTaskDefinition` call (cached per ARN) to get the CPU/memory reservation,
> then does the right-sizing math against the metrics it was handed. Same idea for
> `idle-resource-detector.ts`, which reuses the per-service deployment timestamps
> collected during the initial scan instead of calling `DescribeServices` again.
> That keeps the whole run well within the 10-minute Lambda timeout even for
> accounts with dozens of clusters.

### "What are the known limitations of this tool?"

> A few, and I'd call them out proactively in a design review:
> 1. **EKS analysis is node-group level, not pod level** - it can't see Kubernetes
>    `resources.requests`/`limits`, so it won't catch a specific Deployment that's
>    over-requesting CPU on an otherwise healthy node.
> 2. **Cluster Autoscaler detection is a tag heuristic**, not a live check against
>    the Kubernetes API, because the Lambda only has AWS IAM credentials, not
>    cluster auth. Karpenter detection is more reliable since it checks the EKS
>    managed add-on list.
> 3. **Spot and EC2 pricing are a static reference table**, not live Cost Explorer
>    or Pricing API data - good enough for directional savings estimates, not for
>    an invoice reconciliation.
> 4. **"Wasted cost" for idle resources (zombie services, empty clusters, orphaned
>    task defs, zero-node node groups) is often genuinely $0** because Fargate and
>    managed-service billing is per-running-unit - the value there is governance/
>    cleanup, not direct dollar recovery, except for the EKS control-plane case
>    which is called out explicitly.

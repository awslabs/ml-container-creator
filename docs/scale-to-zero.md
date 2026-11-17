<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# Scale-to-Zero (opt-in, real-time inference components)

MLCC can let a real-time endpoint scale down to **zero instances** when it is idle,
so you stop paying for the instance between bursts of traffic. It is off by default
and you turn it on per project. Decision record:
[ADR-014](adr/ADR-014-scale-from-zero.md).

!!! warning "Not for interactive SLAs"
    While the endpoint is at zero, requests **fail** until a copy is ready again.
    On the one measured reference (below) that took minutes, not seconds. Your
    model and instance were not measured. Use scale-to-zero for development, test and
    sporadic batch-like traffic that can retry, not for user-facing latency targets.

## Where it is available

The matrix below is generated from each target's descriptor
(`templates/do/targets.d/<target>/manifest.json`, the `scale_to_zero` block), so it
always matches what `do/deploy` accepts. In v2 only `realtime-inference` endpoints
backed by inference components are enabled. Every other target refuses
`--scale-to-zero` with exit code 3 and prints the reason shown here.

<!-- >>> GENERATED: scale-to-zero matrix (scripts/render-scale-to-zero-docs.js) — DO NOT EDIT -->
| Target | Support | Mechanism | Wake signal | Requests at zero | Idle billing | v2 | Reason when refused |
|---|---|---|---|---|---|---|---|
| `async-inference` | `native` | `sagemaker-async-backlog` | `HasBacklogWithoutCapacity` | `queued` | `none-at-zero` | refused | async scale-to-zero is a post-2.0 follow-up (ADR-014): async endpoints queue requests at zero and are the natural next target, but MLCC v2 does not wire it yet |
| `batch-transform` | `not-applicable` | — | — | `n/a` | `n/a` | refused | batch transform jobs do not idle: a job releases its instances when it completes (ADR-014) |
| `eks` | `requires-cluster-addon` | `keda-byo` | — | `unknown` | `nodes-still-billed` | refused | plain EKS needs a cluster-owned KEDA (plus node autoscaling) to scale to zero; MLCC installs nothing on a bring-your-own cluster (ADR-012, ADR-014) |
| `hyperpod-eks` | `pod-only` | `hyperpod-autoscalingspec` | — | `unknown` | `nodes-still-billed` | refused | scaling pods to zero on fixed HyperPod instance groups saves no node cost; scaling nodes to zero needs Karpenter NodePools, which is cluster provisioning MLCC does not do (ADR-012, ADR-014) |
| `realtime-inference` | `native` | `sagemaker-ic-step` | `NoCapacityInvocationFailures` | `fail` | `none-at-zero` | enabled | — |
<!-- <<< END GENERATED scale-to-zero matrix -->

`async-inference` is the natural next target: it is declared `native` because async
endpoints queue requests while at zero instead of failing them, but MLCC v2 does not
wire it yet. Enabling it later is a descriptor change plus one mechanism arm
(`sagemaker-async-backlog`) in `do/lib/scale-to-zero.sh`.

## Turning it on and off

```bash
# First deploy with scale-to-zero (max 2 copies / instances when busy)
./do/deploy --scale-to-zero on --scale-max 2

# Preview the plan and the warning; nothing is created
./do/deploy --scale-to-zero on --dry-run

# Turn it on for a deployment that is already live (in place, same endpoint and IC)
./do/deploy --reconfigure --scale-to-zero on --scale-max 2

# Turn it off: removes the scaling resources, restores a fixed floor of 1 copy on 1 instance
./do/deploy --reconfigure --scale-to-zero off
```

| Flag | Values | Stored in `do/config` |
|---|---|---|
| `--scale-to-zero <on\|off>` | `on` or `off` (anything else exits 1 before any AWS call) | `SCALE_TO_ZERO=true\|false` (default `false`) |
| `--scale-max <n>` | integer 1 to 20, default 1: the most IC copies and instances | `SCALE_MAX_CAPACITY` |

`SCALE_TO_ZERO`, `SCALE_MAX_CAPACITY` and `SCALE_TO_ZERO_STATUS` (`ok` / `failed`) are
runtime-owned, so `ml-container-creator regenerate` keeps them.

`do/deploy` refuses `--scale-to-zero on` (exit 3) on a real-time project when:

- the endpoint does not use inference components (checked on the live endpoint
  for `--reconfigure`; every MLCC real-time deploy creates them);
- `CAPACITY_RESERVATION_ARN` is set: reserved capacity is billed either way;
- `INSTANCE_POOLS` is set: scale-to-zero with heterogeneous pools is unverified;
- `ENDPOINT_STRATEGY` is not `new` (for example `existing`): MLCC does not own
  that endpoint's configuration.

Running `./do/deploy --scale-to-zero on` (without `--reconfigure`) on a live
deployment only saves the setting and tells you how to apply it.

## The warning

Every deploy, reconfigure and `--dry-run` with scale-to-zero on prints a plain
warning, and so does `./do/status` when the current copy count is 0. Its wording
follows the target's `requests_at_zero` (`fail` for real-time endpoints), and its
figures come from one data file, `do/lib/python/scale_to_zero_reference.json`. No
script repeats the numbers. They are:

<!-- >>> GENERATED: scale-to-zero reference (scripts/render-scale-to-zero-docs.js) — DO NOT EDIT -->
- Recovery from zero: **11.9 min mean** over 3 runs (10.9 / 11.8 / 12.9 min).
- Breakdown (min): 3.5 alarm and scaling decision · 2.1 instance · 6.0 container and model readiness · 0.2 first token.
- Measured on: Gemma-3-4B, ml.g7, vLLM 0.32.0, us-east-1.
- Source: owner study, AWS-documented IC scale-from-zero pattern (ADR-014 Context; tracker C3), 2026-10.
<!-- <<< END GENERATED scale-to-zero reference -->

`./do/status` adds one line, for example
`scale-to-zero: on (min 0, max 2); current copies: 0`, next to the existing
current/desired copy columns.

When `SCALE_TO_ZERO=true`, the Wave 9 benchmark cost caveat gains a second line:
savings accrue only on idle stretches longer than the scale-in delay, and each wake
costs the reference cold start in failed requests. MLCC does not compute an
idle-adjusted cost; that needs a traffic profile it does not have.

## What MLCC creates

MLCC follows AWS's documented pattern,
[Scale an endpoint to zero instances](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling-zero-instances.html):

1. The endpoint config variant gets
   [`ManagedInstanceScaling`](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_ProductionVariantManagedInstanceScaling.html)
   `{Status: ENABLED, MinInstanceCount: 0, MaxInstanceCount: <scale-max>}`.
2. After each inference component is `InService`, for each one:
    - a **scalable target**: `register-scalable-target`, namespace `sagemaker`,
      dimension `sagemaker:inference-component:DesiredCopyCount`, min 0, max `<scale-max>`;
    - a **target-tracking policy** (`<ic>-stz-tracking`) on
      `SageMakerInferenceComponentInvocationsPerCopy`, target 1, 300 s cooldowns (the
      AWS example values), which scales in to zero and out above one copy;
    - a **step-scaling policy** (`<ic>-stz-wake`): `ExactCapacity` 1;
    - a **CloudWatch alarm** (`<ic>-stz-no-capacity`) on `AWS/SageMaker`
      `NoCapacityInvocationFailures` for the IC (`Sum` ≥ 1 over 60 s), whose action is
      the step policy.

Each resource is recorded with `do/manifest add`. If any call fails, MLCC deletes
what it created so far, prints the failing call and the IAM action it needs, sets
`SCALE_TO_ZERO_STATUS=failed`, and `do/deploy` exits **5**. Exit 5 means the
endpoint deployed and is serving at a fixed floor of one copy; it is not a deploy
failure (that is exit 4). Fix the permission and run
`./do/deploy --reconfigure --scale-to-zero on`.

An inference component added later with `do/add-ic` (or `do/deploy --ic <name>`)
is **not** registered for scale-to-zero in v2. MLCC prints a notice: while that IC
holds a copy, the endpoint cannot reach zero instances. `do/deploy --reconfigure
--scale-to-zero on` registers every IC the project deployed.

### The `ExactCapacity` deviation (documented, unmeasured)

The AWS example wakes the endpoint with `ChangeInCapacity` +1. CloudWatch re-runs
Auto Scaling actions for as long as an alarm stays in `ALARM`
([alarm actions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-actions.html)),
so failures that keep the alarm hot through a long cold start can add copies; the
owner's study saw an extra copy requested after the first success. MLCC uses
[`ExactCapacity`](https://docs.aws.amazon.com/autoscaling/application/APIReference/API_StepScalingPolicyConfiguration.html)
1 instead, which should make repeated firing idempotent at one copy. This has not
been measured yet; the owner-run validation records the copy count after the first
success, and the result goes into an ADR-014 addendum.

The AWS CLI example alarm uses `GreaterThanThreshold` 1, which needs two failed
requests in one minute. MLCC uses `GreaterThanOrEqualToThreshold` 1 (as AWS's launch
post does), so one failed request starts the wake.

## IAM

The principal that runs `do/deploy` / `do/clean` needs, in addition to the usual
real-time permissions:

| Action | Used by |
|---|---|
| `application-autoscaling:RegisterScalableTarget`, `PutScalingPolicy` | deploy, `--reconfigure ... on` |
| `application-autoscaling:DeleteScalingPolicy`, `DeregisterScalableTarget` | clean, rollback, `--reconfigure ... off` |
| `application-autoscaling:DescribeScalableTargets` | `do/status` |
| `cloudwatch:PutMetricAlarm` / `cloudwatch:DeleteAlarms` | deploy / clean, rollback |
| `iam:CreateServiceLinkedRole` for `sagemaker.application-autoscaling.amazonaws.com` | first registration in an account ([service-linked roles](https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-service-linked-roles.html)) |
| `sagemaker:CreateEndpointConfig`, `DescribeEndpointConfig`, `DeleteEndpointConfig`, `UpdateEndpoint`, `ListInferenceComponents`, `DescribeInferenceComponent`, `UpdateInferenceComponentRuntimeConfig` | in-place `--reconfigure` |

Application Auto Scaling itself changes the IC copy count through its
service-linked role `AWSServiceRoleForApplicationAutoScaling_SageMakerEndpoint`.

## Cleanup

`./do/clean endpoint` (and `./do/clean ic <name>`) removes, per IC, the alarm, the
step and target-tracking policies, then the scalable target, all **before** the
inference component and the endpoint. CloudWatch alarms are never deleted
automatically when a policy or endpoint goes away, so MLCC deletes them itself. A
resource that is already gone counts as removed, so clean is safe to re-run.
Projects that never turned scale-to-zero on make no extra AWS calls.

## Related

- [ADR-014: Scale-from-zero is an honest, native-only opt-in](adr/ADR-014-scale-from-zero.md)
  (decision, per-target matrix, Addendum A facts).
- AWS: [Autoscale an asynchronous endpoint](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference-autoscale.html)
  (the async follow-up), [HyperPod autoscaling policies](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-model-deployment-autoscaling.html),
  [HyperPod Karpenter autoscaling](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-eks-autoscaling.html).
- [Deployment & Inference](deployments.md), [Adding a Deployment Target](architecture/deployment-target-authoring.md).

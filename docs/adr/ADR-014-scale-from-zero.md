<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-014: Scale-from-Zero is an Honest, Native-Only Opt-In

## Status

Accepted (2026-10-26). v2.0, Wave 10. Tracker C3 / backlog BL202. The ADR decision is a v2.0
launch gate (`.kiro/v2-w8-plan.md`, OQ-B); the cross-target autoscaler build is not. Grounded at
local `main` `2e94d4da`; AWS facts were checked against the AWS docs (links inline) and
read-only `describe`/`list` calls in `us-west-2` on 2026-10-26.

### Owner decisions (2026-10-26)

- **OQ-10.1: Option C accepted.** Ship the honest opt-in in v2; cold-start mitigation is
  measured post-2.0 work.
- **OQ-10.2: realtime only.** v2 enables scale-to-zero only for `realtime-inference` endpoints
  backed by inference components. `async-inference` is declared `support: native` but
  `enabled: false` in v2: it queues at zero and is the natural next target (post-2.0).
- **OQ-10.3: HyperPod refused in v2.** `hyperpod-eks` is `pod-only` and refused with a reason;
  `eks` is `requires-cluster-addon` and refused; `batch-transform` is `not-applicable`.
- **OQ-10.4: no live validation by the build.** MLCC does not scale
  `sharp-gpt-bot-endpoint-1784665560` to zero and creates no new capacity for validation.
  Mechanics are proven offline (stubbed `aws` plus botocore model checks). The owner validates a
  live cycle separately, on an endpoint and at a time of their choosing, using an owner-run
  runbook. That runbook is not a build gate.

## Context

**The measured cold start.** The owner's study (Gemma-3-4B, vLLM 0.32.0, ml.g7, us-east-1,
Oct 2026; numbers transcribed into tracker C3) ran AWS's documented scale-from-zero pattern for
inference components (IC `MinCopyCount` 0 plus a step-scaling policy on
`NoCapacityInvocationFailures`). Recovery from zero took **11.9 min mean** (10.9 / 11.8 / 12.9
over 3 runs): about 3.5 min alarm and scaling decision, 2.1 min instance, 6.0 min container and
model readiness, 0.2 min to first token. Instance-local caching did not help from zero. After the
first success the alarm stayed hot and an extra copy was requested (overshoot). Fast Model
Loader and ahead-of-time compile were not tested. On HyperPod, BL193 measured a prefetch-off
model load of 512.7 s and about 15 min to pod Ready on `fresh-ai-ml`. Cold start is minutes on
every target MLCC has measured.

**The economics are coupled to the penalty.** Scale-to-zero saves money only while the endpoint
is idle, and idle is exactly when the next request pays the cold start. Wave 9 (OQ-9.5, R8.5)
labels every cost "@ concurrency N (measured)" and states that idle and scale-to-zero time are
not included. This ADR owns that missing half.

**What MLCC does today: no autoscaling on any target.** `templates/` contains no
`register-scalable-target`, `put-scaling-policy`, `put-metric-alarm`, `ManagedInstanceScaling`,
KEDA or HPA object (repo grep, zero hits outside one comment).

| Target | Today in MLCC (file:line) | Live check (us-west-2, read-only) |
|---|---|---|
| realtime-inference | Variant `InitialInstanceCount` 1, no `ManagedInstanceScaling` (`templates/do/lib/endpoint-config.sh:157`); IC `CopyCount` fixed at `IC_COPY_COUNT` (`templates/do/lib/inference-component.sh:128`) | `sharp-gpt-bot-endpoint-1784665560`: `ManagedInstanceScaling` null; `describe-scalable-targets --service-namespace sagemaker` returns none |
| async-inference | Variant `InitialInstanceCount` 1, no scaling registration (`templates/do/deploy.d/async-inference:430`) | no async endpoint exists |
| batch-transform | Job lifecycle; nothing idles | n/a |
| hyperpod-eks | IEC renders `replicas` only, no `autoScalingSpec` (`templates/hyperpod/InferenceEndpointConfig.yaml.ejs:56`); the rollout path never scales replicas to zero (`templates/do/deploy.d/hyperpod-eks:944-946`) | add-on `amazon-sagemaker-hyperpod-inference` v2.1.0 runs KEDA in `hyperpod-inference-system`; the operator defaults `autoScalingSpec.minReplicaCount: 1` with no metric, and no `ScaledObject` exists. Karpenter autoscaling is enabled on `mlcc-hyperpod-cluster` but has zero NodePools; capacity comes from fixed instance groups |
| eks | Fixed `replicas` (`templates/eks/Deployment.yaml.ejs:25`); per ADR-012 MLCC installs nothing on a BYO cluster | demo cluster add-ons include no KEDA or Karpenter; in-cluster check not possible (no kubectl access entry) |

The plan's line "SMAI async already does it" is true of the platform, not of MLCC. MLCC wires
scale-to-zero on no target. Side finding (not in scope): `ENDPOINT_INITIAL_INSTANCE_COUNT`
(`templates/do/config:236`) feeds right-sizing (`right_sizing.py:1888`) but the deploy path
hardcodes 1 (`endpoint-config.sh:157`, `deploy.d/async-inference:430`). File it separately.

**What the platform offers natively** (V = verified in AWS docs or live read-only state;
U = not verified):

- **IC scale to zero (V).** An endpoint scales to and from zero instances only when it hosts
  inference components and the variant's `ManagedInstanceScaling.MinInstanceCount` is 0. Each IC
  is registered with `MinCapacity` 0 on `sagemaker:inference-component:DesiredCopyCount`. Scale-in
  uses target tracking. Scale-out from zero uses a step policy (doc example: `ChangeInCapacity`
  +1, `Cooldown` 60) fired by a CloudWatch alarm on `NoCapacityInvocationFailures`. AWS warns
  that provisioning takes several minutes and requests fail meanwhile.
  [Scale an endpoint to zero instances](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling-zero-instances.html);
  [ProductionVariantManagedInstanceScaling](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_ProductionVariantManagedInstanceScaling.html)
  (`MinInstanceCount` minimum 0).
- **Async scale to zero (V).** Register the variant with `MinCapacity` 0 on
  `sagemaker:variant:DesiredInstanceCount`. Target tracking runs on
  `ApproximateBacklogSizePerInstance`. A step policy on `HasBacklogWithoutCapacity` wakes the
  endpoint on the first queued request instead of waiting for the backlog target. Requests that
  arrive at zero are queued, not failed.
  [Autoscale an asynchronous endpoint](https://docs.aws.amazon.com/sagemaker/latest/dg/async-inference-autoscale.html).
- **HyperPod inference operator autoscaling (V).** `autoScalingSpec` on the deployment CR
  (`minReplicaCount` ≥ 0, `cooldownPeriod` and `initialCooldownPeriod` apply only at min 0,
  CloudWatch or AMP Prometheus triggers with `activationTargetValue` for 0→1), backed by KEDA.
  [HyperPod autoscaling policies](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-model-deployment-autoscaling.html);
  confirmed by `kubectl explain inferenceendpointconfig.spec.autoScalingSpec` on the live
  cluster. This scales **pods**. Nodes are billed until node autoscaling removes them: managed
  Karpenter can scale to zero nodes (needs continuous provisioning and NodePools)
  [HyperPod Karpenter autoscaling](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-eks-autoscaling.html).
  How requests to the SageMaker endpoint behave while at 0 pods (fail, queue, which metric
  triggers) is **U**.
- **Plain EKS (U for MLCC).** Nothing native. Needs a cluster-owned KEDA (plus Karpenter or
  Cluster Autoscaler for nodes). Not an AWS SageMaker capability.
- **Container caching (V, not applicable).** Pre-caches **SageMaker DLC** images (LMI, TGI,
  Triton, PyTorch) for IC scale-out
  ([blog](https://aws.amazon.com/blogs/machine-learning/supercharge-your-auto-scaling-for-generative-ai-inference-introducing-container-caching-in-sagemaker-inference/)).
  MLCC ships BYOC images from the project's ECR, so it does not cover MLCC. Whether any image
  caching applies to BYOC is **U**.
- **Fast Model Loader / weight streaming (V as a feature, U for MLCC).** Streams pre-sharded
  weights from S3 to GPU and is integrated with LMI. AWS reports up to 15x faster load and about
  19-22 % faster scale-out on Llama 3.1 70B / p4d
  ([blog part 1](https://aws.amazon.com/blogs/machine-learning/introducing-fast-model-loader-in-sagemaker-inference-accelerate-autoscaling-for-your-large-language-models-llms-part-1/)).
  BL146 found it a poor fit for MLCC's path: LMI-only (MLCC serves vLLM/SGLang BYOC), per-model
  eligibility is docs-only, `CreateOptimizationJob` lists no g7/g7e/p6 types
  (`.kiro/reports/bl146-inference-opt-tags-spike.md`). Engine-native streaming loaders (for
  example vLLM's own load formats) were **not** researched here.
- **Overshoot mechanism (V for the rule, U as the cause).** CloudWatch re-runs Auto Scaling
  actions for as long as the alarm stays in ALARM; all other actions fire only on a state change
  ([Alarm actions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-actions.html)).
  With the documented `ChangeInCapacity` +1 / 60 s cooldown, failures that keep the alarm hot
  through a 12-min cold start can add copies. This matches the observed overshoot; it has not
  been re-measured. Step adjustments also accept `ExactCapacity`
  ([StepScalingPolicyConfiguration](https://docs.aws.amazon.com/autoscaling/application/APIReference/API_StepScalingPolicyConfiguration.html)),
  which makes repeated firing idempotent at one copy (**U** in practice).

## Options considered

- **A: Honest opt-in on native targets only.** Expose scale-to-zero only where the platform does
  it, behind an explicit flag, with a mandatory cold-start warning and the measured expectation.
  Make no claim of interactive suitability. Cheap and truthful. Leaves the 12-min interval as is.
- **B: Mitigate cold start first.** Do not enable scale-to-zero until Fast Model Loader, AOT
  compile, weight streaming or warm pools bring the cold start down. The levers are unverified or
  blocked for MLCC's vLLM BYOC / Blackwell path (BL146), so this would likely ship nothing in v2
  and is open-ended research.
- **C: Both, sequenced.** Ship A in v2 with the warning. Track B as measured post-2.0 work with a
  re-evaluation trigger: a mitigation that measurably shortens the 6.0 min readiness phase.
- **D: Don't ship scale-to-zero in v2.** Document the trade-off only. Zero risk, but it walks
  back the C3 "first-class pillar" intent and leaves users to wire the AWS pattern by hand without
  MLCC's warning or cleanup.

## Decision

**Option C (accepted 2026-10-26). In v2, MLCC offers scale-to-zero only on realtime
inference-component endpoints, only when the user asks for it, and always with the measured
cold-start expectation. Async enablement and cold-start mitigation are post-2.0 work.**

1. **Capability is declared, not hardcoded (ADR-008).** Each `targets.d/<t>/manifest.json`
   gains a required `scale_to_zero` block. `support` is an open-set enum (`native`, `pod-only`,
   `requires-cluster-addon`, `not-applicable`). `mechanism` is a plug-point like ADR-013's load
   mechanisms. `wake_signal`, `requests_at_zero` (`fail` / `queued` / `unknown`) and
   `idle_billing` describe the platform. `enabled` says whether MLCC wires it in this release,
   and `reason` explains every `enabled: false`. Flag acceptance, the warning text, `do/status`
   and cleanup all derive from the block, and a drift test covering all five targets guards it.
2. **v2 enables `realtime-inference` only.** Per-target v2 matrix:

   | Target | `support` | `mechanism` | `requests_at_zero` | v2 `enabled` | Reason when refused |
   |---|---|---|---|---|---|
   | realtime-inference | native | `sagemaker-ic-step` (IC endpoints) | fail | true | (enabled) |
   | async-inference | native | `sagemaker-async-backlog` | queued | false | post-2.0 follow-up; queues at zero, the natural next target |
   | hyperpod-eks | pod-only | `hyperpod-autoscalingspec` | unknown | false | pod scale-in on fixed instance groups saves no node cost; node scale-to-zero needs Karpenter NodePools (cluster provisioning, ADR-012) |
   | eks | requires-cluster-addon | `keda-byo` | unknown | false | needs a cluster-owned KEDA; MLCC installs nothing on a BYO cluster (ADR-012) |
   | batch-transform | not-applicable | none | n/a | false | jobs do not idle |

3. **Opt-in, never default, with a plain warning.** The deploy flag is off by default. Every
   deploy, reconfigure, `--dry-run` and `do/status` at zero prints the warning: "not for
   interactive SLAs. While at zero, requests FAIL until a copy is ready. Reference recovery:
   11.9 min mean (Gemma-3-4B / ml.g7 / vLLM 0.32.0, us-east-1, owner study 2026-10); your model
   and instance were not measured." The numbers carry their provenance. MLCC never claims a
   target-specific cold start it has not measured.
4. **Use the documented AWS pattern, with overshoot hardening.** The variant gets
   `ManagedInstanceScaling` with `MinInstanceCount` 0; the IC registers with `MinCapacity` 0.
   Scale-out from zero uses the `NoCapacityInvocationFailures` alarm and a step policy with
   `ExactCapacity` 1 rather than the doc's `ChangeInCapacity` +1, so a hot alarm cannot stack
   copies. Target tracking handles scale-out above one. The deviation is documented, and it is
   not called fixed until the owner's live validation measures it.
5. **MLCC owns what it creates.** Scalable targets, policies and alarms are recorded in
   `do/manifest` and removed by `do/clean`. MLCC creates no dashboards (Wave 9 boundary holds).
6. **Validation is offline in the build; live is owner-run.** Every application-autoscaling,
   cloudwatch and sagemaker call is checked against stubbed `aws` and the botocore service models.
   The live idle-to-zero-to-wake cycle is an owner-run runbook, not a gate.

## Cost story

Wave 9's resolver prices the instance-hour. Scale-to-zero changes only how many idle hours are
billed. Illustration with the study's price (g7.2xlarge about $3.15/h, us-east-1, tracker C5): an
endpoint idle 16 h/day saves about $50/day per instance, but only for idle stretches longer than
the scale-in delay (target-tracking cooldowns, 300 s in the AWS example). Each idle-to-active
transition costs about 11.9 min of failed requests on the reference run, plus the instance-hours
billed while warming. v2 states this trade-off next to every Wave 9 cost line when scale-to-zero
is enabled. It does **not** compute an idle-adjusted cost: that needs a traffic profile MLCC does
not have.

## Consequences

- **Positive:** C3 ships an honest v2 pillar: a declared capability on all five targets, a
  working opt-in on realtime IC endpoints, and a cost caveat that closes Wave 9's open half.
  Enabling async later is a descriptor flip plus one mechanism arm; HyperPod or KEDA is a
  descriptor change plus a mechanism, not a rewrite.
- **Cost / constraint:** MLCC takes on new owned resources (scalable targets, policies, alarms)
  and their cleanup. Realtime users who opt in accept failed requests for minutes after idle.
  Users who want queue-at-zero semantics wait for the async follow-up.
- **Risk:** the `ExactCapacity` hardening is unmeasured at release; the build proves call
  shapes, not runtime behavior. The owner's separate live validation is the only measurement,
  and its results go into an ADR-014 addendum. Until then the docs call the hardening
  "documented, unmeasured".
- **Wave 9 coupling:** the descriptor schema gains Wave 9's `observability` / `pricing` blocks
  in parallel. The Wave 10 schema change lands after Wave 9 merges.

## Not decided here

- Async scale-to-zero enablement (`async-inference` `enabled: true`): post-2.0 follow-up.
- Realtime cold-start mitigation (Fast Model Loader, AOT compile, weight streaming, warm pools,
  BL193's Mountpoint tuning): measured post-2.0, each its own backlog item.
- HyperPod pod-level scale-to-zero and its request behavior at zero pods; adopting Karpenter
  NodePools; KEDA on plain EKS.
- Idle-adjusted cost from real traffic; scheduled scaling (time-of-day warm windows).
- Target-tracking metric and target values for LLMs (defaults follow the AWS examples).

## References

- Tracker C3 / C5 (`.kiro/v2.0-tracker.md`); `.kiro/v2-w8-plan.md` "Wave 10 (sketch)".
- Backlog: BL202 (this ADR), BL193 (HyperPod prefetch-off cold start), BL201 (C5 cost), BL146.
- `.kiro/specs/v2-w9-01-observability-tokenomics/requirements.md` (OQ-9.5, R8.5).
- ADR-008 (descriptor), ADR-012 (consume, don't provision), ADR-013 (mechanism plug-points).
- Wave 10 spec: `.kiro/specs/v2-w10-01-scale-from-zero/` (incl. the owner-run validation runbook).

## Addendum A: Wave 10 Task 1 facts (2026-10-27, build agent)

Checked against AWS docs, the MLCC code at `f9985928` and the botocore service models
(local botocore 1.43.33; CI pins 1.43.118 in `.github/workflows/ci.yml`). No AWS API call was
made. V = verified in the cited source; U = not verified (left to the owner-run runbook).

1. **`ExactCapacity` is valid for the IC dimension (V at the API level, U at runtime).**
   `StepScalingPolicyConfiguration.AdjustmentType` accepts `ChangeInCapacity`,
   `ExactCapacity` and `PercentChangeInCapacity`, with no per-dimension restriction, and
   `ScalableDimension` includes `sagemaker:inference-component:DesiredCopyCount` (botocore
   `application-autoscaling` model;
   [StepScalingPolicyConfiguration](https://docs.aws.amazon.com/autoscaling/application/APIReference/API_StepScalingPolicyConfiguration.html)).
   Whether it stops the observed overshoot is unmeasured (runbook S5).
2. **Cleanup must be explicit.** Deleting an endpoint makes Application Auto Scaling deregister
   the endpoint's *models* as scalable targets when the caller may call
   `DeregisterScalableTarget` (V,
   [Delete endpoints configured for auto scaling](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-delete-with-scaling.html)).
   The page does not say the same for IC-level targets when an IC is deleted (U). Deleting a
   step scaling policy removes the alarm *action* but never the CloudWatch alarm (V, botocore
   `DeleteScalingPolicy` documentation). So `clean.d/realtime-inference` deletes the alarm, the
   two policies and the scalable target itself, before the IC and the endpoint, and treats
   `ObjectNotFoundException` / `ResourceNotFound` as already removed.
3. **`update-endpoint` and `ManagedInstanceScaling` (U).** `ManagedInstanceScaling` is a member
   of the endpoint-config production variant (`MinInstanceCount` minimum 0, V botocore and
   [ProductionVariantManagedInstanceScaling](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_ProductionVariantManagedInstanceScaling.html)).
   `UpdateEndpoint` swaps in a new endpoint config; its `ExcludeRetainedVariantProperties` enum
   (`DesiredInstanceCount`, `DesiredWeight`, `DataCaptureConfig`) does not cover it. AWS's
   update guidance requires deregistering scaling first only when the update changes the
   instance type or removes a variant
   ([Update endpoints that use auto scaling](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-scaling-update.html)),
   which MLCC's in-place reconfigure never does. No AWS page states that an IC-backed endpoint
   accepts an update that adds or removes `ManagedInstanceScaling`. MLCC implements the R2.5
   in-place path as `create-endpoint-config` (same variant plus or minus the block) then
   `update-endpoint`, and the owner's runbook S1 / S6 is the first live check.
4. **Every MLCC realtime deploy uses inference components (V, code).**
   `deploy.d/realtime-inference` always creates an IC (`create_inference_component` for
   `do/ic/*.conf`, `create_inference_component_legacy` otherwise) and never calls
   `create-model`; `create_endpoint_config` passes the execution role and no model (the IC
   flow). The R2.3 "no IC" refusal therefore only fires on the in-place reconfigure, which
   checks `list-inference-components --endpoint-name-equals` on the live endpoint. Attaching to
   an external endpoint (`ENDPOINT_STRATEGY=existing`) is refused separately (config not owned).
5. **One request must be able to wake the endpoint.** The AWS procedure says the endpoint
   provisions an instance after "an inference request that it can't respond to", but its CLI
   example uses `GreaterThanThreshold` with threshold 1, which needs two failures in one 60 s
   period ([Scale an endpoint to zero instances](https://docs.aws.amazon.com/sagemaker/latest/dg/endpoint-auto-scaling-zero-instances.html)).
   AWS's launch post uses `GreaterThanOrEqualToThreshold` with threshold 1
   ([blog](https://aws.amazon.com/blogs/machine-learning/unlock-cost-savings-with-the-new-scale-down-to-zero-feature-in-amazon-sagemaker-inference/)).
   MLCC uses `GreaterThanOrEqualToThreshold` / 1 with the doc's 60 s period, `Sum`, one
   evaluation period and one datapoint, so a single failed request wakes it.
6. **First registration creates a service-linked role.** `RegisterScalableTarget` creates
   `AWSServiceRoleForApplicationAutoScaling_SageMakerEndpoint` if it does not exist (V,
   [Application Auto Scaling service-linked roles](https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-service-linked-roles.html)),
   so the deploying principal needs `iam:CreateServiceLinkedRole` for that role once per account.

The live results of the owner-run runbook (recovery breakdown, copy count after the first
success, the in-place update) go into Addendum B.

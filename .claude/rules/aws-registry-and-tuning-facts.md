---
paths:
  - "templates/do/register"
  - "templates/do/tune"
  - "templates/do/train"
  - "templates/do/evaluate"
  - "templates/do/.*helper.py"
  - "templates/do/lib/python/register_*.py"
  - "templates/do/lib/python/tune_*.py"
  - "templates/do/lib/python/ai_registry_native.py"
  - "templates/do/lib/python/dataset_*.py"
  - "templates/code/tune.d/**"
  - "infra/bootstrap-modules/training/**"
---
# Verified facts: AI Registry, datasets, evaluators, managed tuning

These facts were verified in a real account during the v1.9 spike (SageMaker SDK 3.23.0).
Source: `.kiro/v1.9-lessons-learned.md`. Re-verify them, with the owner running the probe,
before relying on anything that might have changed.

## Datasets vs evaluators (this was gotten wrong twice)
- Everything registers into the SDK-computed `AiRegistry-<region>-<account>` hub. **The hub
  can't be targeted.** Studio discoverability comes from the `domain_id` (`@domain` tag), not
  the hub. The branded `mlcc-registry-{accountId}` hub design is retired.
- `do/register dataset` accepts:
  1. dataset-driven corpora (SFT, DPO), as a native `CustomizationTechnique` member;
  2. RFT **prompt corpora** (RLVR / RLAIF / MTRL training data), registered under the
     **RLVR** member with the intended technique recorded in the S3 sidecar. This case is
     legitimate; don't block it.
  3. **Reward artifacts** (reward prompt file or reward function), which it **rejects**.
     Those are evaluators.
- `do/register evaluator` registers a code / Lambda `REWARD_FUNCTION` (RLVR / MTRL).
  `do/register prompt` registers a `REWARD_PROMPT` (RLAIF).
- The AI Registry UI's technique dropdown **merges** the dataset and evaluator lists. It is
  not nine dataset techniques.

## SDK facts
- `CustomizationTechnique` has exactly `SFT`, `DPO` and `RLVR`. `DataSet.create` needs an enum
  **member**; a raw string raises. Derive the accepted set from the enum.
- `DataSet.create(name, source, customization_technique, wait, description, tags, role,
  domain_id, sagemaker_session, content_metadata)`. There is no `title` (the UI title is
  `name`). The kwarg is `role=`, not `role_arn`.
- `Evaluator.create` works for `REWARD_FUNCTION` (Lambda ARN) and `REWARD_PROMPT` (S3).
  A local `.py` reward function provisions a managed Lambda named
  `SageMaker-evaluator-<name>-<ts>` (64-character cap, so about 28 characters for the name),
  with a dual-trust `sagemaker` + `lambda` role.
- Region-gated: us-east-1, us-west-2, ap-northeast-1, eu-west-1.

## Managed RFT contract
- An RFT `do/tune` job (RLVR / RLAIF / MTRL) needs **both** a prompt dataset and an evaluator
  (a reward function for RLVR / MTRL, a reward prompt for RLAIF). Pre-flight must fail before
  submission if either is missing, naming the missing input and its register verb. SFT and
  DPO need the dataset only.
- MTRL is a **managed `do/tune` technique**, not a `do/train` concern.
- The MLCC-label-to-technique map lives in one place: the tune descriptors in
  `templates/code/tune.d/`.
- Launch-gate IAM for training lives once, in `infra/bootstrap-modules/training/`.

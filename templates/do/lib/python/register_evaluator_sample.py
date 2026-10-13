from __future__ import annotations
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Editable reward-function sample on-ramp for `do/register evaluator --from-sample`.

The lead reward-function path is bring-your-own-Lambda (`--arn`, Req 1). This is
the OPTIONAL convenience on-ramp (Req 1A): materialize an editable local reward
function the user tweaks, then register it via the managed-Lambda path
(`Evaluator.create(type=REWARD_FUNCTION, source=<local .py>)`), which makes
SageMaker create+own a Lambda and therefore needs a dual-trust
(`sagemaker`+`lambda`) reward-Lambda role.

Licensing note: the shipped sample is FIRST-PARTY (authored here, Apache-2.0,
Amazon copyright) — a format-agnostic scorer that normalizes the common
verl / HuggingFace / SageMaker-Evaluation payload shapes. It is deliberately NOT
copied from an external AWS doc sample, so there is no third-party redistribution
gate to clear; the file is clearly marked "starting point — edit me".
"""

import os
import sys

from common import _output, _error_exit

# The one shipped sample id. Kept as a map so more worked samples can be added
# later without changing the CLI contract (Req 1A.1 `--from-sample [<id>]`).
_DEFAULT_SAMPLE = "rlvr-custom"
_SAMPLE_IDS = (_DEFAULT_SAMPLE,)

# Where materialized reward functions live inside a generated project.
_EVALUATORS_DIRNAME = "evaluators"


def available_samples():
    """The reward-function sample ids `--from-sample` accepts."""
    return list(_SAMPLE_IDS)


# ── The vendored, editable sample (first-party, format-agnostic) ───────────────

_RLVR_CUSTOM_SAMPLE = '''\
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# ─────────────────────────────────────────────────────────────────────────────
#  STARTING POINT — EDIT ME.
#  Materialized by `do/register evaluator <name> --from-sample rlvr-custom`.
#  This is a worked, format-agnostic RLVR reward function you are expected to
#  replace with your real scoring logic before finalizing registration.
# ─────────────────────────────────────────────────────────────────────────────
#
#  Reward-function contract (REWARD_FUNCTION evaluator / RLVR):
#    - SageMaker invokes this as a managed Lambda PER BATCH: the `event` is a
#      LIST of sample records (one call scores several completions at once).
#    - You must return a LIST of score objects, one per record, each shaped
#      {"aggregate_reward_score": <float>, "id": <int>}. A single {"reward": ...}
#      dict is REJECTED by the training container ("Lambda response must be a list
#      of score objects ... like [{\"aggregate_reward_score\": 0.5, \"id\": 0}]").
#    - Each record's fields vary by producer (verl, HuggingFace, SageMaker
#      Evaluation). `_extract(record)` below normalizes one record to
#      (prompt, model_output, ground_truth) so your `score()` stays shape-free.
#      A reward in [0.0, 1.0] is conventional; higher = better.
#    - NEVER raise: a reward fn that crashes fails the whole RL step. Catch and
#      floor that record to 0.0 instead.


def _extract(record):
    """Normalize ONE batch record to (prompt, model_output, ground_truth).

    Field names vary by producer; this is defensive across the shapes seen in
    practice. Confirm against a real CloudWatch invocation event and prune to the
    exact fields your producer sends:
      - verl / SageMaker Evaluation: {"model_output": ..., "reward_model": {"ground_truth": ...}}
      - HuggingFace-style:           {"completion": ..., "prompt": ..., "label": ...}
      - nested extra_info:           {"extra_info": {"question": ...}}
    """
    record = record or {}
    extra = record.get("extra_info") or {}
    reward_model = record.get("reward_model") or {}

    prompt = (
        record.get("prompt")
        or record.get("question")
        or extra.get("question")
        or ""
    )
    model_output = (
        record.get("model_output")
        or record.get("completion")
        or record.get("response")
        or record.get("output")
        or ""
    )
    ground_truth = (
        record.get("ground_truth")
        or record.get("label")
        or record.get("answer")
        or (reward_model.get("ground_truth") if isinstance(reward_model, dict) else None)
        or extra.get("ground_truth")
        or ""
    )
    return str(prompt), str(model_output), str(ground_truth)


def score(prompt, model_output, ground_truth):
    """Return a float reward in [0.0, 1.0]. REPLACE THIS with real logic.

    The placeholder rewards an exact (whitespace-insensitive, case-insensitive)
    match against the ground truth, with partial credit for containing it. This
    is only a scaffold — a real verifiable reward checks the actual task
    (e.g. parses a numeric answer, runs unit tests, validates a format).
    """
    out = model_output.strip().lower()
    gt = ground_truth.strip().lower()
    if not gt:
        # No reference to verify against — give a tiny non-zero signal for a
        # non-empty answer so training does not stall, and edit this out.
        return 0.1 if out else 0.0
    if out == gt:
        return 1.0
    if gt in out:
        return 0.5
    return 0.0


def handler(event, context=None):
    """Lambda entrypoint SageMaker invokes PER BATCH. Keep this wrapper; edit `score()`.

    `event` is a LIST of sample records. Return a LIST of score objects, one per
    record: {"aggregate_reward_score": <float>, "id": <int>}.
    """
    # Tolerate a dict-wrapped batch just in case, but the contract is a bare list.
    records = event
    if isinstance(event, dict):
        records = event.get("records") or event.get("samples") or event.get("inputs") or [event]
    if not isinstance(records, list):
        records = [records]

    scores = []
    for idx, record in enumerate(records):
        rid = record.get("id", idx) if isinstance(record, dict) else idx
        try:
            prompt, model_output, ground_truth = _extract(record)
            reward = float(score(prompt, model_output, ground_truth))
        except Exception:  # noqa: BLE001 — a reward fn must never crash the RL step
            reward = 0.0
        scores.append({"aggregate_reward_score": reward, "id": rid})
    return scores
'''

_SAMPLE_BODIES = {
    "rlvr-custom": _RLVR_CUSTOM_SAMPLE,
}


def _project_root():
    """The generated project root (two levels up from lib/python/)."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", ".."))


def sample_path_for(name):
    """Local path a materialized reward function for evaluator <name> lands at."""
    return os.path.join(_project_root(), _EVALUATORS_DIRNAME, f"{name}.py")


def cmd_materialize_sample(args):
    """Write an editable reward-function sample for the user to edit (Req 1A.1).

    Does NOT register — materialization and finalize are two steps so the user
    edits the scorer first. `do/register evaluator --from-sample` prints the next
    command (register with `--arn` once the Lambda is deployed, or `--finalize`
    for the managed-Lambda path).
    """
    name = args.name
    if not name:
        _error_exit("--name is required", code="MISSING_ARGUMENT")

    sample_id = getattr(args, "sample_id", None) or _DEFAULT_SAMPLE
    if sample_id not in _SAMPLE_BODIES:
        _error_exit(
            f"Unknown sample id '{sample_id}'. Available: {', '.join(available_samples())}",
            code="UNKNOWN_SAMPLE",
        )

    dest = sample_path_for(name)
    if os.path.exists(dest) and not getattr(args, "force", False):
        _error_exit(
            f"A reward function already exists at {dest}. Edit it, or pass --force "
            "to overwrite with a fresh sample.",
            code="SAMPLE_EXISTS",
        )

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as f:
        f.write(_SAMPLE_BODIES[sample_id])

    print(f"\u2713 Materialized an editable reward function at: {dest}", file=sys.stderr)
    print("  Edit score() with your real reward logic, then register it:", file=sys.stderr)
    print(f"    \u2022 Recommended \u2014 deploy it as a Lambda and reference by ARN (no", file=sys.stderr)
    print(f"      managed-Lambda role needed):", file=sys.stderr)
    print(f"        ./do/register evaluator {name} --arn <your-lambda-arn>", file=sys.stderr)
    print(f"    \u2022 Or let SageMaker create+own the Lambda from this file (needs the", file=sys.stderr)
    print(f"      dual-trust reward-Lambda role \u2014 see docs):", file=sys.stderr)
    print(f"        ./do/register evaluator {name} --from-sample --finalize", file=sys.stderr)

    _output({
        "name": name,
        "sample_id": sample_id,
        "path": dest,
        "materialized": True,
        "finalized": False,
    })

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
#  Reward-function contract (REWARD_FUNCTION evaluator / RLVR / MTRL):
#    - SageMaker invokes this as a managed Lambda, once per sampled response.
#    - The event shape varies by producer (verl, HuggingFace, SageMaker
#      Evaluation). `_extract(event)` below normalizes them to
#      (prompt, model_output, ground_truth) so your `score()` stays shape-free.
#    - Return a JSON-serializable dict carrying a single scalar `reward` (float).
#      A reward in [0.0, 1.0] is conventional; higher = better.
#    - NEVER raise: a reward fn that crashes fails the whole RL step. Catch and
#      return a 0.0 floor instead.


def _extract(event):
    """Normalize the common reward payloads to (prompt, model_output, ground_truth).

    Handles the three shapes seen in practice without assuming which producer
    sent the event:
      - verl / SageMaker Evaluation: {"model_output": ..., "ground_truth": ...}
      - HuggingFace-style:           {"completion": ..., "prompt": ..., "label": ...}
      - nested extra_info:           {"extra_info": {"question": ...}}
    """
    event = event or {}
    extra = event.get("extra_info") or {}

    prompt = (
        event.get("prompt")
        or event.get("question")
        or extra.get("question")
        or ""
    )
    model_output = (
        event.get("model_output")
        or event.get("completion")
        or event.get("response")
        or event.get("output")
        or ""
    )
    ground_truth = (
        event.get("ground_truth")
        or event.get("label")
        or event.get("answer")
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
    """Lambda entrypoint SageMaker invokes. Keep this wrapper; edit `score()`."""
    try:
        prompt, model_output, ground_truth = _extract(event)
        reward = float(score(prompt, model_output, ground_truth))
    except Exception:  # noqa: BLE001 — a reward fn must never crash the RL step
        reward = 0.0
    return {"reward": reward}
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

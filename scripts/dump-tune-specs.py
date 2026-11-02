#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Dump the SMTJ SDK's AUTHORITATIVE fine-tuning hyperparameter specs (BL180).

Why: the per-technique tune descriptors' synced `hyperparameters` layer must match
what the SageMaker managed trainer ACTUALLY accepts at submit time. The raw recipe
override-params JSON (what sync-model-families previously read) is version-skewed
from the trainer's own validator — it lists knobs the SDK rejects (e.g.
`gradient_clipping`, `logging_steps`) and omits ones it accepts (`min_lr`,
`warmup_steps`), and carries a stale `global_batch_size` enum. The trainer's
`hyperparameters._specs` is the resolved recipe + the trainer's per-technique
mutations — i.e. the exact set its validator enforces. This helper constructs the
right trainer per technique and prints `_specs` as JSON so the Node sync can build
the descriptor's hyperparameters block from the SDK truth instead of the stale file.

Usage:
    dump-tune-specs.py --technique <sft|dpo|rlvr|rlaif|mtrl> --model <hub-content-id>
                       [--training-type lora|full-rank] [--region <r>]

Output (stdout, one JSON object): the `_specs` dict, shape
    { "<knob>": {type, category, visibility_tier, control_type, default, enum,
                 min, max, step, display_name, description, hint, required}, ... }
— the SAME entry shape as the recipe override-params, so the Node mapper
(_mapOverrideParamKnob) consumes it unchanged. On any failure: a JSON object
{"error": "<reason>"} on stdout and a non-zero exit, so the Node caller can treat
it exactly like a failed fetch (leave the existing synced layer intact).

NOTE: constructing the trainer resolves the recipe via the SageMaker SDK, which
needs AWS credentials + region (same as the rest of `sync:models`). A dummy
`model_package_group` is passed only to satisfy the serverless-construction guard;
no job is submitted and nothing is created in the account.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys

# MLCC technique label → SMTJ trainer class (module, class).
_TECHNIQUE_TO_TRAINER = {
    "sft": ("sagemaker.train.sft_trainer", "SFTTrainer"),
    "dpo": ("sagemaker.train.dpo_trainer", "DPOTrainer"),
    "rlvr": ("sagemaker.train.rlvr_trainer", "RLVRTrainer"),
    "rlaif": ("sagemaker.train.rlaif_trainer", "RLAIFTrainer"),
    "mtrl": ("sagemaker.train.multi_turn_rl_trainer", "MultiTurnRLTrainer"),
}


# The SMTJ SDK writes `sagemaker.config INFO ...` and `Using default Session` lines
# to STDOUT at import/construction time, which would corrupt the JSON the Node caller
# parses. Keep a handle to the REAL stdout and emit ONLY the JSON there; everything
# else (SDK noise) is redirected to stderr.
_REAL_STDOUT = sys.stdout


def _emit(obj) -> None:
    """Write exactly one JSON object to the REAL stdout (never SDK noise)."""
    _REAL_STDOUT.write(json.dumps(obj, default=str))
    _REAL_STDOUT.write("\n")
    _REAL_STDOUT.flush()


def _fail(reason: str, code: int = 1) -> None:
    _emit({"error": reason})
    sys.exit(code)


def main() -> None:
    ap = argparse.ArgumentParser(description="Dump SMTJ SDK fine-tuning specs for a technique")
    ap.add_argument("--technique", required=True)
    ap.add_argument("--model", required=True, help="Hub content id (e.g. huggingface-vlm-gemma-4-e4b-it)")
    ap.add_argument("--training-type", default="lora", help="lora | full-rank")
    ap.add_argument("--region", default=None)
    args = ap.parse_args()

    # Silence the SDK's chatty stdout: route any print()/logging to stderr for the
    # whole SDK interaction so the real stdout carries ONLY our JSON (via _emit).
    logging.disable(logging.INFO)
    os.environ.setdefault("SAGEMAKER_TELEMETRY_OPT_OUT", "true")
    sys.stdout = sys.stderr  # SDK print()s now land on stderr, not the JSON channel

    technique = (args.technique or "").strip().lower()
    entry = _TECHNIQUE_TO_TRAINER.get(technique)
    if entry is None:
        _fail(f"unknown technique '{args.technique}'")

    if args.region:
        os.environ.setdefault("AWS_REGION", args.region)
        os.environ.setdefault("AWS_DEFAULT_REGION", args.region)

    module_name, class_name = entry
    try:
        import importlib
        trainer_cls = getattr(importlib.import_module(module_name), class_name)
    except Exception as exc:  # noqa: BLE001
        _fail(f"could not import {module_name}.{class_name}: {exc}")

    # Normalize training-type to the SDK's TrainingType (full-rank → FULL/full).
    tt = (args.training_type or "lora").strip().lower()
    training_type = "FULL" if tt in ("full", "full-rank", "full_rank") else "LORA"

    # Construct the trainer. A dummy model_package_group satisfies the serverless
    # guard (no submit, no AWS writes). mlflow/compute are left unset.
    try:
        kwargs = {"model": args.model, "model_package_group": "mlcc-spec-probe"}
        try:
            trainer = trainer_cls(training_type=training_type, **kwargs)
        except TypeError:
            # Some trainers (e.g. MTRL) may not take training_type.
            trainer = trainer_cls(**kwargs)
    except Exception as exc:  # noqa: BLE001
        _fail(f"could not construct {class_name} for model '{args.model}': {exc}")

    specs = getattr(getattr(trainer, "hyperparameters", None), "_specs", None)
    if not isinstance(specs, dict) or not specs:
        _fail(f"{class_name} exposed no _specs for model '{args.model}'")

    # Emit the raw _specs dict verbatim to the REAL stdout — it already carries the
    # override-params entry shape (type/category/visibility_tier/control_type/default/
    # enum/min/max/step/display_name/description/hint/required). The Node mapper filters
    # on category:hyperparameter and renames control_type→control / visibility_tier→tier.
    _emit(specs)


if __name__ == "__main__":
    main()

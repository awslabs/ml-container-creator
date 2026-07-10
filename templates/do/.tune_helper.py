#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations
"""SageMaker Managed Model Customization helper — thin dispatcher.

Subcommands: submit, status, resolve, stage-hf, validate, discover
Callers: do/tune, do/train (via do/tune --list-datasets)

This file is a dispatcher only (~50 lines). Implementation lives in:
  lib/python/tune_submit.py   — cmd_submit
  lib/python/tune_status.py   — cmd_status
  lib/python/tune_resolve.py  — cmd_resolve
  lib/python/tune_stage_hf.py — cmd_stage_hf + HF staging helpers
  lib/python/tune_validate.py — cmd_validate
  lib/python/tune_discover.py — cmd_discover
  lib/python/common.py        — shared _output, _error_exit, _warn, etc.
"""

import argparse
import os
import sys

# Add lib/python to path for sub-module imports
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'python'))

from common import _error_exit  # noqa: E402
from tune_submit import cmd_submit  # noqa: E402
from tune_status import cmd_status  # noqa: E402
from tune_resolve import cmd_resolve  # noqa: E402
from tune_stage_hf import cmd_stage_hf  # noqa: E402
from tune_validate import cmd_validate  # noqa: E402
from tune_discover import cmd_discover  # noqa: E402


def main():
    parser = argparse.ArgumentParser(
        description="SageMaker Managed Model Customization helper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", help="Subcommand to run")

    # ── submit ────────────────────────────────────────────────────────────────
    submit_parser = subparsers.add_parser("submit", help="Submit a customization job")
    submit_parser.add_argument("--model-id", required=True, help="Model ID")
    submit_parser.add_argument("--region", default=None,
                               help="AWS region (defaults to AWS_REGION env var)")
    submit_parser.add_argument("--technique", required=True,
                               choices=["sft", "dpo", "rlaif", "rlvr"],
                               help="Customization technique")
    submit_parser.add_argument("--training-type", required=True,
                               choices=["lora", "full-rank"],
                               help="Training type (lora or full-rank)")
    submit_parser.add_argument("--dataset-s3-uri", required=False, default=None,
                               help="S3 URI of the training dataset (direct override)")
    submit_parser.add_argument("--dataset-name", default=None,
                               help="Registered dataset name to resolve from registry")
    submit_parser.add_argument("--output-bucket", required=True,
                               help="S3 bucket for output artifacts")
    submit_parser.add_argument("--role-arn", required=True,
                               help="IAM execution role ARN")
    submit_parser.add_argument("--job-name", required=True,
                               help="Unique job name")
    submit_parser.add_argument("--project-name", required=True,
                               help="Project name for S3 path prefix")
    submit_parser.add_argument("--model-package-group", default=None,
                               help="Model package group name for registration")
    submit_parser.add_argument("--epochs", type=int, default=None,
                               help="Number of training epochs")
    submit_parser.add_argument("--learning-rate", type=float, default=None,
                               help="Learning rate")
    submit_parser.add_argument("--max-seq-length", type=int, default=None,
                               help="Maximum sequence length")
    submit_parser.add_argument("--lora-rank", type=int, default=None,
                               help="LoRA rank")
    submit_parser.add_argument("--lora-alpha", type=int, default=None,
                               help="LoRA alpha scaling factor")
    submit_parser.add_argument("--batch-size", type=int, default=None,
                               help="Global batch size")
    submit_parser.add_argument("--reward-function", default=None,
                               help="Lambda ARN for reward function (RLVR)")
    submit_parser.add_argument("--reward-prompt", default=None,
                               help="S3 URI for reward prompt (RLAIF)")
    submit_parser.add_argument("--evaluator-name", default=None,
                               help="Registered evaluator name to resolve from registry")
    submit_parser.add_argument("--accept-eula", action="store_true", default=False,
                               help="Accept model EULA for gated models (e.g., Llama)")

    # ── status ────────────────────────────────────────────────────────────────
    status_parser = subparsers.add_parser("status", help="Get job status and metrics")
    status_parser.add_argument("--job-name", required=True,
                               help="Training job name")
    status_parser.add_argument("--region", required=True,
                               help="AWS region")

    # ── resolve ───────────────────────────────────────────────────────────────
    resolve_parser = subparsers.add_parser("resolve",
                                           help="Resolve output artifact path")
    resolve_parser.add_argument("--job-name", required=True,
                                help="Training job name")
    resolve_parser.add_argument("--region", required=True,
                                help="AWS region")
    resolve_parser.add_argument("--training-type", required=True,
                                choices=["lora", "full-rank"],
                                help="Training type used for the job")
    resolve_parser.add_argument("--model-package-group", default=None,
                                help="Model package group name")

    # ── stage-hf ──────────────────────────────────────────────────────────────
    stage_hf_parser = subparsers.add_parser("stage-hf",
                                            help="Download HF dataset to S3")
    stage_hf_parser.add_argument("--hf-org", required=True,
                                 help="Hugging Face organization/user")
    stage_hf_parser.add_argument("--hf-name", required=True,
                                 help="Hugging Face dataset name")
    stage_hf_parser.add_argument("--hf-split", default="train",
                                 help="Dataset split (default: train)")
    stage_hf_parser.add_argument("--hf-file", default=None,
                                 help="File filter pattern (glob or substring)")
    stage_hf_parser.add_argument("--output-bucket", required=True,
                                 help="S3 bucket for staged dataset")
    stage_hf_parser.add_argument("--project-name", required=True,
                                 help="Project name for S3 path prefix")
    stage_hf_parser.add_argument("--region", required=True,
                                 help="AWS region")
    stage_hf_parser.add_argument("--hf-secret-name", default=None,
                                 help="Secrets Manager secret name for HF token")
    stage_hf_parser.add_argument("--column-map", default=None,
                                 help="Column mapping (e.g., prompt=question,completion=answer)")
    stage_hf_parser.add_argument("--technique", default="sft",
                                 choices=["sft", "dpo", "rlaif", "rlvr"],
                                 help="Customization technique (determines required columns)")
    stage_hf_parser.add_argument("--no-transform", action="store_true", default=False,
                                 help="Disable automatic chat-format flattening")
    stage_hf_parser.add_argument("--take", type=int, default=None,
                                 help="Take only the first N records from the dataset")

    # ── validate ──────────────────────────────────────────────────────────────
    validate_parser = subparsers.add_parser("validate",
                                            help="Validate dataset format")
    validate_parser.add_argument("--schema", required=True,
                                 help="JSON string of the expected dataset schema")
    validate_parser.add_argument("--file", default="-",
                                 help="Path to dataset file (default: stdin)")

    # ── discover ──────────────────────────────────────────────────────────────
    discover_parser = subparsers.add_parser("discover",
                                            help="Discover tune-eligible models from JumpStart Hub")
    discover_parser.add_argument("--family", default="",
                                 help="Model family name (e.g., qwen-3, llama-3, deepseek-r1)")
    discover_parser.add_argument("--filter", default="",
                                 help="Hub content name prefix filter (overrides family mapping)")
    discover_parser.add_argument("--region", default="",
                                 help="AWS region (default: AWS_REGION env or us-east-1)")

    # ── Parse and dispatch ────────────────────────────────────────────────────
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    command_map = {
        'submit': cmd_submit,
        'status': cmd_status,
        'resolve': cmd_resolve,
        'stage-hf': cmd_stage_hf,
        'validate': cmd_validate,
        'discover': cmd_discover,
    }

    handler = command_map.get(args.command)
    if handler:
        handler(args)
    else:
        _error_exit(f'Unknown command: {args.command}')


if __name__ == '__main__':
    main()

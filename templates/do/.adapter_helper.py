#!/usr/bin/env python3
from __future__ import annotations
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Adapter helper dispatcher — routes do/adapter subcommands to focused modules.

Subcommands: stage-from-tune, stage-from-hub, status
All output is JSON on stdout for bash consumption.
"""

import argparse
import os
import sys

# Add lib/python to path for sub-module imports
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'python'))

from common import _output, _check_sagemaker_core, _check_boto3  # noqa: E402
from stage_adapter import cmd_stage_from_tune, cmd_adapter_status  # noqa: E402
from stage_adapter import _generate_job_name, _upload_entrypoint, _resolve_container_image, _error_exit  # noqa: E402


def main():
    parser = argparse.ArgumentParser(
        description="SageMaker Processing Job helper for adapter staging",
        prog=".adapter_helper.py",
    )
    subparsers = parser.add_subparsers(dest="subcommand", help="Subcommand")

    # ── stage-from-tune ───────────────────────────────────────────────────
    stage_parser = subparsers.add_parser("stage-from-tune", help="Submit Processing Job to stage adapter from training output")
    stage_parser.add_argument("--training-output-s3-uri", required=True, help="S3 URI of training output (adapter artifacts)")
    stage_parser.add_argument("--adapter-name", required=True, help="Name of the adapter (used in output S3 path)")
    stage_parser.add_argument("--bucket", required=True, help="S3 bucket for adapter output")
    stage_parser.add_argument("--project", required=True, help="Project name (used in S3 path prefix)")
    stage_parser.add_argument("--role-arn", required=True, help="SageMaker execution role ARN")
    stage_parser.add_argument("--region", default=None, help="AWS region (default: from environment)")
    stage_parser.add_argument("--container-image", default=None, help="Override container image URI")
    stage_parser.add_argument("--no-wait", action="store_true", default=False, help="Return immediately after submitting")

    # ── status ────────────────────────────────────────────────────────────
    status_parser = subparsers.add_parser("status", help="Check Processing Job status")
    status_parser.add_argument("--job-name", required=True, help="Processing Job name to check")
    status_parser.add_argument("--region", default=None, help="AWS region (default: from environment)")

    # ── Parse and dispatch ────────────────────────────────────────────────
    args = parser.parse_args()

    if not args.subcommand:
        parser.print_help()
        sys.exit(1)

    if args.subcommand == "stage-from-tune":
        cmd_stage_from_tune(args)
    elif args.subcommand == "status":
        cmd_adapter_status(args)
    else:
        _error_exit(f"Unknown subcommand: {args.subcommand}")


if __name__ == "__main__":
    main()

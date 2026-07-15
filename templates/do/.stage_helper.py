#!/usr/bin/env python3
from __future__ import annotations
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Stage helper dispatcher — routes do/stage subcommands to focused modules.

Subcommands: submit, status, cancel
All output is JSON on stdout for bash consumption.
"""

import argparse
import os
import sys

# Add lib/python to path for sub-module imports
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'python'))

from common import _error_exit  # noqa: E402
from stage_model import cmd_submit, cmd_status, cmd_cancel  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="SageMaker Processing Job helper for model staging")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # submit
    submit_parser = subparsers.add_parser("submit", help="Submit a Processing Job")
    submit_parser.add_argument("--model-name", required=True, help="HuggingFace model ID")
    submit_parser.add_argument("--bucket", required=True, help="S3 bucket for staging")
    submit_parser.add_argument("--project", required=True, help="Project name")
    submit_parser.add_argument("--role-arn", required=True, help="IAM execution role ARN")
    submit_parser.add_argument("--region", required=True, help="AWS region")
    submit_parser.add_argument("--hf-token", default="", help="HuggingFace token (for gated models)")
    submit_parser.add_argument("--instance-type", default="ml.m5.xlarge", help="Instance type")
    submit_parser.add_argument("--volume-size-gb", type=int, default=2048, help="Volume size in GB")
    submit_parser.add_argument("--no-wait", action="store_true", help="Return immediately without polling")
    submit_parser.add_argument("--force", action="store_true", help="Re-stage even if already present")

    # status
    status_parser = subparsers.add_parser("status", help="Check Processing Job status")
    status_parser.add_argument("--job-name", required=True, help="Processing Job name")
    status_parser.add_argument("--region", default=None, help="AWS region")

    # cancel
    cancel_parser = subparsers.add_parser("cancel", help="Cancel a Processing Job")
    cancel_parser.add_argument("--job-name", required=True, help="Processing Job name")
    cancel_parser.add_argument("--region", default=None, help="AWS region")

    args = parser.parse_args()

    # Set region in environment if provided
    region = getattr(args, "region", None)
    if region:
        os.environ.setdefault("AWS_DEFAULT_REGION", region)
        os.environ.setdefault("AWS_REGION", region)

    command_map = {
        "submit": cmd_submit,
        "status": cmd_status,
        "cancel": cmd_cancel,
    }

    handler = command_map.get(args.command)
    if handler:
        handler(args)
    else:
        _error_exit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()

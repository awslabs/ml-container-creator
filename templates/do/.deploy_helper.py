#!/usr/bin/env python3
from __future__ import annotations
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Deploy helper dispatcher — Python entrypoint for interactive deploy prompts.

Subcommands:
    prompt  - Run the interactive prompt flow (or skip if all flags provided)
    status  - Query and display current deployment status

All output is JSON on stdout for bash consumption.
Callers: do/deploy (bash dispatcher)
"""

import argparse
import json
import os
import sys

# Add lib/python to path for sub-module imports
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'python'))

from deploy_prompts import run_prompt_flow, parse_config  # noqa: E402
from deploy_schema import SCHEMAS, STATUS_VARS, validate_config  # noqa: E402


# ---------------------------------------------------------------------------
# Subcommand: prompt
# ---------------------------------------------------------------------------


def cmd_prompt(args: argparse.Namespace) -> None:
    """Execute the interactive prompt flow and output JSON answers.

    Delegates to deploy_prompts.run_prompt_flow() which handles:
    - Config parsing and diffing against target schema
    - Interactive prompts (or env-var/flag-based answers)
    - JSON output on stdout

    CLI flags are converted to DEPLOY_ANSWERS JSON keys and merged with
    any --answers-file content (flags take priority over file values).
    This allows full non-interactive operation when all required flags
    for a target are provided.

    Args:
        args: Parsed argparse namespace with config_file, target,
              instance_type, answers_file, and all per-target options.

    Validates: Requirements FR-3.1, FR-3.2
    """
    # If --answers-file is provided, validate and load into DEPLOY_ANSWERS env var
    file_answers: dict = {}
    if args.answers_file:
        if not os.path.isfile(args.answers_file):
            print(json.dumps({"error": f"Answers file not found: {args.answers_file}"}))
            sys.exit(1)
        with open(args.answers_file) as f:
            content = f.read().strip()
        # Validate that the file contains valid JSON
        try:
            file_answers = json.loads(content)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON in answers file: {e}"}))
            sys.exit(1)

    # Mapping from CLI flag attribute names to DEPLOY_ANSWERS JSON keys
    flag_to_answer_key: dict[str, str] = {
        "target": "target",
        "instance_type": "instance_type",
        "endpoint_name": "endpoint_name",
        "endpoint_strategy": "endpoint_strategy",
        "instance_types": "instance_types",
        "gpu_count": "gpu_count",
        "cluster_name": "cluster_name",
        "namespace": "namespace",
        "replicas": "replicas",
        "queue": "queue",
        "async_output_path": "async_output_path",
        "async_sns_topic": "async_sns_topic",
        "async_max_concurrent": "async_max_concurrent",
        "batch_input_path": "batch_input_path",
        "batch_output_path": "batch_output_path",
        "batch_split_type": "batch_split_type",
        "batch_strategy": "batch_strategy",
        "batch_max_concurrent": "batch_max_concurrent",
    }

    # Collect non-empty flag values
    flag_answers: dict[str, str] = {}
    for attr, answer_key in flag_to_answer_key.items():
        value = getattr(args, attr, "")
        if value:
            flag_answers[answer_key] = value

    # Merge: file answers as base, flags override
    merged_answers: dict = {}
    if file_answers:
        merged_answers.update(file_answers)
    if flag_answers:
        merged_answers.update(flag_answers)

    # Set DEPLOY_ANSWERS if we have any pre-set values
    if merged_answers:
        os.environ["DEPLOY_ANSWERS"] = json.dumps(merged_answers)

    # TTY check: if stdin is not a TTY and we have no pre-set answers,
    # interactive prompts will be needed but cannot be displayed.
    # Exit with actionable error guidance. (NFR-2.2, Design error table)
    if not sys.stdin.isatty() and not merged_answers:
        print(json.dumps({
            "error": (
                "Interactive prompts required but no TTY detected. "
                "Use --target and --instance-type flags, or set "
                "DEPLOY_ANSWERS env var. Run: do/deploy --help"
            )
        }))
        sys.exit(1)

    run_prompt_flow(
        config_path=args.config_file,
        pre_target=args.target or None,
        pre_instance_type=args.instance_type or None,
    )


# ---------------------------------------------------------------------------
# Subcommand: status
# ---------------------------------------------------------------------------


def cmd_status(args: argparse.Namespace) -> None:
    """Query and display current deployment status for all targets.

    Reads do/config and prints per-target status in JSON format. Each target
    includes its deployment status plus target-specific context details
    (endpoint name, cluster name, GPU count, etc.).

    Handles non-existent config file gracefully — reports all targets as
    "not deployed" (first-time scenario).

    Args:
        args: Parsed argparse namespace with config_file and target options.

    Validates: Requirements FR-2.8, FR-4.7, FR-3.1
    """
    config_vars = parse_config(args.config_file)

    # Build status report for all targets (or just the requested one)
    status_report: dict[str, dict[str, str]] = {}

    targets_to_check = [args.target] if args.target else list(SCHEMAS.keys())

    for target in targets_to_check:
        status_var = STATUS_VARS.get(target, "")
        status_value = config_vars.get(status_var, "")
        instance_type = config_vars.get("INSTANCE_TYPE", "")

        target_info: dict[str, str] = {
            "status": status_value or "not deployed",
            "status_var": status_var,
            "instance_type": instance_type,
        }

        # Add target-specific context details
        target_info.update(_get_target_details(target, config_vars))

        status_report[target] = target_info

    active_target = config_vars.get("DEPLOYMENT_TARGET", "")

    result = {
        "active_target": active_target,
        "targets": status_report,
    }

    print(json.dumps(result))
    sys.exit(0)


# ---------------------------------------------------------------------------
# Per-target detail extraction
# ---------------------------------------------------------------------------

# Maps each target to the config variables that provide context details
_TARGET_DETAIL_VARS: dict[str, dict[str, str]] = {
    "realtime-inference": {
        "endpoint_name": "ENDPOINT_NAME",
        "endpoint_strategy": "ENDPOINT_STRATEGY",
    },
    "hyperpod-eks": {
        "cluster_name": "HP_CLUSTER_NAME",
        "gpu_count": "HP_GPU_COUNT",
        "namespace": "HP_NAMESPACE",
    },
    "async-inference": {
        "s3_output_path": "ASYNC_S3_OUTPUT_PATH",
    },
    "batch-transform": {
        "input_path": "BATCH_INPUT_PATH",
        "output_path": "BATCH_OUTPUT_PATH",
    },
}


def _get_target_details(target: str, config_vars: dict[str, str]) -> dict[str, str]:
    """Extract target-specific context details from config variables.

    Each target has specific details that provide useful context in status
    output (e.g., endpoint name for realtime-inference, cluster name for
    hyperpod-eks).

    Args:
        target: Deployment target key (e.g. "realtime-inference").
        config_vars: Parsed config variable mapping.

    Returns:
        Dict of {detail_key: value} for the target. Values default to
        empty string if not present in config.
    """
    detail_map = _TARGET_DETAIL_VARS.get(target, {})
    details: dict[str, str] = {}

    for detail_key, config_var in detail_map.items():
        details[detail_key] = config_vars.get(config_var, "")

    return details


# ---------------------------------------------------------------------------
# CLI argument parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Build the argparse parser with prompt and status subcommands."""
    parser = argparse.ArgumentParser(
        prog=".deploy_helper.py",
        description="Deploy helper — interactive prompt flow and status queries.",
    )
    subparsers = parser.add_subparsers(dest="subcommand")

    # -- prompt subcommand --
    prompt_parser = subparsers.add_parser(
        "prompt",
        help="Run the interactive deployment prompt flow",
    )
    prompt_parser.add_argument(
        "--config-file",
        required=True,
        help="Path to do/config file",
    )
    prompt_parser.add_argument(
        "--target",
        default="",
        help="Pre-select deployment target (skips target prompt)",
    )
    prompt_parser.add_argument(
        "--instance-type",
        default="",
        help="Pre-select instance type (skips instance prompt)",
    )
    prompt_parser.add_argument(
        "--answers-file",
        default="",
        help="Path to JSON answers file for non-interactive mode",
    )
    prompt_parser.add_argument(
        "--output-file",
        default="",
        help="Write JSON output to this file instead of stdout",
    )
    # -- per-target optional flags (FR-3.1, FR-3.5) --
    prompt_parser.add_argument(
        "--endpoint-name",
        default="",
        help="Endpoint name (realtime-inference, async-inference)",
    )
    prompt_parser.add_argument(
        "--endpoint-strategy",
        default="",
        help="Endpoint strategy: new, existing, or heterogeneous",
    )
    prompt_parser.add_argument(
        "--instance-types",
        default="",
        help="Comma-separated instance types for heterogeneous endpoints",
    )
    prompt_parser.add_argument(
        "--gpu-count",
        default="",
        help="GPU count (auto-detected from instance type if omitted)",
    )
    prompt_parser.add_argument(
        "--cluster-name",
        default="",
        help="HyperPod EKS cluster name",
    )
    prompt_parser.add_argument(
        "--namespace",
        default="",
        help="Kubernetes namespace (default: 'default')",
    )
    prompt_parser.add_argument(
        "--replicas",
        default="",
        help="Number of replicas (default: '1')",
    )
    prompt_parser.add_argument(
        "--queue",
        default="",
        help="Kueue queue name",
    )
    prompt_parser.add_argument(
        "--async-output-path",
        default="",
        help="S3 output path for async inference",
    )
    prompt_parser.add_argument(
        "--async-sns-topic",
        default="",
        help="SNS topic ARN for async inference notifications",
    )
    prompt_parser.add_argument(
        "--async-max-concurrent",
        default="",
        help="Max concurrent invocations for async inference",
    )
    prompt_parser.add_argument(
        "--batch-input-path",
        default="",
        help="S3 input path for batch transform",
    )
    prompt_parser.add_argument(
        "--batch-output-path",
        default="",
        help="S3 output path for batch transform",
    )
    prompt_parser.add_argument(
        "--batch-split-type",
        default="",
        help="Batch split type: Line, RecordIO, or None",
    )
    prompt_parser.add_argument(
        "--batch-strategy",
        default="",
        help="Batch strategy: MultiRecord or SingleRecord",
    )
    prompt_parser.add_argument(
        "--batch-max-concurrent",
        default="",
        help="Max concurrent transforms for batch",
    )
    prompt_parser.set_defaults(func=cmd_prompt)

    # -- status subcommand --
    status_parser = subparsers.add_parser(
        "status",
        help="Query current deployment status",
    )
    status_parser.add_argument(
        "--config-file",
        required=True,
        help="Path to do/config file",
    )
    status_parser.add_argument(
        "--target",
        default="",
        help="Query status for a specific target only",
    )
    status_parser.set_defaults(func=cmd_status)

    return parser


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    """Parse arguments and dispatch to the appropriate subcommand."""
    parser = build_parser()
    args = parser.parse_args()

    if not args.subcommand:
        parser.print_help(sys.stderr)
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()

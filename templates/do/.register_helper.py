#!/usr/bin/env python3
from __future__ import annotations
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Register helper dispatcher — routes do/register subcommands to focused modules.

Subcommands: create-mpg, register-model, register-adapter, register-dataset,
             list-datasets, list-dataset-versions, register-evaluator,
             list-adapters, list-models, get-version, resolve-dataset, resolve-evaluator
All output is JSON on stdout for bash consumption.
"""

import argparse
import os
import sys

# Add lib/python to path for sub-module imports
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'python'))

from common import _error_exit, _output, _warn, _check_sagemaker_core  # noqa: E402
from register_common import (  # noqa: E402
    MAX_METADATA_VALUE_LEN, _REGISTRY_DIR, _CONFIG_PATH,
    _DATASETS_REGISTRY, _EVALUATORS_REGISTRY,
    _load_registry, _save_registry, _ensure_registry_dir,
    _parse_s3_uri, _is_s3_prefix,
)
from register_model import (  # noqa: E402
    cmd_create_mpg, cmd_register_model, cmd_register_adapter,
    _truncate_metadata, _build_metadata, _build_adapter_metadata,
    _extract_version_from_arn, _get_account_id, _inject_eval_metrics,
    _check_ai_registry,
)
from register_dataset import (  # noqa: E402
    cmd_register_dataset, cmd_register_evaluator,
    _get_hub_name_from_profile, _register_to_hub,
    _compute_content_hash, _get_latest_version, _increment_version,
    _parse_technique_from_description, _list_hub_datasets,
    _count_newlines_streaming, _count_rows_parquet, _count_rows,
)
from register_list import (  # noqa: E402
    cmd_list_datasets, cmd_list_dataset_versions,
    cmd_list_adapters, cmd_list_models,
)
from register_resolve import (  # noqa: E402
    cmd_resolve_dataset, cmd_resolve_evaluator, cmd_get_version,
    _resolve_dataset_version, _resolve_dataset_version_by_semver,
)


def main():
    parser = argparse.ArgumentParser(
        description="SageMaker Model Package Group helper for model registration",
        prog=".register_helper.py",
    )
    subparsers = parser.add_subparsers(dest="command", help="Subcommand")

    # ── create-mpg ────────────────────────────────────────────────────────
    mpg_parser = subparsers.add_parser("create-mpg", help="Create a Model Package Group (idempotent)")
    mpg_parser.add_argument("--project-name", required=True, help="Project name (used as MPG name)")
    mpg_parser.add_argument("--region", default=None, help="AWS region")

    # ── register-model ────────────────────────────────────────────────────
    reg_parser = subparsers.add_parser("register-model", help="Register a model as a versioned Model Package")
    reg_parser.add_argument("--project-name", required=True, help="Project name (used as MPG name)")
    reg_parser.add_argument("--deployment-config", default="", help="Deployment config (e.g., gpu-vllm)")
    reg_parser.add_argument("--container-image", default="", help="Container image URI")
    reg_parser.add_argument("--model-data-url", default="", help="Model data S3 URI")
    reg_parser.add_argument("--instance-type", default="", help="Instance type (e.g., ml.g5.2xlarge)")
    reg_parser.add_argument("--architecture", default="", help="Architecture (e.g., transformers)")
    reg_parser.add_argument("--backend", default="", help="Backend (e.g., vllm)")
    reg_parser.add_argument("--model-name", default="", help="Model name (e.g., meta-llama/Llama-3.1-8B)")
    reg_parser.add_argument("--base-image", default="", help="Base container image")
    reg_parser.add_argument("--model-format", default="", help="Model format (e.g., safetensors)")
    reg_parser.add_argument("--generator-version", default="", help="Generator version")
    reg_parser.add_argument("--region", default=None, help="AWS region")
    reg_parser.add_argument("--role-arn", default="", help="IAM execution role ARN")
    reg_parser.add_argument("--benchmark-results", default=None, help="Benchmark results JSON string")

    # ── register-adapter ──────────────────────────────────────────────────
    adapter_parser = subparsers.add_parser("register-adapter", help="Register an adapter as a versioned Model Package linked to base model")
    adapter_parser.add_argument("--project-name", required=True, help="Project name (used as MPG name)")
    adapter_parser.add_argument("--parent-version-arn", required=True, help="Base model version ARN in the same MPG")
    adapter_parser.add_argument("--tune-technique", default="", help="Tune technique (sft/dpo/rlvr)")
    adapter_parser.add_argument("--dataset-s3-uri", default="", help="Training dataset S3 URI")
    adapter_parser.add_argument("--dataset-version", default="", help="Dataset version ordinal")
    adapter_parser.add_argument("--deployment-config", default="", help="Deployment config (e.g., gpu-vllm)")
    adapter_parser.add_argument("--container-image", default="", help="Container image URI")
    adapter_parser.add_argument("--model-data-url", default="", help="Model/adapter data S3 URI")
    adapter_parser.add_argument("--instance-type", default="", help="Instance type (e.g., ml.g5.2xlarge)")
    adapter_parser.add_argument("--architecture", default="", help="Architecture (e.g., transformers)")
    adapter_parser.add_argument("--backend", default="", help="Backend (e.g., vllm)")
    adapter_parser.add_argument("--model-name", default="", help="Model name (e.g., meta-llama/Llama-3.1-8B)")
    adapter_parser.add_argument("--base-image", default="", help="Base container image")
    adapter_parser.add_argument("--model-format", default="", help="Model format (e.g., safetensors)")
    adapter_parser.add_argument("--generator-version", default="", help="Generator version")
    adapter_parser.add_argument("--region", default=None, help="AWS region")
    adapter_parser.add_argument("--role-arn", default="", help="IAM execution role ARN")

    # ── register-dataset ─────────────────────────────────────────────────
    dataset_parser = subparsers.add_parser("register-dataset", help="Register a dataset with content-aware versioning")
    dataset_parser.add_argument("--name", required=True, help="Dataset name (unique identifier)")
    dataset_parser.add_argument("--s3-uri", required=True, help="S3 URI of the dataset")
    dataset_parser.add_argument("--format", default="jsonl", choices=["jsonl", "parquet", "csv"], help="Dataset format")
    dataset_parser.add_argument("--technique", default="sft", choices=["sft", "dpo", "rlaif", "rlvr"], help="Associated tuning technique")
    dataset_parser.add_argument("--row-count", type=int, default=None, help="Number of rows in dataset")
    dataset_parser.add_argument("--column-schema", default=None, help="Column schema as JSON string")
    dataset_parser.add_argument("--project-name", default=None, help="Project name for context")
    dataset_parser.add_argument("--region", default=None, help="AWS region (for S3 hash computation)")
    dataset_parser.add_argument("--force", action="store_true", default=False, help="Force new version even if content hash matches")

    # ── list-datasets ─────────────────────────────────────────────────────
    list_datasets_parser = subparsers.add_parser("list-datasets", help="List all registered datasets")
    list_datasets_parser.add_argument("--technique", default=None, choices=["sft", "dpo", "rlaif", "rlvr"], help="Filter by tuning technique")
    list_datasets_parser.add_argument("--source", choices=["remote", "local", "all"], default="all", help="Dataset source to list")
    list_datasets_parser.add_argument("--region", default=None, help="AWS region")

    # ── list-dataset-versions ─────────────────────────────────────────────
    list_dv_parser = subparsers.add_parser("list-dataset-versions", help="List all versions for a specific dataset by name")
    list_dv_parser.add_argument("--name", required=True, help="Dataset name to list versions for")

    # ── register-evaluator ────────────────────────────────────────────────
    evaluator_parser = subparsers.add_parser("register-evaluator", help="Register an evaluator into the local registry")
    evaluator_parser.add_argument("--name", required=True, help="Evaluator name (unique identifier)")
    evaluator_parser.add_argument("--type", required=True, choices=["lambda", "model"], help="Evaluator type", dest="eval_type")
    evaluator_parser.add_argument("--arn-or-uri", required=True, help="Lambda ARN (RLVR) or model S3 URI (RLAIF)")
    evaluator_parser.add_argument("--technique", required=True, choices=["rlvr", "rlaif"], help="Associated technique")
    evaluator_parser.add_argument("--description", default="", help="Evaluator description")
    evaluator_parser.add_argument("--project-name", default=None, help="Project name for context")

    # ── list-adapters ─────────────────────────────────────────────────────
    list_adapters_parser = subparsers.add_parser("list-adapters", help="List adapter versions from MPG")
    list_adapters_parser.add_argument("--project-name", required=True, help="Project name (MPG name)")
    list_adapters_parser.add_argument("--region", default=None, help="AWS region")

    # ── list-models ───────────────────────────────────────────────────────
    list_models_parser = subparsers.add_parser("list-models", help="List base model versions from MPG")
    list_models_parser.add_argument("--project-name", required=True, help="Project name (MPG name)")
    list_models_parser.add_argument("--region", default=None, help="AWS region")

    # ── get-version ───────────────────────────────────────────────────────
    get_version_parser = subparsers.add_parser("get-version", help="Get details for a specific model package version by ARN")
    get_version_parser.add_argument("--arn", required=True, help="Model package version ARN")
    get_version_parser.add_argument("--region", default=None, help="AWS region")

    # ── resolve-dataset ───────────────────────────────────────────────────
    resolve_dataset_parser = subparsers.add_parser("resolve-dataset", help="Resolve a registered dataset by name")
    resolve_dataset_parser.add_argument("--name", required=True, help="Dataset name to resolve")
    resolve_dataset_parser.add_argument("--version", type=str, default=None, help="Version to resolve: ordinal or semver")

    # ── resolve-evaluator ─────────────────────────────────────────────────
    resolve_evaluator_parser = subparsers.add_parser("resolve-evaluator", help="Resolve a registered evaluator by name")
    resolve_evaluator_parser.add_argument("--name", required=True, help="Evaluator name to resolve")

    # ── Parse and dispatch ────────────────────────────────────────────────
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Set region before any sagemaker-core import
    region = getattr(args, 'region', None) or os.environ.get('AWS_DEFAULT_REGION') or os.environ.get('AWS_REGION')
    if region:
        os.environ['AWS_DEFAULT_REGION'] = region
        os.environ.setdefault('AWS_REGION', region)

    command_map = {
        "create-mpg": cmd_create_mpg,
        "register-model": cmd_register_model,
        "register-adapter": cmd_register_adapter,
        "register-dataset": cmd_register_dataset,
        "list-datasets": cmd_list_datasets,
        "list-dataset-versions": cmd_list_dataset_versions,
        "register-evaluator": cmd_register_evaluator,
        "list-adapters": cmd_list_adapters,
        "list-models": cmd_list_models,
        "get-version": cmd_get_version,
        "resolve-dataset": cmd_resolve_dataset,
        "resolve-evaluator": cmd_resolve_evaluator,
    }

    handler = command_map.get(args.command)
    if handler:
        handler(args)
    else:
        _error_exit(f"Unknown subcommand: {args.command}", code="UNKNOWN_COMMAND")


if __name__ == "__main__":
    main()

from __future__ import annotations
"""Tune stage-hf: download HuggingFace datasets to S3 for SageMaker training.

Purpose: cmd_stage_hf subcommand for do/tune
Inputs: --hf-org, --hf-name, --hf-split, --output-bucket, --region, etc.
Outputs: JSON with s3_uri, num_records
Caller: .tune_helper.py dispatcher
Related: dataset_qol.py (relocated dataset QoL helpers), tune_validate.py

NOTE (BL092): The dataset QoL helpers (column-map suggestion/apply, required-
column validation, multi-file ?file= selection, schema-divergence detection,
chat-format flattening, HF split resolution, row counting) now live in
``dataset_qol.py`` and are shared with ``do/register dataset``. They are
re-exported here so the staging path below is behavior-identical.
"""

import os
import sys

from common import _output, _error_exit

# ── Dataset QoL (relocated to dataset_qol.py; re-exported as a thin shim) ──────
from dataset_qol import (  # noqa: F401 — re-exported for staging + back-compat
    _GLOB_METACHAR_RE,
    _get_required_columns,
    _get_schema_types,
    _suggest_column_map,
    _parse_column_map,
    _apply_column_map,
    _detect_chat_columns,
    _flatten_value,
    _flatten_record,
    _log_flatten_info,
    _validate_dataset_columns,
    _check_empty_fields,
    _find_data_files,
    _is_glob_pattern,
    _filter_data_files,
    _inspect_file_schemas,
    _check_schema_divergence,
)



def _lookup_registered_technique(dataset_name, region):
    """Look up the registered technique for a dataset from the S3 sidecar.

    BL092 hard cutover: the local ``datasets.json`` is no longer read. The
    dataset sidecar in the Core bucket is the source of truth; the Hub is a
    best-effort fallback. Returns None if unresolved (soft warning path).
    """
    import re as _re

    core_bucket = os.environ.get("CORE_BUCKET") or os.environ.get("MLCC_CORE_BUCKET")
    if core_bucket:
        try:
            import dataset_store
            s3 = dataset_store._get_s3_client(region)
            sidecar = dataset_store.read_sidecar(s3, core_bucket, dataset_name)
            if sidecar:
                versions = sidecar.get("versions", [])
                if versions:
                    return versions[-1].get("technique") or sidecar.get("technique")
                return sidecar.get("technique")
        except Exception:
            pass
    # Hub fallback (best-effort)
    try:
        import json as _json
        import boto3
        config_path = os.path.join(os.path.expanduser('~'), '.ml-container-creator', 'config.json')
        if os.path.exists(config_path):
            with open(config_path) as f:
                config = _json.load(f)
            profiles = config.get('profiles', {})
            hub_name = None
            for profile in profiles.values():
                if not isinstance(profile, dict):
                    continue
                hub_name = profile.get('aiRegistryHubName')
                if hub_name:
                    break
            if hub_name:
                sm = boto3.client('sagemaker', region_name=region)
                resp = sm.describe_hub_content(
                    HubName=hub_name, HubContentType='Dataset', HubContentName=dataset_name
                )
                desc = resp.get('HubContentDescription', '')
                match = _re.search(r'\[technique:([^\]]+)\]', desc)
                if match:
                    return match.group(1)
    except Exception:
        pass
    return None


def _check_technique_mismatch(dataset_name, current_technique, region):
    """Warn (or auto-decline in MLCC_AUTO_MODE) if technique mismatch detected."""
    registered_technique = _lookup_registered_technique(dataset_name, region)
    if not registered_technique or registered_technique == current_technique:
        return
    print(
        f"\u26a0\ufe0f  Dataset '{dataset_name}' was registered for technique '{registered_technique}' "
        f"but you're using --technique {current_technique}. Proceeding anyway.",
        file=sys.stderr,
    )
    auto_mode = os.environ.get('MLCC_AUTO_MODE', '').lower() in ('1', 'true', 'yes')
    if auto_mode:
        print(
            f"\u274c Auto-mode: declining mismatched technique. "
            f"Use --technique {registered_technique} or register a new dataset version.",
            file=sys.stderr,
        )
        sys.exit(4)


def _resolve_hf_token(region, secret_name=None):
    """Resolve HF token from Secrets Manager or environment variable."""
    if secret_name:
        try:
            import boto3
            client = boto3.client("secretsmanager", region_name=region)
            response = client.get_secret_value(SecretId=secret_name)
            secret_value = response.get("SecretString", "")
            if secret_value:
                return secret_value.strip()
        except Exception:
            pass

    return os.environ.get("HF_TOKEN")


def cmd_stage_hf(args):
    """Download HF dataset to S3 using huggingface_hub.

    Handles auth via Secrets Manager or HF_TOKEN env var.

    Returns: {"s3_uri": str, "num_records": int}
    """
    # Suppress HF Hub progress bars — they pollute stdout which must be clean JSON
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

    try:
        from huggingface_hub import hf_hub_download, HfApi
    except ImportError:
        _error_exit(
            "huggingface_hub is not installed. "
            "Please install: pip install huggingface_hub"
        )

    import boto3
    import tempfile

    # Resolve HF token: Secrets Manager first, then env var
    hf_token = _resolve_hf_token(args.region, args.hf_secret_name)

    # Parse the HF reference
    org = args.hf_org
    name = args.hf_name
    split = args.hf_split or "train"
    dataset_id = f"{org}/{name}"

    # Technique guardrail: warn if dataset was registered for a different technique
    technique = getattr(args, 'technique', 'sft')
    _check_technique_mismatch(name, technique, args.region)

    # Download dataset files to a temp directory
    try:
        api = HfApi(token=hf_token)

        # List files in the dataset repo
        repo_files = api.list_repo_files(
            repo_id=dataset_id,
            repo_type="dataset",
            token=hf_token,
        )

        # Find the appropriate data file for the split
        data_files = _find_data_files(repo_files, split)

        # Apply file filter if --hf-file is provided
        hf_file_pattern = getattr(args, 'hf_file', None)

        if not data_files and hf_file_pattern:
            all_data_files = [
                f for f in repo_files
                if f.endswith(('.parquet', '.jsonl', '.json'))
                and not f.startswith('.')
            ]
            if all_data_files:
                data_files = _filter_data_files(all_data_files, hf_file_pattern)
        elif hf_file_pattern and data_files:
            data_files = _filter_data_files(data_files, hf_file_pattern)

        if not data_files:
            _error_exit(
                f"No data files found for split '{split}' in dataset {dataset_id}. "
                f"Available files: {', '.join(repo_files[:20])}"
            )

        # Download and upload to S3
        s3_client = boto3.client("s3", region_name=args.region)
        # Output prefix resolution:
        #   • Default (do/tune, do/train): project-scoped, keyed by HF org/name/split
        #     so each project stages into its own namespace.
        #   • Override (do/register): an explicit --output-prefix pins the dataset to
        #     the canonical, project-independent location 'datasets/<name>' so it is
        #     shared across projects. The prefix is used verbatim (no split segment)
        #     so the data lands exactly at 's3://<bucket>/datasets/<name>/', matching
        #     the sidecar location 'datasets/<name>/_dataset.json'.
        output_prefix = getattr(args, "output_prefix", None)
        if output_prefix:
            s3_prefix = output_prefix.strip("/")
        else:
            s3_prefix = f"{args.project_name}/datasets/{org}/{name}/{split}"
        num_records = 0
        empty_field_counts = {}

        with tempfile.TemporaryDirectory() as tmpdir:
            # Schema divergence check (skip for single file)
            if len(data_files) > 1:
                column_map = _parse_column_map(getattr(args, 'column_map', None))
                technique = getattr(args, 'technique', 'sft')
                no_transform = getattr(args, 'no_transform', False)
                file_records = _inspect_file_schemas(
                    data_files, dataset_id, hf_token, tmpdir,
                    column_map, technique, no_transform
                )
                _check_schema_divergence(file_records, dataset_id, technique)

            for data_file in data_files:
                local_path = hf_hub_download(
                    repo_id=dataset_id,
                    filename=data_file,
                    repo_type="dataset",
                    token=hf_token,
                    local_dir=tmpdir,
                )

                # Handle Parquet files: convert to JSONL for SageMaker compatibility
                if data_file.endswith(".parquet"):
                    try:
                        import pyarrow.parquet as pq
                        import json as json_mod

                        table = pq.read_table(local_path)
                        jsonl_filename = os.path.splitext(os.path.basename(data_file))[0] + ".jsonl"
                        jsonl_path = os.path.join(tmpdir, jsonl_filename)

                        column_map = _parse_column_map(getattr(args, 'column_map', None))
                        technique = getattr(args, 'technique', 'sft')
                        no_transform = getattr(args, 'no_transform', False)
                        batches = table.to_batches(max_chunksize=1)
                        first_record = batches[0].to_pylist()[0] if batches else {}
                        _validate_dataset_columns(first_record, technique, getattr(args, 'column_map', None), f"{org}/{name}", take=getattr(args, 'take', None))

                        mapped_first = _apply_column_map(first_record, column_map)
                        required_columns = _get_required_columns(technique)
                        schema_types = _get_schema_types(technique)

                        chat_columns = _detect_chat_columns(mapped_first, required_columns, schema_types)

                        if chat_columns:
                            _log_flatten_info(chat_columns, no_transform)

                        if no_transform and chat_columns:
                            col_name = next(iter(chat_columns))
                            det = chat_columns[col_name]
                            det_type = det.get("type")
                            strategy = det.get("strategy", "")
                            if det_type == "single_dict":
                                strategy_desc = "single message dict with role+content"
                            elif strategy == "extract":
                                strategy_desc = "message list (single element)"
                            elif strategy == "same_role":
                                strategy_desc = f"message list ({det.get('count', 0)} messages, same role)"
                            elif strategy == "multi_role":
                                strategy_desc = f"message list (multi-turn, {det.get('count', 0)} messages)"
                            else:
                                strategy_desc = det_type
                            _error_exit(
                                f"Column '{col_name}' contains chat-format data (detected: {det_type}) but --no-transform is active.\n\n"
                                f"   Remove --no-transform to enable automatic conversion:\n"
                                f"      ./do/register dataset <name> --hf-id {org}/{name} --technique {technique} [--column-map ...]\n\n"
                                f"   Detected format: {strategy_desc}"
                            )

                        take_limit = getattr(args, 'take', None)
                        with open(jsonl_path, "w", encoding="utf-8") as out_f:
                            for batch in table.to_batches():
                                for row in batch.to_pylist():
                                    if take_limit and num_records >= take_limit:
                                        break
                                    mapped_row = _apply_column_map(row, column_map)
                                    if chat_columns and not no_transform:
                                        mapped_row = _flatten_record(mapped_row, chat_columns)
                                    for col in _check_empty_fields(mapped_row, required_columns):
                                        empty_field_counts[col] = empty_field_counts.get(col, 0) + 1
                                    out_f.write(json_mod.dumps(mapped_row, ensure_ascii=False) + "\n")
                                    num_records += 1
                                if take_limit and num_records >= take_limit:
                                    break

                        file_size = os.path.getsize(jsonl_path)
                        if file_size == 0:
                            _error_exit(
                                f"Converted JSONL file is empty (0 bytes) after processing "
                                f"{num_records} records. This is a bug — please report it."
                            )
                        s3_key = f"{s3_prefix}/{jsonl_filename}"
                        s3_client.upload_file(jsonl_path, args.output_bucket, s3_key)

                    except ImportError:
                        _error_exit(
                            "Dataset is in Parquet format but pyarrow is not installed. "
                            "Please install: pip install pyarrow"
                        )
                else:
                    # JSONL file — validate columns and apply mapping
                    import json as json_mod
                    column_map = _parse_column_map(getattr(args, 'column_map', None))
                    technique = getattr(args, 'technique', 'sft')
                    no_transform = getattr(args, 'no_transform', False)

                    chat_columns = {}
                    with open(local_path, "r", encoding="utf-8", errors="replace") as f:
                        first_line = f.readline().strip()
                        if first_line:
                            first_record = json_mod.loads(first_line)
                            _validate_dataset_columns(first_record, technique, getattr(args, 'column_map', None), f"{org}/{name}", take=getattr(args, 'take', None))

                            mapped_first = _apply_column_map(first_record, column_map)
                            required_columns = _get_required_columns(technique)
                            schema_types = _get_schema_types(technique)

                            chat_columns = _detect_chat_columns(mapped_first, required_columns, schema_types)

                            if chat_columns:
                                _log_flatten_info(chat_columns, no_transform)

                            if no_transform and chat_columns:
                                col_name = next(iter(chat_columns))
                                det = chat_columns[col_name]
                                det_type = det.get("type")
                                strategy = det.get("strategy", "")
                                if det_type == "single_dict":
                                    strategy_desc = "single message dict with role+content"
                                elif strategy == "extract":
                                    strategy_desc = "message list (single element)"
                                elif strategy == "same_role":
                                    strategy_desc = f"message list ({det.get('count', 0)} messages, same role)"
                                elif strategy == "multi_role":
                                    strategy_desc = f"message list (multi-turn, {det.get('count', 0)} messages)"
                                else:
                                    strategy_desc = det_type
                                _error_exit(
                                    f"Column '{col_name}' contains chat-format data (detected: {det_type}) but --no-transform is active.\n\n"
                                    f"   Remove --no-transform to enable automatic conversion:\n"
                                    f"      ./do/register dataset <name> --hf-id {org}/{name} --technique {technique} [--column-map ...]\n\n"
                                    f"   Detected format: {strategy_desc}"
                                )

                    should_flatten = bool(chat_columns) and not no_transform
                    take_limit = getattr(args, 'take', None)
                    if column_map or should_flatten or take_limit:
                        mapped_path = local_path + ".mapped"
                        with open(local_path, "r", encoding="utf-8", errors="replace") as f_in, \
                             open(mapped_path, "w", encoding="utf-8") as f_out:
                            for line in f_in:
                                if take_limit and num_records >= take_limit:
                                    break
                                line = line.strip()
                                if not line:
                                    continue
                                record = json_mod.loads(line)
                                mapped_record = _apply_column_map(record, column_map)
                                if should_flatten:
                                    mapped_record = _flatten_record(mapped_record, chat_columns)
                                for col in _check_empty_fields(mapped_record, _get_required_columns(technique)):
                                    empty_field_counts[col] = empty_field_counts.get(col, 0) + 1
                                f_out.write(json_mod.dumps(mapped_record, ensure_ascii=False) + "\n")
                                num_records += 1
                        local_path = mapped_path
                    else:
                        take_limit = getattr(args, 'take', None)
                        if take_limit:
                            mapped_path = local_path + ".mapped"
                            with open(local_path, "r", encoding="utf-8", errors="replace") as f_in, \
                                 open(mapped_path, "w", encoding="utf-8") as f_out:
                                for line in f_in:
                                    if num_records >= take_limit:
                                        break
                                    if line.strip():
                                        f_out.write(line)
                                        num_records += 1
                            local_path = mapped_path
                        else:
                            with open(local_path, "r", encoding="utf-8", errors="replace") as f:
                                for line in f:
                                    if line.strip():
                                        num_records += 1

                    s3_key = f"{s3_prefix}/{os.path.basename(data_file)}"
                    s3_client.upload_file(local_path, args.output_bucket, s3_key)

        first_file = data_files[0]
        if first_file.endswith(".parquet"):
            output_filename = os.path.splitext(os.path.basename(first_file))[0] + ".jsonl"
        else:
            output_filename = os.path.basename(first_file)
        s3_uri = f"s3://{args.output_bucket}/{s3_prefix}/{output_filename}"

        if num_records > 0 and empty_field_counts:
            for field, count in empty_field_counts.items():
                pct = (count / num_records) * 100
                if pct > 30:
                    print(
                        f"\u26a0\ufe0f  Warning: {pct:.0f}% of records ({count}/{num_records}) "
                        f"have empty '{field}' after column mapping.\n"
                        f"   SageMaker may reject these as invalid samples.\n"
                        f"   Consider using a different --column-map or dataset.",
                        file=sys.stderr,
                    )

        _output({
            "s3_uri": s3_uri,
            "num_records": num_records,
        })

    except Exception as e:
        error_msg = str(e)
        if "404" in error_msg or "not found" in error_msg.lower():
            _error_exit(
                f"Dataset not found: {dataset_id}. "
                f"Check the dataset name and ensure it exists on Hugging Face Hub."
            )
        elif "401" in error_msg or "unauthorized" in error_msg.lower():
            _error_exit(
                f"Authentication failed for dataset {dataset_id}. "
                f"Ensure HF_TOKEN is set or configured via Secrets Manager."
            )
        else:
            _error_exit(f"Failed to stage HF dataset: {error_msg}")

from __future__ import annotations
"""Tune stage-hf: download HuggingFace datasets to S3 for SageMaker training.

Purpose: cmd_stage_hf subcommand for do/tune
Inputs: --hf-org, --hf-name, --hf-split, --output-bucket, --region, etc.
Outputs: JSON with s3_uri, num_records
Caller: .tune_helper.py dispatcher
Related: tune_validate.py (dataset schema validation)
"""

import fnmatch
import json
import os
import re
import sys

from common import _output, _error_exit

_GLOB_METACHAR_RE = re.compile(r'[*?\[]')


def _get_required_columns(technique):
    """Return the required column names for a given technique."""
    schemas = {
        "sft": ["prompt", "completion"],
        "dpo": ["prompt", "chosen", "rejected"],
        "rlaif": ["prompt"],  # prompt is an array of messages
        "rlvr": ["prompt"],   # prompt is an array of messages
    }
    return schemas.get(technique, ["prompt", "completion"])


def _suggest_column_map(detected_columns, required_columns):
    """Suggest a --column-map based on common column name patterns."""
    aliases = {
        "prompt": ["question", "instruction", "input", "query", "text", "context", "user", "human"],
        "completion": ["answer", "output", "response", "assistant", "target", "label", "reply"],
        "chosen": ["chosen", "preferred", "good", "positive", "accepted"],
        "rejected": ["rejected", "dispreferred", "bad", "negative", "refused"],
    }

    suggestions = {}
    for req_col in required_columns:
        if req_col in detected_columns:
            continue
        for alias in aliases.get(req_col, []):
            if alias in detected_columns:
                suggestions[req_col] = alias
                break

    if not suggestions:
        return None

    mapping_str = ",".join(f"{k}={v}" for k, v in suggestions.items())
    return mapping_str


def _parse_column_map(column_map_str):
    """Parse a column map string like 'prompt=question,completion=answer' into a dict."""
    if not column_map_str:
        return {}
    mapping = {}
    for pair in column_map_str.split(","):
        pair = pair.strip()
        if "=" not in pair:
            continue
        target, source = pair.split("=", 1)
        mapping[target.strip()] = source.strip()
    return mapping


def _apply_column_map(record, column_map):
    """Apply column mapping to a record: rename source columns to target names."""
    if not column_map:
        return record
    mapped = dict(record)
    for target, source in column_map.items():
        if source in mapped and target not in mapped:
            mapped[target] = mapped.pop(source)
    return mapped


def _detect_chat_columns(record, required_columns, schema_types):
    """Detect which required columns contain chat-format data.

    Only inspects columns whose schema type is "string". Columns with
    "array" type (RLAIF/RLVR) are excluded from detection entirely.

    Args:
        record: The first record (dict) after column mapping
        required_columns: List of required column names for the technique
        schema_types: Dict mapping column name -> expected type from schema

    Returns:
        dict: Maps column_name -> detection_result where detection_result is:
              {"type": "single_dict"} or
              {"type": "message_list", "strategy": "extract"|"same_role"|"multi_role", "count": int}
              Only columns detected as chat-format are included.
    """
    results = {}
    for column in required_columns:
        if schema_types.get(column) != "string":
            continue
        if column not in record:
            continue

        value = record[column]

        if isinstance(value, dict) and "role" in value and "content" in value:
            results[column] = {"type": "single_dict"}
            continue

        if isinstance(value, list) and len(value) > 0:
            first_element = value[0]
            if isinstance(first_element, dict) and "role" in first_element and "content" in first_element:
                count = len(value)
                if count == 1:
                    strategy = "extract"
                elif all(
                    isinstance(elem, dict) and elem.get("role") == first_element["role"]
                    for elem in value
                ):
                    strategy = "same_role"
                else:
                    strategy = "multi_role"
                results[column] = {"type": "message_list", "strategy": strategy, "count": count}
                continue

    return results


def _flatten_value(value, detection_result):
    """Flatten a chat-format column value to a plain string."""
    import json as _json

    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, list) and len(value) == 0:
        return ""

    det_type = detection_result.get("type")

    if det_type == "single_dict":
        if isinstance(value, dict):
            role = value.get("role", "")
            if "content" in value:
                content = value["content"]
                if isinstance(content, str):
                    return content
                return f"{role}: {_json.dumps(content)}"
            else:
                remaining = {k: v for k, v in value.items() if k != "role"}
                return f"{role}: {_json.dumps(remaining)}"

    elif det_type == "message_list":
        strategy = detection_result.get("strategy")

        if isinstance(value, list) and len(value) > 0:
            if strategy == "extract":
                elem = value[0]
                if isinstance(elem, dict):
                    content = elem.get("content")
                    if content is None:
                        return ""
                    if isinstance(content, str):
                        return content
                    return f"{elem.get('role', '')}: {_json.dumps(content)}"
                return ""

            elif strategy == "same_role":
                parts = []
                for elem in value:
                    if isinstance(elem, dict):
                        content = elem.get("content")
                        if content is None or content == "":
                            parts.append("")
                        elif isinstance(content, str):
                            parts.append(content)
                        else:
                            parts.append(_json.dumps(content))
                    else:
                        parts.append("")
                return "\n".join(parts)

            elif strategy == "multi_role":
                lines = []
                for elem in value:
                    if isinstance(elem, dict):
                        role = elem.get("role", "")
                        content = elem.get("content")
                        if content is None:
                            content = ""
                        elif not isinstance(content, str):
                            content = _json.dumps(content)
                        lines.append(f"{role}: {content}")
                    else:
                        lines.append("")
                return "\n".join(lines)

    try:
        return str(value)
    except Exception as e:
        raise ValueError(f"Cannot convert value to string: {e}")


def _flatten_record(record, chat_columns):
    """Apply flattening to all chat-format columns in a record."""
    flattened = dict(record)
    for column_name, detection_result in chat_columns.items():
        if column_name in flattened:
            flattened[column_name] = _flatten_value(flattened[column_name], detection_result)
    return flattened


def _log_flatten_info(chat_columns, no_transform):
    """Log auto-flatten detection and strategy information."""
    for column_name, detection_result in chat_columns.items():
        print(f"\u2139\ufe0f  Auto-converted column '{column_name}' from chat-format to string", file=sys.stderr)
        det_type = detection_result.get("type")
        if det_type == "single_dict":
            print("    Format: extracted content field", file=sys.stderr)
        elif det_type == "message_list":
            strategy = detection_result.get("strategy")
            count = detection_result.get("count", 0)
            if strategy == "multi_role":
                print(f"    Format: role: content (multi-turn, {count} messages)", file=sys.stderr)
            elif strategy == "same_role":
                print(f"    Format: newline-joined content ({count} messages, same role)", file=sys.stderr)
            elif strategy == "extract":
                print("    Format: extracted content field", file=sys.stderr)


def _get_schema_types(technique):
    """Return a dict mapping column names to their expected types for a technique."""
    schemas = {
        "sft": {"prompt": "string", "completion": "string"},
        "dpo": {"prompt": "string", "chosen": "string", "rejected": "string"},
        "rlaif": {"prompt": "array"},
        "rlvr": {"prompt": "array"},
    }
    return schemas.get(technique, {"prompt": "string", "completion": "string"})


def _lookup_registered_technique(dataset_name, region):
    """Look up the registered technique for a dataset. Local registry first, then hub."""
    import json as _json
    registry_path = os.path.join(
        os.path.expanduser('~'), '.ml-container-creator', 'datasets.json'
    )
    if os.path.exists(registry_path):
        try:
            with open(registry_path) as f:
                entries = _json.load(f)
            for entry in entries:
                if entry.get('name') == dataset_name:
                    versions = entry.get('versions', [])
                    if versions:
                        return versions[-1].get('technique') or entry.get('technique')
                    return entry.get('technique')
        except Exception:
            pass
    # Hub fallback
    try:
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
                match = re.search(r'\[technique:([^\]]+)\]', desc)
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


def _validate_dataset_columns(first_record, technique, column_map_str, dataset_id, take=None):
    """Validate that the first record has required columns after mapping."""
    column_map = _parse_column_map(column_map_str)
    mapped = _apply_column_map(first_record, column_map)
    required = _get_required_columns(technique)
    detected = list(first_record.keys())

    missing = [col for col in required if col not in mapped]
    if not missing:
        return mapped, column_map

    lines = [
        f"Dataset columns don't match {technique.upper()} requirements.",
        f"",
        f"   Required columns: {', '.join(required)}",
        f"   Detected columns: {', '.join(detected)}",
        f"   Missing: {', '.join(missing)}",
    ]

    suggestion = _suggest_column_map(detected, required)
    if suggestion:
        lines.append(f"")
        lines.append(f"   \U0001f4a1 Suggested fix:")
        take_suffix = f" --take {take}" if take else ""
        lines.append(f"      ./do/tune --technique {technique} --dataset hf://{dataset_id} --column-map {suggestion}{take_suffix}")
    else:
        lines.append(f"")
        lines.append(f"   \U0001f4a1 Use --column-map to rename columns:")
        example_map = ",".join(f"{r}=<your_column>" for r in missing)
        take_suffix = f" --take {take}" if take else ""
        lines.append(f"      ./do/tune --technique {technique} --dataset hf://{dataset_id} --column-map {example_map}{take_suffix}")

    lines.append(f"")
    lines.append(f"   First record sample:")
    for k, v in list(first_record.items())[:5]:
        val_str = str(v)[:80] + ("..." if len(str(v)) > 80 else "")
        lines.append(f"      {k}: {val_str}")

    _error_exit("\n".join(lines))


def _check_empty_fields(record, required_columns):
    """Return list of required column names that are empty/blank in this record."""
    empty = []
    for col in required_columns:
        value = record.get(col, "")
        if value is None or (isinstance(value, str) and not value.strip()):
            empty.append(col)
    return empty


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


def _find_data_files(repo_files, split):
    """Find data files matching the requested split."""
    patterns = [
        f"data/{split}.jsonl",
        f"{split}.jsonl",
        f"data/{split}.json",
        f"{split}.json",
        f"data/{split}-00000-of-",
        f"{split}-00000-of-",
    ]

    for pattern in patterns[:4]:
        if pattern in repo_files:
            return [pattern]

    matches = set()
    for f in repo_files:
        for pattern in patterns[4:]:
            if pattern in f:
                matches.add(f)

    if matches:
        return sorted(matches)

    jsonl_files = [f for f in repo_files if f.endswith(".jsonl") and split in f]
    if jsonl_files:
        return sorted(jsonl_files)

    data_jsonl = [f for f in repo_files if f.startswith("data/") and f.endswith(".jsonl")]
    if data_jsonl:
        return sorted(data_jsonl)

    root_data = [f for f in repo_files if "/" not in f and (f.endswith(".jsonl") or f.endswith(".json")) and not f.startswith(".")]
    if root_data:
        return sorted(root_data)

    return []


def _is_glob_pattern(pattern):
    """Return True if pattern contains glob metacharacters (*, ?, [)."""
    return bool(_GLOB_METACHAR_RE.search(pattern))


def _filter_data_files(data_files, pattern):
    """Filter data files by glob or substring pattern."""
    if not pattern:
        return data_files

    if _is_glob_pattern(pattern):
        matched = [f for f in data_files if fnmatch.fnmatch(f, pattern)]
    else:
        matched = [f for f in data_files if pattern in os.path.basename(f)]

    if not matched:
        file_list = "\n".join(f"  \u2022 {f}" for f in data_files)
        _error_exit(
            f"No files matched pattern '{pattern}'.\n\n"
            f"Available files:\n{file_list}"
        )

    return matched


def _inspect_file_schemas(data_files, dataset_id, hf_token, tmpdir,
                          column_map, technique, no_transform):
    """Inspect first record of each file to extract effective column sets."""
    from huggingface_hub import hf_hub_download

    required_columns = _get_required_columns(technique)
    schema_types = _get_schema_types(technique)
    results = []

    for data_file in data_files:
        local_path = hf_hub_download(
            repo_id=dataset_id,
            filename=data_file,
            repo_type="dataset",
            token=hf_token,
            local_dir=tmpdir,
        )

        first_record = {}

        if data_file.endswith(".parquet"):
            try:
                import pyarrow.parquet as pq
                table = pq.read_table(local_path)
                batches = table.to_batches(max_chunksize=1)
                if batches:
                    first_record = batches[0].to_pylist()[0]
            except ImportError:
                _error_exit(
                    "Dataset is in Parquet format but pyarrow is not installed. "
                    "Please install: pip install pyarrow"
                )
        else:
            import json as json_mod
            with open(local_path, "r", encoding="utf-8", errors="replace") as f:
                first_line = f.readline().strip()
                if first_line:
                    first_record = json_mod.loads(first_line)

        mapped_record = _apply_column_map(first_record, column_map)

        if not no_transform:
            chat_columns = _detect_chat_columns(mapped_record, required_columns, schema_types)
            if chat_columns:
                mapped_record = _flatten_record(mapped_record, chat_columns)

        results.append((data_file, set(mapped_record.keys())))

    return results


def _check_schema_divergence(file_records, dataset_id, technique):
    """Check that all files have identical effective columns."""
    if not file_records:
        return None

    first_columns = file_records[0][1]
    all_identical = all(cols == first_columns for _, cols in file_records)

    if all_identical:
        return None

    file_sections = []
    for filename, columns in file_records:
        sorted_cols = ", ".join(sorted(columns))
        file_sections.append(
            f"  \U0001f4c4 {filename}\n"
            f"     Columns: {sorted_cols}"
        )

    first_file = file_records[0][0]
    basename = os.path.basename(first_file)
    name_without_ext = os.path.splitext(basename)[0]
    numeric_match = re.search(r'\d+', name_without_ext)
    if numeric_match:
        pattern_suggestion = f"*{numeric_match.group()}*"
    else:
        pattern_suggestion = f"*{name_without_ext}*"

    available_files = "\n".join(
        f"     \u2022 {filename}" for filename, _ in file_records
    )

    file_listing = "\n\n".join(file_sections)
    message = (
        f"Schema divergence detected in dataset {dataset_id}.\n"
        f"Files have different columns after applying column-map and transforms:\n\n"
        f"{file_listing}\n\n"
        f"\U0001f4a1 Use ?file=<pattern> to select compatible files:\n"
        f"   ./do/tune --technique {technique} --dataset hf://{dataset_id}?file={pattern_suggestion}\n\n"
        f"   Available files:\n{available_files}"
    )

    _error_exit(message)


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
                                f"      ./do/tune --technique {technique} --dataset hf://{org}/{name} [--column-map ...]\n\n"
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
                                    f"      ./do/tune --technique {technique} --dataset hf://{org}/{name} [--column-map ...]\n\n"
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

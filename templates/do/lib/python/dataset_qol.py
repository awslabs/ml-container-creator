from __future__ import annotations
"""Dataset QoL: reusable dataset conveniences shared across do/ subcommands.

Purpose: Column-map suggestion/apply, required-column validation, multi-file
         (?file=) selection, schema-divergence detection, chat-format flattening,
         HF split resolution, and row counting.

Relocated from ``tune_stage_hf.py`` (BL092) so both the tune staging path and
``do/register dataset`` can share behavior-identical dataset handling. The tune
staging path imports these via a thin shim to preserve existing behavior.

Callers: tune_stage_hf.py (staging), register_dataset.py (registration-time
         validation/suggestions).
"""

import fnmatch
import os
import re
import sys

from common import _error_exit

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


def _get_schema_types(technique):
    """Return a dict mapping column names to their expected types for a technique."""
    schemas = {
        "sft": {"prompt": "string", "completion": "string"},
        "dpo": {"prompt": "string", "chosen": "string", "rejected": "string"},
        "rlaif": {"prompt": "array"},
        "rlvr": {"prompt": "array"},
    }
    return schemas.get(technique, {"prompt": "string", "completion": "string"})


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


# ── HF discovery (surfaced by `do/register dataset --discover`) ───────────────
# The discovery logic below composes the same primitives used by the tune
# staging path (HfApi repo listing, `_find_data_files` split resolution, and a
# first-record schema/row peek). It is intentionally read-only and non-fatal:
# callers translate a DiscoveryError into a clear message + non-zero exit,
# consistent with existing discovery behavior.


class DiscoveryError(Exception):
    """Raised when HF dataset discovery cannot complete (repo missing, auth,
    transport). Callers surface this as a clear message + non-zero exit."""


def _split_from_filename(data_file):
    """Best-effort split-name inference from a data file path.

    Recognizes the common ``[data/]<split>[.ext]`` and
    ``<split>-00000-of-*`` sharded layouts. Returns None when ambiguous.
    """
    base = os.path.basename(data_file)
    name = base
    for ext in (".jsonl", ".json", ".parquet", ".parq", ".csv", ".tsv"):
        if name.endswith(ext):
            name = name[: -len(ext)]
            break
    # Sharded: train-00000-of-00002 → train
    shard = re.match(r"^(.*?)-\d{5}-of-\d+$", name)
    if shard:
        return shard.group(1) or None
    return name or None


def _peek_schema_and_rows(dataset_id, data_file, hf_token, tmpdir):
    """Download a single data file and return (columns, row_count).

    Best-effort: returns (columns_or_None, row_count_or_None). Never raises —
    discovery is a preview, so a peek failure degrades to unknown schema/rows
    rather than aborting the whole discovery.
    """
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        return None, None

    try:
        local_path = hf_hub_download(
            repo_id=dataset_id,
            filename=data_file,
            repo_type="dataset",
            token=hf_token,
            local_dir=tmpdir,
        )
    except Exception:
        return None, None

    columns = None
    row_count = None
    try:
        if data_file.endswith((".parquet", ".parq")):
            try:
                import pyarrow.parquet as pq
                pf = pq.ParquetFile(local_path)
                row_count = pf.metadata.num_rows
                columns = list(pf.schema_arrow.names)
            except Exception:
                columns, row_count = None, None
        else:
            import json as json_mod
            count = 0
            first_record = None
            with open(local_path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    if first_record is None:
                        try:
                            first_record = json_mod.loads(line)
                        except Exception:
                            first_record = {}
                    count += 1
            row_count = count
            if isinstance(first_record, dict):
                columns = list(first_record.keys())
    except Exception:
        return columns, row_count

    return columns, row_count


def discover_hf_dataset(dataset_id, hf_token=None, split=None, max_files=25):
    """Browse a HuggingFace dataset for pre-registration inspection.

    Reuses the shared split-resolution / file-listing primitives so discovery is
    consistent with the tune staging path. Returns a plain dict describing the
    dataset. Raises DiscoveryError on failures the caller should surface (repo
    not found, auth, transport). Per-file schema/row peeking is best-effort and
    never fatal.

    Args:
        dataset_id: HF dataset id ("org/name").
        hf_token: Optional HF token for gated/private datasets.
        split: Optional split to resolve files for; when omitted, all detected
               splits are reported.
        max_files: Cap on files peeked for schema/rows (keeps discovery cheap).

    Returns:
        {
          "dataset_id": str,
          "splits": [str, ...],
          "files_by_split": {split: [path, ...]},
          "row_counts": {split: int|None},
          "schema": [col, ...] | None,
          "schema_source": path | None,
        }
    """
    import tempfile

    try:
        from huggingface_hub import HfApi
    except ImportError:
        raise DiscoveryError(
            "huggingface_hub is not installed. Please install: pip install huggingface_hub"
        )

    try:
        api = HfApi(token=hf_token)
        repo_files = api.list_repo_files(
            repo_id=dataset_id, repo_type="dataset", token=hf_token,
        )
    except Exception as exc:  # noqa: BLE001 — classified for the caller
        msg = str(exc)
        low = msg.lower()
        if "404" in msg or "not found" in low or "repositorynotfound" in low:
            raise DiscoveryError(
                f"Dataset not found: {dataset_id}. Check the id and that it exists on the Hub."
            ) from exc
        if "401" in msg or "403" in msg or "unauthorized" in low or "forbidden" in low:
            raise DiscoveryError(
                f"Authentication failed for {dataset_id}. Set HF_TOKEN or configure a HF secret."
            ) from exc
        raise DiscoveryError(f"Could not browse {dataset_id}: {msg}") from exc

    data_exts = (".jsonl", ".json", ".parquet", ".parq", ".csv", ".tsv")
    data_files = [
        f for f in repo_files
        if f.endswith(data_exts) and not os.path.basename(f).startswith(".")
    ]

    # Infer splits from file names, then map each split to its files via the
    # shared resolver (behavior-identical to staging).
    inferred_splits = []
    for f in data_files:
        s = _split_from_filename(f)
        if s and s not in inferred_splits:
            inferred_splits.append(s)

    splits = [split] if split else (inferred_splits or (["train"] if data_files else []))

    files_by_split = {}
    for s in splits:
        matched = _find_data_files(data_files, s)
        if matched:
            files_by_split[s] = matched
    # If nothing resolved but data files exist, surface them under the requested
    # (or a synthetic "all") split so the user still sees something.
    if not files_by_split and data_files:
        files_by_split[splits[0] if splits else "all"] = sorted(data_files)
        if not splits:
            splits = ["all"]

    # Peek schema + row counts (best-effort, capped).
    row_counts = {}
    schema = None
    schema_source = None
    peeked = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        for s, files in files_by_split.items():
            split_rows = 0
            counted_any = False
            for f in files:
                if peeked >= max_files:
                    break
                cols, rows = _peek_schema_and_rows(dataset_id, f, hf_token, tmpdir)
                peeked += 1
                if rows is not None:
                    split_rows += rows
                    counted_any = True
                if schema is None and cols:
                    schema = cols
                    schema_source = f
            row_counts[s] = split_rows if counted_any else None

    return {
        "dataset_id": dataset_id,
        "splits": list(files_by_split.keys()),
        "files_by_split": files_by_split,
        "row_counts": row_counts,
        "schema": schema,
        "schema_source": schema_source,
    }


def recommended_register_invocation(dataset_id, discovery=None, name=None, split=None):
    """Build the recommended ``do/register dataset`` invocation string.

    Picks a sensible default name (repo name slug) and a default split when the
    caller does not specify one (prefers a resolved split, else "train").
    """
    default_name = name
    if not default_name:
        repo_name = dataset_id.split("/")[-1] if "/" in dataset_id else dataset_id
        slug = re.sub(r"[^a-z0-9]+", "-", repo_name.lower()).strip("-")
        default_name = slug or "dataset"

    chosen_split = split
    if not chosen_split and discovery:
        avail = discovery.get("splits") or []
        if "train" in avail:
            chosen_split = "train"
        elif avail:
            chosen_split = avail[0]

    parts = [f"./do/register dataset {default_name} --hf-id {dataset_id}"]
    if chosen_split:
        parts.append(f"--hf-split {chosen_split}")
    return " ".join(parts)

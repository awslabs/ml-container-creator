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
    # BL123: the branded-hub technique fallback (reading aiRegistryHubName +
    # describe_hub_content) was retired. The S3 sidecar is the source of truth; an
    # unresolved technique returns None (soft warning path) rather than probing a
    # hub MLCC no longer targets.
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


def _iter_source_records(local_path):
    """Yield source records from a downloaded data file (parquet or jsonl/json)."""
    if local_path.endswith((".parquet", ".parq")):
        import pyarrow.parquet as pq
        table = pq.read_table(local_path)
        for batch in table.to_batches():
            for row in batch.to_pylist():
                yield row
    else:
        import json as json_mod
        with open(local_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    yield json_mod.loads(line)


def _stage_rl_verl(args, dataset_id, org, name, split, data_files, hf_token,
                   s3_prefix, technique):
    """Produce verl 5-field PARQUET for a managed-RL technique (rlvr/rlaif) and upload
    it to a channel-pure `<s3_prefix>/data/` subprefix (ODP-2). Returns
    (s3_uri, num_records) where s3_uri is the `data/` subprefix (the training channel).

    The source records (parquet or jsonl) are transformed row-by-row into the verl
    schema by tune_producer_rl (prompt kept as a message LIST — NOT flattened —
    reward_model.style derived from the descriptor, flat ground-truth lifted into the
    nested struct), then asserted conformant before AND after write.
    """
    from huggingface_hub import hf_hub_download
    import boto3
    import tempfile

    import tune_producer_rl

    s3_client = boto3.client("s3", region_name=args.region)
    column_map = _parse_column_map(getattr(args, "column_map", None))
    take_limit = getattr(args, "take", None)
    # Channel-pure subprefix: parquet lands here, the _dataset.json sidecar does NOT.
    data_prefix = f"{s3_prefix}/data"

    total = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        for data_file in data_files:
            local_path = hf_hub_download(
                repo_id=dataset_id, filename=data_file, repo_type="dataset",
                token=hf_token, local_dir=tmpdir,
            )

            remaining = None if take_limit is None else max(0, take_limit - total)
            if remaining == 0:
                break

            base = os.path.splitext(os.path.basename(data_file))[0]
            out_path = os.path.join(tmpdir, f"{base}.verl.parquet")
            written = tune_producer_rl.produce_verl_parquet(
                _iter_source_records(local_path),
                technique=technique, out_path=out_path,
                column_map=column_map, take=remaining,
            )
            # Post-write conformance assert (Requirement 4.5).
            tune_producer_rl.assert_parquet_conforms(out_path, technique=technique)

            s3_key = f"{data_prefix}/{base}.parquet"
            s3_client.upload_file(out_path, args.output_bucket, s3_key)
            total += written

    if total == 0:
        _error_exit(
            f"Produced 0 verl rows for {dataset_id} (technique {technique}). "
            "The source dataset yielded no usable records."
        )

    print(
        f"\u2705 Produced {total} verl 5-field parquet rows for {technique} "
        f"\u2192 s3://{args.output_bucket}/{data_prefix}/ (message-list prompt, "
        "nested reward_model). The _dataset.json sidecar stays OUTSIDE this channel.",
        file=sys.stderr,
    )
    # The training channel is the clean `data/` subprefix (prefix form, trailing slash).
    s3_uri = f"s3://{args.output_bucket}/{data_prefix}/"
    return s3_uri, total


def _normalize_json_array_to_jsonl(local_path, data_file, json_mod):
    """BL179: normalize a single-JSON-ARRAY (or wrapped) ``.json`` file to JSONL.

    Some HF datasets ship a ``.json`` that is one JSON document — a top-level
    array ``[ {...}, {...} ]`` or a ``{"data"|"rows"|"examples"|"train": [...]}``
    wrapper — rather than line-delimited JSONL. The JSONL staging path reads
    line-by-line (``json.loads`` per line) and dies on a leading ``[`` with
    "Expecting value: line 1 column 2 (char 1)". This detects that shape and
    rewrites the file to JSONL (one object per line), returning the (possibly
    new) ``(local_path, data_file)`` to continue with.

    A genuine JSONL file (first non-space char ``{`` followed by newline-delimited
    objects) is left UNTOUCHED — we only rewrite when the whole file parses as a
    single JSON value that yields a list of records. Non-``.json`` files
    (``.jsonl``/``.ndjson``) are left untouched. Best-effort: if the file is not
    valid single-document JSON (i.e. it really is JSONL), we return it unchanged
    and let the existing per-line path handle it.
    """
    # Only consider .json (NOT .jsonl / .ndjson — those are line-delimited by name).
    base = os.path.basename(local_path)
    if base.endswith(".jsonl") or base.endswith(".ndjson"):
        return local_path, data_file

    # Peek the first non-whitespace byte; a JSONL file starts with '{' then a
    # newline-delimited stream, so a single-doc rewrite only applies when the file
    # parses as ONE json value. Try a full json.load; on failure assume real JSONL.
    try:
        with open(local_path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read(64).lstrip()
            if not head or head[0] not in "[{":
                return local_path, data_file
        with open(local_path, "r", encoding="utf-8", errors="replace") as f:
            doc = json_mod.load(f)
    except (ValueError, OSError):
        # Not a single JSON document → it is (or is treated as) JSONL. Leave it.
        return local_path, data_file

    # Extract the record list: a bare array, or a common wrapper key.
    if isinstance(doc, list):
        records = doc
    elif isinstance(doc, dict):
        records = None
        for key in ("data", "rows", "examples", "train", "instances"):
            if isinstance(doc.get(key), list):
                records = doc[key]
                break
        if records is None:
            # A single object that is itself one record → wrap as a 1-row dataset.
            records = [doc]
    else:
        # A scalar top-level JSON value is not a dataset — leave it for the
        # downstream validator to reject with its own message.
        return local_path, data_file

    jsonl_path = os.path.splitext(local_path)[0] + ".from_array.jsonl"
    with open(jsonl_path, "w", encoding="utf-8") as out_f:
        for rec in records:
            out_f.write(json_mod.dumps(rec, ensure_ascii=False) + "\n")
    print(f"\u2139\ufe0f  Converted single-JSON-array file '{os.path.basename(data_file)}' "
          f"({len(records)} records) to JSONL for staging (BL179).", file=sys.stderr)
    new_data_file = os.path.splitext(data_file)[0] + ".from_array.jsonl"
    return jsonl_path, new_data_file


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
        # The actual S3 key of the LAST file uploaded. The returned s3_uri MUST be
        # derived from this — not re-computed from the original repo filename — so a
        # file whose name changed during staging (BL179 `.json` → `.from_array.jsonl`
        # normalization, or `.parquet` → `.jsonl` conversion) is registered at the key
        # that actually exists. Deriving the URI from `data_files[0]` instead recorded
        # a non-existent `.json`/`.parquet` key, which later 404'd the native AI
        # Registry create (and the content-hash step), so the dataset never appeared
        # in Studio Assets though the S3 sidecar made it look registered.
        uploaded_s3_key = None

        # ── BL129: managed-RL (verl) Producer branch ────────────────────────────
        # For rlvr/rlaif the managed trainer runs verl's RLHFDataset, which reads the
        # train channel as PARQUET in the 5-field row schema (prompt as a message
        # LIST, nested reward_model struct) — the OPPOSITE of the jsonl + flatten
        # path below. Produce verl parquet into a channel-pure `data/` subprefix (so
        # the _dataset.json sidecar co-located at the dataset prefix is NOT in the
        # training channel — ODP-2) and return that subprefix as the dataset s3_uri.
        import tune_producer_rl
        if tune_producer_rl.is_managed_rl_verl(technique):
            rl_s3_uri, rl_num_records = _stage_rl_verl(
                args, dataset_id, org, name, split, data_files, hf_token,
                s3_prefix, technique,
            )
            _output({"s3_uri": rl_s3_uri, "num_records": rl_num_records})
            return

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
                        uploaded_s3_key = s3_key

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

                    # BL179: some HF datasets ship a `.json` file that is a SINGLE
                    # JSON ARRAY (e.g. [ {...}, {...} ]) or a {"data": [...]} wrapper,
                    # NOT line-delimited JSONL. The code below reads the file
                    # LINE-BY-LINE (json.loads per line), which fails on a leading
                    # "[" with 'Expecting value: line 1 column 2 (char 1)'. Normalize
                    # such a file to JSONL in place so the rest of this branch
                    # (validate/map/flatten/take/count/upload) works unchanged. A real
                    # JSONL file is left untouched.
                    local_path, data_file = _normalize_json_array_to_jsonl(
                        local_path, data_file, json_mod)

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
                    uploaded_s3_key = s3_key

        # Derive the returned URI from the key actually uploaded (handles any
        # name change during staging). Fall back to the original-filename logic
        # only if, somehow, nothing was uploaded.
        if uploaded_s3_key:
            s3_uri = f"s3://{args.output_bucket}/{uploaded_s3_key}"
        else:
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

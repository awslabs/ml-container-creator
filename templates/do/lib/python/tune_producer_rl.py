from __future__ import annotations
"""Managed-RL dataset Producer (BL129).

Purpose: transform a source dataset into verl's 5-field RLHFDataset PARQUET for the
         managed RL techniques (rlvr/rlaif), so do/tune does not fail deep in a GPU
         job on a format/schema mismatch. This is the PRODUCER half of the managed-RL
         dataset contract (the Gate's field-schema half is in do/tune + tune_manifest).

The verl 5-field row schema (what verl's RLHFDataset reads from each parquet row):
    data_source   : str
    prompt        : list[{role, content}]   (a chat message list — NOT a flat string)
    ability       : str
    reward_model  : {style: "rule"|"model", ground_truth: <any>}
    extra_info    : {}                       (struct; free-form)

Contract source: templates/code/tune.d/<technique>/manifest.json dataset_contract,
read via tune_manifest. reward_model.style is DERIVED from the technique's contract
(rlvr -> "rule", rlaif -> "model"), never hardcoded here.

Channel/sidecar separation (ODP-2): the producer writes parquet under a channel-pure
`<prefix>/data/` subprefix (no _dataset.json there) so the SageMaker training channel
excludes the sidecar by construction. The caller records that subprefix as the dataset
s3_uri.

Callers: tune_stage_hf.cmd_stage_hf (the rlvr/rlaif branch).
"""

import os

import tune_manifest
from common import _error_exit


# verl 5-field row keys, in canonical order.
VERL_FIELDS = ["data_source", "prompt", "ability", "reward_model", "extra_info"]

# Source-column aliases we know how to lift into the verl schema. Kept small and
# explicit — a Producer transform, not a free-form column-map (a flat column-map
# cannot build the nested reward_model struct, which is the whole point).
_GROUND_TRUTH_ALIASES = ("ground_truth", "answer", "solution", "label", "target")
# `messages`/`conversations` (a chat message LIST) come FIRST: the common RLVR/RLAIF
# source shape (e.g. allenai/RLVR-MATH) puts the problem there, already in verl's
# [{role,content}, ...] form. Omitting them meant _normalize_prompt(None) produced an
# EMPTY prompt for every row — training on blank problems. _normalize_prompt passes a
# list through unchanged, so a recognized `messages` column lands correctly.
_PROMPT_ALIASES = ("messages", "conversations", "prompt", "question",
                   "instruction", "input", "query")
_DATA_SOURCE_ALIASES = ("data_source", "dataset", "source")
_ABILITY_ALIASES = ("ability", "task", "category", "domain")


def is_managed_rl_verl(technique: str) -> bool:
    """True when the technique's dataset contract is the verl-5field parquet schema.

    Reads the descriptor (tune.d/<technique>/manifest.json). Returns False for any
    technique whose contract is not verl-5field (sft/dpo = jsonl; mtrl = mtrl-rollout),
    or when the descriptor is unreadable — so the caller falls back to the jsonl path.
    """
    try:
        return tune_manifest.dataset_contract(technique).get("schema") == "verl-5field"
    except tune_manifest.ManifestError:
        return False


def _first_present(record: dict, keys) -> object:
    for k in keys:
        if k in record and record[k] not in (None, ""):
            return record[k]
    return None


def _normalize_prompt(value) -> list:
    """Coerce a prompt value into verl's chat message-LIST shape (NOT flattened).

    - already a message list [{role,content}, ...]  -> used as-is
    - a single {role, content} dict                 -> wrapped in a one-element list
    - a plain string                                -> [{"role": "user", "content": s}]
    """
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and "role" in value and "content" in value:
        return [value]
    if isinstance(value, str):
        return [{"role": "user", "content": value}]
    # Unknown shape — stringify into a single user turn rather than guess structure.
    return [{"role": "user", "content": "" if value is None else str(value)}]


def to_verl_row(record: dict, *, technique: str, style: str,
                column_map: dict | None = None, index: int = 0) -> dict:
    """Transform ONE source record into a verl 5-field row.

    `style` is the technique's reward_model.style (rule/model), passed in by the
    caller (derived from the descriptor). `column_map` is the user's optional
    source->target rename, applied before alias detection. `index` is the row's
    position, stamped into extra_info (verl-idiomatic, and keeps the extra_info
    struct non-empty so parquet can serialize it). A record that already carries a
    well-formed nested reward_model is preserved; otherwise a flat ground-truth
    column is LIFTED into the nested struct (the transform a bare --column-map cannot
    do).
    """
    rec = dict(record)
    if column_map:
        for target, source in column_map.items():
            if source in rec and target not in rec:
                rec[target] = rec.pop(source)

    # prompt (message-list, never flattened)
    prompt = _normalize_prompt(_first_present(rec, _PROMPT_ALIASES))

    # reward_model struct — preserve a well-formed one, else build it from a flat
    # ground-truth column.
    existing_rm = rec.get("reward_model")
    if isinstance(existing_rm, dict) and "ground_truth" in existing_rm:
        reward_model = {
            "style": existing_rm.get("style", style),
            "ground_truth": existing_rm["ground_truth"],
        }
    else:
        ground_truth = _first_present(rec, _GROUND_TRUTH_ALIASES)
        reward_model = {"style": style, "ground_truth": ground_truth}

    data_source = _first_present(rec, _DATA_SOURCE_ALIASES) or f"{technique}-dataset"
    ability = _first_present(rec, _ABILITY_ALIASES) or "general"

    extra_info = rec.get("extra_info")
    if not isinstance(extra_info, dict):
        extra_info = {}
    # parquet cannot serialize an ALL-EMPTY struct column (pyarrow: "Cannot write
    # struct type with no child field"). verl's own preprocessing stamps an
    # `extra_info.index`; mirror that so the struct always has at least one child
    # field and the column type is inferable. Harmless + verl-idiomatic.
    extra_info.setdefault("index", index)

    return {
        "data_source": str(data_source),
        "prompt": prompt,
        "ability": str(ability),
        "reward_model": reward_model,
        "extra_info": extra_info,
    }


def assert_verl_row(row: dict, *, style: str) -> None:
    """Fail LOUD at stage time if a produced row violates the verl 5-field contract.

    This is the producer-side conformance check (the whole point of the Producer is
    to fail HERE, at registration, not deep in a GPU job).
    """
    missing = [f for f in VERL_FIELDS if f not in row]
    if missing:
        _error_exit(
            "Produced RL dataset row is missing required verl field(s): "
            f"{', '.join(missing)}. Expected the 5-field schema "
            f"({', '.join(VERL_FIELDS)})."
        )
    if not isinstance(row["prompt"], list) or not row["prompt"]:
        _error_exit(
            "Produced RL row 'prompt' must be a non-empty chat message LIST "
            "([{role, content}, ...]) for verl's RLHFDataset — got "
            f"{type(row['prompt']).__name__}."
        )
    # Structure alone is not enough: a message list whose content is all EMPTY passes
    # the shape check but means the model trains on a BLANK problem (observed: a source
    # whose prompt lived in a column not in _PROMPT_ALIASES produced 7500 empty-content
    # rows that still "conformed"). Fail LOUD here so a mis-detected prompt column is
    # caught at stage time, not after a GPU run on garbage. The remedy is explicit and
    # dataset-agnostic: map the real column with --column-map.
    if not any(
        isinstance(m, dict) and str(m.get("content") or "").strip()
        for m in row["prompt"]
    ):
        _error_exit(
            "Produced RL row 'prompt' has NO message content — every message is empty. "
            "The source record's prompt text was not found under any known column "
            f"({', '.join(_PROMPT_ALIASES)}). Map the real prompt column explicitly, "
            "e.g.  --column-map prompt=<your_prompt_column>  (the training problem text "
            "must be present, or the model trains on blank prompts)."
        )
    rm = row["reward_model"]
    if not isinstance(rm, dict) or "style" not in rm or "ground_truth" not in rm:
        _error_exit(
            "Produced RL row 'reward_model' must be a struct {style, ground_truth} — "
            f"got {rm!r}. The register-side transform lifts a flat ground-truth column "
            "into this nested struct; check the source dataset has a ground-truth column "
            f"(one of: {', '.join(_GROUND_TRUTH_ALIASES)})."
        )
    if rm["style"] != style:
        _error_exit(
            f"Produced RL row reward_model.style '{rm['style']}' does not match the "
            f"technique's contract style '{style}'."
        )


def produce_verl_parquet(records, *, technique: str, out_path: str,
                         column_map: dict | None = None, take: int | None = None) -> int:
    """Transform an iterable of source records into a verl 5-field PARQUET file at
    `out_path`. Returns the number of rows written. Fails loud (via assert_verl_row)
    on the FIRST non-conforming produced row. reward_model.style is read from the
    technique's descriptor contract — not hardcoded.
    """
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        _error_exit(
            "Managed-RL dataset production requires pyarrow (verl parquet output). "
            "Please install: pip install pyarrow"
        )

    style = tune_manifest.reward_model_style(technique)
    if style not in ("rule", "model"):
        _error_exit(
            f"Technique '{technique}' has no verl reward_model_style in its descriptor "
            "(expected 'rule' or 'model'). The dataset contract is misconfigured."
        )

    rows = []
    for record in records:
        if take is not None and len(rows) >= take:
            break
        row = to_verl_row(record, technique=technique, style=style,
                          column_map=column_map, index=len(rows))
        assert_verl_row(row, style=style)
        rows.append(row)

    if not rows:
        _error_exit("No records produced for the RL dataset — the source yielded 0 rows.")

    table = pa.Table.from_pylist(rows)
    pq.write_table(table, out_path)
    return len(rows)


def assert_parquet_conforms(path: str, *, technique: str) -> None:
    """Re-read the first row of a written parquet file and assert it satisfies the
    technique's dataset contract. The post-write guard (Requirement 4.5): catch a
    serialization defect at stage time, not in the GPU job.
    """
    try:
        import pyarrow.parquet as pq
    except ImportError:
        return  # produce_verl_parquet already errored if pyarrow was missing
    style = tune_manifest.reward_model_style(technique)
    table = pq.read_table(path)
    if table.num_rows == 0:
        _error_exit(f"Produced RL parquet {os.path.basename(path)} has 0 rows.")
    first = table.slice(0, 1).to_pylist()[0]
    assert_verl_row(first, style=style)

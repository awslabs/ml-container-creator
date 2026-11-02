#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Tune-descriptor manifest reader (BL129).

Purpose: Single source of truth for reading tune.d/<technique>/manifest.json at
         RUNTIME. The do/tune dataset preflight (the Gate's field-schema half)
         reads a technique's dataset_contract — its format, row schema, the
         required verl fields, and reward_model_style — from the descriptor
         instead of a hardcoded per-technique table (ADR-008: derive, don't
         hardcode). The register-side producer reads the same contract so the
         two cannot disagree.

Callers:
  - do/tune (bash)              — the RL field-schema preflight (required fields)
  - tune_stage_hf.py (import)   — the producer's contract (reward_model_style,
                                   prompt_shape) [BL129 producer tasks]

The manifest is resolved relative to the tune.d root, preferring the
project-local .mlcc copy when present and falling back to the MLCC source tree —
the same catalog-resolution pattern serve_manifest.py uses.

CLI (one-shot, for bash callers):
    python3 do/lib/python/tune_manifest.py <op> <technique> [variant]

  <op> is one of:
    dataset_contract        — prints the dataset_contract JSON object
    required_dataset_fields — prints a JSON array of the row fields the dataset
                              MUST carry for this technique's schema (the Gate's
                              field-schema check). Empty [] when the schema has
                              no verified field contract (e.g. mtrl-rollout).
    reward_model_style      — prints the style ("rule"/"model") or empty
    prompt_shape            — prints "message-list"/"string"
    dataset_format          — prints "parquet"/"jsonl"
    is_verified             — prints "true"/"false" (dataset_contract.verified)
    artifact_kind           — prints "lora_adapter"/"full_model" (or empty when absent)

  [variant] is optional ('lora'|'full'); omit for the default variant
  (prefers 'lora', else the sole declared variant).

  Exit codes: 0 on success; 2 on usage error; 3 on missing manifest; 4 on
  malformed manifest. Errors print to stderr.
"""

from __future__ import annotations

import json
import os
import sys


class ManifestError(Exception):
    """Base class for manifest resolution errors."""


class ManifestNotFound(ManifestError):
    """The technique's manifest directory or file is missing."""


class ManifestMalformed(ManifestError):
    """The manifest file does not parse as JSON."""


# The row fields the managed trainer requires per dataset row schema. verl's
# RLHFDataset reads these from each parquet row (see the verl reward manager:
# reward_model.ground_truth + data_source are mandatory). Keyed by the
# dataset_contract `schema` value, NOT the technique, so rlvr/rlaif (both
# verl-5field) share one contract and a new verl technique inherits it. A schema
# with no verified field contract (mtrl-rollout) maps to [] — the Gate then only
# format-checks it, never field-checks it.
_REQUIRED_FIELDS_BY_SCHEMA = {
    "verl-5field": ["data_source", "prompt", "ability", "reward_model", "extra_info"],
    "sft-prompt-completion": ["prompt", "completion"],
    "dpo-preference": ["prompt", "chosen", "rejected"],
    "mtrl-rollout": [],
}


def _candidate_tune_dirs(tune_dir: str | None = None) -> list[str]:
    """Return candidate tune.d roots in resolution order.

    Precedence:
      1. Explicit tune_dir argument (if provided).
      2. Project-local .mlcc/tune.d copy (generated projects).
      3. MLCC source tree templates/code/tune.d (running from the repo).
      4. repo/cwd fallbacks.
    """
    candidates: list[str] = []
    if tune_dir:
        candidates.append(tune_dir)

    here = os.path.dirname(os.path.abspath(__file__))

    # Generated project: do/ scripts live at <project>/do/lib/python/; the .mlcc
    # copy sits at <project>/.mlcc/tune.d/.
    #   here -> <project>/do/lib/python ; ../../.. -> <project>
    project_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    candidates.append(os.path.join(project_root, ".mlcc", "tune.d"))

    # MLCC source tree: helper at templates/do/lib/python/; tune.d at
    # templates/code/tune.d.
    #   here -> templates/do/lib/python ; ../../.. -> templates
    templates_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    candidates.append(os.path.join(templates_root, "code", "tune.d"))

    # repo/cwd layouts.
    candidates.append(os.path.join(os.getcwd(), "templates", "code", "tune.d"))
    candidates.append(os.path.join(os.getcwd(), ".mlcc", "tune.d"))

    seen: set[str] = set()
    ordered: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


def read_manifest(technique: str, tune_dir: str | None = None) -> dict:
    """Load and return tune.d/<technique>/manifest.json as a dict.

    Raises:
        ManifestNotFound: if no candidate tune.d root contains the manifest.
        ManifestMalformed: if the manifest file exists but does not parse.
    """
    if not technique:
        raise ManifestNotFound("no technique specified")

    tried: list[str] = []
    for root in _candidate_tune_dirs(tune_dir):
        path = os.path.join(root, technique, "manifest.json")
        tried.append(path)
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, ValueError) as exc:
                raise ManifestMalformed(
                    f"manifest {path} is not valid JSON: {exc}"
                ) from exc

    raise ManifestNotFound(
        f"no tune descriptor for technique '{technique}' (looked in: {', '.join(tried)})"
    )


# do/tune's `--training-type` CLI values map onto the descriptor's variant KEYS.
# The descriptor keys PEFT variants as `lora` / `full`, but the CLI (and the
# tune catalog's trainingTypes) speak `lora` / `full-rank`. Normalize the alias
# here so `--training-type full-rank` resolves the `full` variant instead of
# silently missing (variants.get("full-rank") -> None -> {} -> no hyperparameters,
# no interactive UX, and --set rejecting every knob). One map, applied for every
# consumer (HP builder, dataset_contract, reward_model_style, …).
_VARIANT_ALIASES = {"full-rank": "full", "full_rank": "full"}


def _resolve_variant(manifest: dict, variant: str | None) -> dict:
    """Return a variant object, defaulting to 'lora' then the sole declared one.

    `variant` accepts either a descriptor key (`lora`/`full`) or a do/tune
    `--training-type` alias (`full-rank` → `full`); the alias is normalized first.
    """
    variants = manifest.get("variants") or {}
    if not isinstance(variants, dict) or not variants:
        return {}
    if variant:
        key = _VARIANT_ALIASES.get(variant, variant)
        return variants.get(key) or {}
    if "lora" in variants:
        return variants["lora"]
    first_key = next(iter(variants))
    return variants[first_key]


def dataset_contract(technique: str, variant: str | None = None,
                     tune_dir: str | None = None) -> dict:
    """Return the dataset_contract for a technique+variant, or {} when absent."""
    v = _resolve_variant(read_manifest(technique, tune_dir), variant)
    dc = v.get("dataset_contract")
    return dc if isinstance(dc, dict) else {}


def read_hyperparameters(technique: str, variant: str | None = None,
                         tune_dir: str | None = None) -> dict:
    """Return the SYNCED `hyperparameters` map for a technique+variant, or {} when
    absent (e.g. a pre-sync descriptor). BL128: the config-builder reads this to render
    the technique's knobs. Mirrors `dataset_contract`'s variant resolution.
    """
    v = _resolve_variant(read_manifest(technique, tune_dir), variant)
    hp = v.get("hyperparameters")
    return hp if isinstance(hp, dict) else {}


def required_dataset_fields(technique: str, variant: str | None = None,
                            tune_dir: str | None = None) -> list[str]:
    """Return the row fields the dataset MUST carry for this technique's schema.

    Derived from the dataset_contract `schema` via _REQUIRED_FIELDS_BY_SCHEMA.
    Returns [] for a schema with no verified field contract (mtrl-rollout) so the
    Gate format-checks but never field-checks it.
    """
    schema = dataset_contract(technique, variant, tune_dir).get("schema")
    return list(_REQUIRED_FIELDS_BY_SCHEMA.get(schema, []))


def reward_model_style(technique: str, variant: str | None = None,
                       tune_dir: str | None = None) -> str | None:
    """Return the verl reward_model.style ("rule"/"model") or None when absent."""
    return dataset_contract(technique, variant, tune_dir).get("reward_model_style")


def prompt_shape(technique: str, variant: str | None = None,
                 tune_dir: str | None = None) -> str:
    """Return the prompt_shape ("message-list"/"string"); default "message-list"."""
    return dataset_contract(technique, variant, tune_dir).get("prompt_shape", "message-list")


def dataset_format(technique: str, variant: str | None = None,
                   tune_dir: str | None = None) -> str:
    """Return the dataset format ("parquet"/"jsonl"); default "jsonl"."""
    return dataset_contract(technique, variant, tune_dir).get("format", "jsonl")


def is_verified(technique: str, variant: str | None = None,
                tune_dir: str | None = None) -> bool:
    """Return the dataset_contract.verified flag (False when absent)."""
    return bool(dataset_contract(technique, variant, tune_dir).get("verified", False))


def artifact_kind(technique: str, variant: str | None = None,
                  tune_dir: str | None = None) -> str | None:
    """Return the artifact_kind for a technique+variant ("lora_adapter" |
    "full_model"), or None when absent.

    DERIVED from the variant's `peft` and schema-enforced at author time
    (manifest.schema.json). Mirrors the Node reader `artifactKind`
    (src/lib/tune-manifest-reader.js) so the two cannot diverge — BL164 records
    this on the registered model/adapter version so the additive-deploy verbs
    can gate by it (ADR-013). Variant resolution matches the other accessors
    (prefers 'lora', else the sole declared variant).
    """
    v = _resolve_variant(read_manifest(technique, tune_dir), variant)
    ak = v.get("artifact_kind")
    return ak if isinstance(ak, str) else None


def hp_eks_workload_kind(technique: str, variant: str | None = None,
                         tune_dir: str | None = None) -> str:
    """Wave 11 (R9.1): the workload kind of AWS's HP-EKS payload for this variant,
    as synced from the template (`_synced["hp-eks"].workload_kind`). Returns "" when
    AWS publishes no HP-EKS payload for the variant (no hp-eks entry, e.g. MTRL) and
    "unknown" when the entry predates the sync of the kind."""
    v = _resolve_variant(read_manifest(technique, tune_dir), variant)
    hp = (v.get("_synced") or {}).get("hp-eks")
    if not isinstance(hp, dict):
        return ""
    kind = hp.get("workload_kind")
    return kind if isinstance(kind, str) and kind else "unknown"


def _cli(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "usage: tune_manifest.py <op> <technique> [variant]\n"
            "  ops: dataset_contract | required_dataset_fields | reward_model_style |\n"
            "       prompt_shape | dataset_format | is_verified | artifact_kind |\n"
            "       hp_eks_workload_kind",
            file=sys.stderr,
        )
        return 2

    op = argv[0]
    technique = argv[1]
    variant = argv[2] if len(argv) >= 3 else None

    try:
        if op == "dataset_contract":
            print(json.dumps(dataset_contract(technique, variant)))
        elif op == "required_dataset_fields":
            print(json.dumps(required_dataset_fields(technique, variant)))
        elif op == "reward_model_style":
            print(reward_model_style(technique, variant) or "")
        elif op == "prompt_shape":
            print(prompt_shape(technique, variant))
        elif op == "dataset_format":
            print(dataset_format(technique, variant))
        elif op == "is_verified":
            print("true" if is_verified(technique, variant) else "false")
        elif op == "artifact_kind":
            print(artifact_kind(technique, variant) or "")
        elif op == "hp_eks_workload_kind":
            print(hp_eks_workload_kind(technique, variant))
        else:
            print(f"unknown op: {op}", file=sys.stderr)
            return 2
    except ManifestNotFound as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 3
    except ManifestMalformed as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))

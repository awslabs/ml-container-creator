# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Deploy answer-key reader (single source of truth).

The project-runtime Python counterpart of src/lib/deploy-answers-reader.js. Both
read the same per-target ``answer_params`` arrays in
targets.d/<target>/manifest.json, so the deploy answer-key contract
(CLI flag -> answer key -> config var) has ONE source of truth instead of the
four hand-maintained tables it used to live in: CLI_FLAG_TO_VARS
(deploy-config-builder.js), flag_to_answer_key (.deploy_helper.py),
_ANSWER_KEY_TO_VAR (deploy_prompts.py), and the inline KEY_MAP (do/deploy).

This reuses target_manifest.py for descriptor discovery/loading so the targets.d
resolution rules stay identical.

The role model (per answer_params entry ``roles``):
    flag-input     has a CLI flag; feeds the builder/helper flag tables, the
                   do/deploy arg-parse arms and both forwarding blocks.
    prompt-core    the core target/instance_type params handled specially by the
                   builder but still answer keys on the Python side.
    internal       no flag; produced by prompts/builder; part of the input surface.
    builder-output emitted only in the Node builder's JSON output (KEY_MAP); no
                   flag, no prompt input.
    input-only     a flag/prompt/internal param the builder does NOT re-emit, so
                   it is excluded from the output KEY_MAP (endpoint_name,
                   hp_instance_group_name).

Surfaces:
    input  (_ANSWER_KEY_TO_VAR) = flag-input u prompt-core u internal
                                  (every param that is not a pure builder-output key)
    output (do/deploy KEY_MAP)  = every param EXCEPT those tagged input-only

CLI (one-shot, for bash callers):
    python3 do/lib/python/deploy_answers.py <projection>

  <projection> is one of:
    answer-key-to-var-input   prints JSON {answerKey: CONFIG_VAR} (input surface)
    answer-key-to-var-output  prints JSON {answerKey: CONFIG_VAR} (KEY_MAP surface)
    flag-to-answer-key        prints JSON {answerKey: answerKey} (helper table)
    flag-to-vars              prints JSON {"--flag": {"configVar":..,"answerKey":..}}
    flag-params               prints JSON [{flag,answerKey,configVar,shellVar}, ...]

  Exit codes: 0 success; 2 usage; 4 malformed/conflicting descriptors.
"""

from __future__ import annotations

import json
import os
import sys

# Import the target descriptor reader that lives beside this module.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import target_manifest  # noqa: E402


class AnswerParamsConflict(Exception):
    """Two targets declare the same answerKey with divergent configVar/flag."""


def all_answer_params(targets_dir: str | None = None) -> list[dict]:
    """Every answer_params entry across all targets, in a stable order.

    Target order is target_manifest.list_targets() (canonical-name sorted), then
    declaration order within each target. Each entry is augmented with 'target'.
    """
    out: list[dict] = []
    for name in target_manifest.list_targets(targets_dir):
        manifest = target_manifest.read_manifest(name, targets_dir)
        for p in manifest.get("answer_params", []):
            entry = dict(p)
            entry["target"] = name
            out.append(entry)
    return out


def answer_params_by_key(targets_dir: str | None = None) -> dict[str, dict]:
    """Dedupe params by answerKey, asserting cross-target consistency.

    Two targets may declare the same answerKey (Option B) but MUST agree on
    configVar and flag. Roles are unioned. Raises AnswerParamsConflict otherwise.
    """
    result: dict[str, dict] = {}
    for p in all_answer_params(targets_dir):
        key = p["answerKey"]
        existing = result.get(key)
        if existing is None:
            result[key] = {
                "answerKey": key,
                "configVar": p["configVar"],
                "flag": p.get("flag"),
                "roles": list(p["roles"]),
            }
            continue
        if existing["configVar"] != p["configVar"]:
            raise AnswerParamsConflict(
                f"answerKey '{key}' maps to '{existing['configVar']}' and "
                f"'{p['configVar']}' in different targets"
            )
        if (existing.get("flag") or "") != (p.get("flag") or ""):
            raise AnswerParamsConflict(
                f"answerKey '{key}' has flag '{existing.get('flag') or ''}' and "
                f"'{p.get('flag') or ''}' in different targets"
            )
        for r in p["roles"]:
            if r not in existing["roles"]:
                existing["roles"].append(r)
    return result


def _has_role(p: dict, role: str) -> bool:
    return role in p["roles"]


def _is_pure_builder_output(p: dict) -> bool:
    return (
        _has_role(p, "builder-output")
        and not _has_role(p, "flag-input")
        and not _has_role(p, "prompt-core")
        and not _has_role(p, "internal")
    )


def answer_key_to_var(surface: str, targets_dir: str | None = None) -> dict[str, str]:
    """answerKey -> configVar for the 'input' or 'output' surface (see module doc)."""
    if surface not in ("input", "output"):
        raise ValueError(f"surface must be 'input' or 'output', got {surface!r}")
    out: dict[str, str] = {}
    for p in answer_params_by_key(targets_dir).values():
        if surface == "input":
            include = not _is_pure_builder_output(p)
        else:
            include = not _has_role(p, "input-only")
        if include:
            out[p["answerKey"]] = p["configVar"]
    return out


def flag_to_answer_key(targets_dir: str | None = None) -> dict[str, str]:
    """Every param with a flag, keyed by its answerKey. Identity map."""
    out: dict[str, str] = {}
    for p in answer_params_by_key(targets_dir).values():
        if p.get("flag"):
            out[p["answerKey"]] = p["answerKey"]
    return out


def flag_to_vars(targets_dir: str | None = None) -> dict[str, dict]:
    """Builder CLI_FLAG_TO_VARS: per-target flags only (flag-input, not prompt-core)."""
    out: dict[str, dict] = {}
    for p in answer_params_by_key(targets_dir).values():
        if _has_role(p, "flag-input") and not _has_role(p, "prompt-core") and p.get("flag"):
            out[p["flag"]] = {"configVar": p["configVar"], "answerKey": p["answerKey"]}
    return out


def flag_to_shell_var(flag: str) -> str:
    """--async-max-concurrent -> FLAG_ASYNC_MAX_CONCURRENT."""
    return f"FLAG_{flag.lstrip('-').replace('-', '_').upper()}"


def flag_params(targets_dir: str | None = None) -> list[dict]:
    """Ordered per-target flag params for codegen (excludes core --target/--instance-type)."""
    seen: set[str] = set()
    out: list[dict] = []
    for p in all_answer_params(targets_dir):
        flag = p.get("flag")
        if not flag or _has_role(p, "prompt-core") or flag in seen:
            continue
        seen.add(flag)
        out.append(
            {
                "flag": flag,
                "answerKey": p["answerKey"],
                "configVar": p["configVar"],
                "shellVar": flag_to_shell_var(flag),
            }
        )
    return out


# ── CLI one-shot for bash callers ──────────────────────────────────────────────


def _cli(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: deploy_answers.py <projection>", file=sys.stderr)
        return 2
    projection = argv[0]
    try:
        if projection == "answer-key-to-var-input":
            print(json.dumps(answer_key_to_var("input")))
        elif projection == "answer-key-to-var-output":
            print(json.dumps(answer_key_to_var("output")))
        elif projection == "flag-to-answer-key":
            print(json.dumps(flag_to_answer_key()))
        elif projection == "flag-to-vars":
            print(json.dumps(flag_to_vars()))
        elif projection == "flag-params":
            print(json.dumps(flag_params()))
        else:
            print(f"Error: unknown projection '{projection}'", file=sys.stderr)
            return 2
    except (target_manifest.ManifestError, AnswerParamsConflict) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))

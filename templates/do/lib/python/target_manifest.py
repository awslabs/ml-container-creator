# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Deployment-target descriptor reader (ADR-008, Wave 8).

Purpose: single source of truth for reading targets.d/<target>/manifest.json.
         The scattered per-target authorities (do/config status block,
         _guard_deployment_active, the deploy/clean dispatchers, deploy_schema.py,
         do-config.js SHELL_VAR_TO_ANSWER, regenerate RUNTIME_OWNED_VARS) derive
         from these descriptors instead of hardcoding per-target knowledge.

This is the deploy-side analogue of serve_manifest.py: a runtime reader with a
one-shot CLI so bash scripts can read a target field without embedding a
`case "$DEPLOYMENT_TARGET"` block. The Node counterpart is
src/lib/target-manifest-reader.js; both read the same descriptors so a target's
contract has one source of truth.

CLI (one-shot, for bash callers):
    python3 do/lib/python/target_manifest.py <field> <target>

  <field> is one of:
    status_var        — prints the DEPLOYMENT_TARGET_<T>_STATUS var name
    success_status    — prints InService|Running|Completed
    answer_key        — prints the camelCase generator-answer key
    family            — prints sagemaker-endpoint|sagemaker-job|kubernetes
    deploy_script     — prints deploy.d/<target>
    clean_script      — prints clean.d/<target>
    serving_config_source — prints kubernetes|sagemaker-ic
    aliases | required_vars | runtime_owned_vars — prints a JSON array
    compute_backends  — prints the JSON array of training backends (first = default;
                        ["smtj"] when the descriptor predates the field)
    optional_vars | verbs — prints a JSON object
    adapter_delivery  — prints the JSON object (or {} when the target declares none)
    cluster_contract  — prints the JSON object (or {} when the target declares none)
    pricing           — prints the JSON pricing object (Wave 9 price resolver)
    observability     — prints the JSON object (Wave 9: store, selector, dashboard ...)
    service_quota_usage — prints the Service Quotas usage suffix (or "")
    scale_to_zero     — prints the JSON object (Wave 10: support, mechanism, enabled ...)
    resolve           — resolves an alias to its canonical target name

  <target> accepts a canonical name OR an alias (resolved via `aliases`).

  Exit codes: 0 success; 2 usage; 3 unknown target; 4 malformed manifest;
  6 unknown field. Errors print to stderr.
"""

from __future__ import annotations

import json
import os
import sys


class ManifestError(Exception):
    """Base class for descriptor resolution errors."""


class ManifestNotFound(ManifestError):
    """No descriptor found for the requested target."""


class ManifestMalformed(ManifestError):
    """A descriptor file does not parse as JSON."""


def _candidate_targets_dirs(targets_dir: str | None = None) -> list[str]:
    """Return candidate targets.d roots in resolution order.

    Precedence:
      1. Explicit targets_dir argument (if provided).
      2. The do/targets.d sibling of this helper (generated project OR source
         tree — targets.d lives under do/ in both).
      3. Project-local .mlcc/targets.d copy, if present.
      4. cwd layouts (repo / project).
    """
    candidates: list[str] = []
    if targets_dir:
        candidates.append(targets_dir)

    here = os.path.dirname(os.path.abspath(__file__))
    # here -> <do>/lib/python ; ../.. -> <do> ; <do>/targets.d
    do_root = os.path.abspath(os.path.join(here, "..", ".."))
    candidates.append(os.path.join(do_root, "targets.d"))

    # here -> <do>/lib/python ; ../../.. -> <project or templates>
    project_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    candidates.append(os.path.join(project_root, ".mlcc", "targets.d"))

    candidates.append(os.path.join(os.getcwd(), "templates", "do", "targets.d"))
    candidates.append(os.path.join(os.getcwd(), "do", "targets.d"))

    seen: set[str] = set()
    ordered: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


def _resolve_root(targets_dir: str | None = None) -> str:
    """Return the first candidate targets.d root that exists."""
    for root in _candidate_targets_dirs(targets_dir):
        if os.path.isdir(root):
            return root
    raise ManifestNotFound(
        "no targets.d directory found (looked in: "
        + ", ".join(_candidate_targets_dirs(targets_dir))
        + ")"
    )


def list_targets(targets_dir: str | None = None) -> list[str]:
    """Return the canonical target names (descriptor directory names), sorted."""
    root = _resolve_root(targets_dir)
    names = [
        d
        for d in os.listdir(root)
        if os.path.isfile(os.path.join(root, d, "manifest.json"))
    ]
    return sorted(names)


def _alias_index(targets_dir: str | None = None) -> dict[str, str]:
    """Map every alias (and canonical name) to its canonical target name."""
    index: dict[str, str] = {}
    for name in list_targets(targets_dir):
        index[name] = name
        for alias in read_manifest(name, targets_dir).get("aliases", []):
            index[alias] = name
    return index


def resolve_target(target: str, targets_dir: str | None = None) -> str:
    """Resolve an alias (or canonical name) to the canonical target name."""
    return _alias_index(targets_dir).get(target, target)


def read_manifest(target: str, targets_dir: str | None = None) -> dict:
    """Load and return targets.d/<target>/manifest.json as a dict.

    Accepts a canonical name or an alias. Raises ManifestNotFound if no
    descriptor matches, ManifestMalformed if the file does not parse.
    """
    if not target:
        raise ManifestNotFound("no target specified")

    root = _resolve_root(targets_dir)

    # Try the name directly, then via alias resolution.
    direct = os.path.join(root, target, "manifest.json")
    path = direct
    if not os.path.isfile(path):
        # Resolve alias without recursing through read_manifest on the same name.
        for name in list_targets(targets_dir):
            candidate = os.path.join(root, name, "manifest.json")
            try:
                with open(candidate, encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, ValueError) as exc:
                raise ManifestMalformed(
                    f"descriptor {candidate} is not valid JSON: {exc}"
                ) from exc
            if target in data.get("aliases", []):
                return data
        raise ManifestNotFound(
            f"no descriptor for target '{target}' (root: {root})"
        )

    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ManifestMalformed(
            f"descriptor {path} is not valid JSON: {exc}"
        ) from exc


# ── Typed accessors ────────────────────────────────────────────────────────────


def status_var(target: str, targets_dir: str | None = None) -> str:
    """Return the target's DEPLOYMENT_TARGET_<T>_STATUS var name."""
    return read_manifest(target, targets_dir)["status_var"]


def success_status(target: str, targets_dir: str | None = None) -> str:
    """Return the target's active status value (InService|Running|Completed)."""
    return read_manifest(target, targets_dir)["success_status"]


def answer_key(target: str, targets_dir: str | None = None) -> str:
    """Return the target's camelCase generator-answer key for its status var."""
    return read_manifest(target, targets_dir)["answer_key"]


def runtime_owned_vars(target: str, targets_dir: str | None = None) -> list[str]:
    """Return the vars this target writes at runtime that regenerate preserves."""
    return list(read_manifest(target, targets_dir).get("runtime_owned_vars", []))


def adapter_delivery(target: str, targets_dir: str | None = None) -> dict:
    """Return the target's adapter_delivery declaration (Wave 6.1 R1.1), or {}
    when the target loads adapters another way (e.g. SMAI adapter ICs)."""
    return dict(read_manifest(target, targets_dir).get("adapter_delivery") or {})


def cluster_contract(target: str, targets_dir: str | None = None) -> dict:
    """Return the target's read-only cluster-contract preflight declaration
    (Wave 8 R5.3: {script, entry}), or {} when the target has none."""
    return dict(read_manifest(target, targets_dir).get("cluster_contract") or {})
def compute_backends(target: str, targets_dir: str | None = None) -> list[str]:
    """Return the target's training compute backends (Wave 11 R1.1), in
    preference order; the first entry is the default. A descriptor that predates
    the field reads as ["smtj"] (every target can submit an SMTJ)."""
    backends = read_manifest(target, targets_dir).get("compute_backends") or ["smtj"]
    return [str(b) for b in backends]
def pricing(target: str, targets_dir: str | None = None) -> dict:
    """Return the target's pricing declaration (Wave 9 R7.1/R8.2:
    {service, component?, instance_count: {basis, ...}}), or {} when absent.
    The price resolver (pricing.py) derives the Price List service/component
    and the billed instance count from this block instead of a target branch."""
    return dict(read_manifest(target, targets_dir).get("pricing") or {})


def observability(target: str, targets_dir: str | None = None) -> dict:
    """Return the target's observability declaration (Wave 9 R1/R6/R12):
    {store, histogram_form, selector, gpu_selector, fallback, dashboard,
    amp_discovery, copy_concurrency}. A target without the block reads as
    {"store": "none"} so callers degrade to "no store" instead of erroring."""
    obs = dict(read_manifest(target, targets_dir).get("observability") or {})
    obs.setdefault("store", "none")
    return obs


def scale_to_zero(target: str, targets_dir: str | None = None) -> dict:
    """Return the target's scale_to_zero declaration (Wave 10, ADR-014 R1):
    {support, mechanism, wake_signal, requests_at_zero, idle_billing, enabled,
    reason}. A target without the block reads as not-applicable and disabled,
    so callers refuse instead of erroring (the schema requires the block)."""
    block = dict(read_manifest(target, targets_dir).get("scale_to_zero") or {})
    if not block:
        block = {
            "support": "not-applicable",
            "mechanism": None,
            "wake_signal": None,
            "requests_at_zero": "n/a",
            "idle_billing": "n/a",
            "enabled": False,
            "reason": "this target declares no scale_to_zero capability",
        }
    return block


def service_quota_usage(target: str, targets_dir: str | None = None) -> str:
    """Return the SageMaker Service Quotas usage suffix for the target's
    instances (e.g. 'endpoint usage'), or '' when capacity is cluster-provided."""
    return str(read_manifest(target, targets_dir).get("service_quota_usage") or "")
# ── CLI one-shot for bash callers ──────────────────────────────────────────────

_ARRAY_FIELDS = {"aliases", "required_vars", "runtime_owned_vars"}
_OBJECT_FIELDS = {"optional_vars", "verbs", "adapter_delivery", "cluster_contract", "pricing", "observability"}
# Fields whose accessor applies a default, so the CLI prints the accessor value.
_ACCESSOR_FIELDS = {"scale_to_zero": scale_to_zero}
_STRING_FIELDS = {
    "target",
    "status_var",
    "success_status",
    "answer_key",
    "family",
    "deploy_script",
    "clean_script",
    "serving_config_source",
    "service_quota_usage",
}


def _cli(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: target_manifest.py <field> <target>", file=sys.stderr)
        return 2

    field, target = argv

    # `resolve` is a special field: alias -> canonical name.
    try:
        if field == "resolve":
            print(resolve_target(target))
            return 0
        manifest = read_manifest(target)
    except ManifestNotFound as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 3
    except ManifestMalformed as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 4

    if field in _STRING_FIELDS:
        print(manifest.get(field, ""))
        return 0
    if field in _ARRAY_FIELDS:
        print(json.dumps(manifest.get(field, [])))
        return 0
    if field == "compute_backends":
        print(json.dumps(manifest.get(field) or ["smtj"]))
        return 0
    if field in _OBJECT_FIELDS:
        print(json.dumps(manifest.get(field, {})))
        return 0
    if field in _ACCESSOR_FIELDS:
        print(json.dumps(_ACCESSOR_FIELDS[field](target)))
        return 0

    print(f"Error: unknown field '{field}'", file=sys.stderr)
    return 6


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))

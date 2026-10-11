#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Serve-layer plugin manifest reader (BL105).

Purpose: Single source of truth for reading serve.d/<engine>/manifest.json.
         Consumers (do/draft, do/deploy, .optimize_engine.py) read engine
         capabilities — supported_algorithms, env_var_prefix, dimension_map,
         metrics_endpoint — from the manifest instead of hardcoded logic.

Callers:
  - do/draft (bash, one-shot CLI)   — supported_algorithms for algorithm validation
  - do/deploy.d/hyperpod-eks (bash) — env_var_prefix for CRD environmentVariables
  - .optimize_engine.py (import)    — env_var_prefix + dimension_map for config-key derivation

The manifest is resolved relative to the serve.d root, preferring the
project-local .mlcc copy when present and falling back to the MLCC source
tree — the same catalog-resolution pattern do/draft list uses for
draft-models.json.

CLI (one-shot, for bash callers):
    python3 do/lib/python/serve_manifest.py <field> <engine>

  <field> is one of:
    supported_algorithms   — prints a JSON array
    env_var_prefix         — prints the prefix string
    algorithm_map          — prints a JSON object
    dimension_map          — prints a JSON object
    metrics_endpoint       — prints a JSON object (or exits non-zero if absent)
    engine | hot_reload    — prints the raw value
    min_version            — prints the min_version string (or empty)
    version_features       — prints a JSON array

  Capability-versioning operations (BL129) take an extra argument:
    engine_version <engine> <base_image>
        — resolve the engine version from a BASE_IMAGE (model-servers.json
          framework_version, else tag parse). Prints the version or empty.
    effective_supported_algorithms <engine> [version]
        — the supported_algorithms available at that engine version (flat list
          minus version-gated-out algorithms). Fail-open: omitted/unparseable
          version prints the full flat list.
    is_version_supported <engine> [version]
        — prints "true"/"false" for version >= min_version (fail-open: true when
          no min_version or version unknown).

  Exit codes: 0 on success; non-zero on missing/malformed manifest or
  unknown field. Errors are printed to stderr.
"""

from __future__ import annotations

import json
import os
import re
import sys


class ManifestError(Exception):
    """Base class for manifest resolution errors."""


class ManifestNotFound(ManifestError):
    """The engine's manifest directory or file is missing."""


class ManifestMalformed(ManifestError):
    """The manifest file does not parse as JSON."""


def _candidate_serve_dirs(serve_dir: str | None = None) -> list[str]:
    """Return candidate serve.d roots in resolution order.

    Precedence:
      1. Explicit serve_dir argument (if provided).
      2. Project-local .mlcc/serve.d copy (generated projects).
      3. MLCC source tree templates/code/serve.d (running from the repo).
    """
    candidates: list[str] = []
    if serve_dir:
        candidates.append(serve_dir)

    here = os.path.dirname(os.path.abspath(__file__))

    # In a generated project the do/ scripts live at <project>/do/lib/python/.
    # The .mlcc copy sits at <project>/.mlcc/serve.d/.
    #   here -> <project>/do/lib/python ; ../../.. -> <project>
    project_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    candidates.append(os.path.join(project_root, ".mlcc", "serve.d"))

    # In the MLCC source tree the helper lives at
    # templates/do/lib/python/serve_manifest.py; serve.d is at
    # templates/code/serve.d.
    #   here -> templates/do/lib/python ; ../../.. -> templates
    templates_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    candidates.append(os.path.join(templates_root, "code", "serve.d"))

    # Also try repo/cwd layouts.
    candidates.append(os.path.join(os.getcwd(), "templates", "code", "serve.d"))
    candidates.append(os.path.join(os.getcwd(), ".mlcc", "serve.d"))

    # De-duplicate while preserving order.
    seen: set[str] = set()
    ordered: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


def read_manifest(engine: str, serve_dir: str | None = None) -> dict:
    """Load and return serve.d/<engine>/manifest.json as a dict.

    Raises:
        ManifestNotFound: if no candidate serve.d root contains the manifest.
        ManifestMalformed: if the manifest file exists but does not parse.
    """
    if not engine:
        raise ManifestNotFound("no engine specified")

    tried: list[str] = []
    for root in _candidate_serve_dirs(serve_dir):
        path = os.path.join(root, engine, "manifest.json")
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
        f"no manifest found for engine '{engine}' (looked in: {', '.join(tried)})"
    )


def supported_algorithms(engine: str, serve_dir: str | None = None) -> list[str]:
    """Return the engine's supported_algorithms list."""
    return list(read_manifest(engine, serve_dir).get("supported_algorithms", []))


def env_var_prefix(engine: str, serve_dir: str | None = None) -> str:
    """Return the engine's env_var_prefix (e.g. 'VLLM_')."""
    return read_manifest(engine, serve_dir).get("env_var_prefix", "")


def algorithm_map(engine: str, serve_dir: str | None = None) -> dict[str, str]:
    """Return the engine's algorithm_map (MLCC name -> engine-specific name)."""
    return dict(read_manifest(engine, serve_dir).get("algorithm_map", {}))


def dimension_map(engine: str, serve_dir: str | None = None) -> dict[str, str]:
    """Return the engine's dimension_map (dimension -> config-key suffix)."""
    return dict(read_manifest(engine, serve_dir).get("dimension_map", {}))


def metrics_endpoint(engine: str, serve_dir: str | None = None) -> dict | None:
    """Return the engine's metrics_endpoint dict, or None if not declared."""
    return read_manifest(engine, serve_dir).get("metrics_endpoint")


def engine_features(engine: str, serve_dir: str | None = None) -> dict:
    """Return the engine's `engine_features` map — capabilities unique to this
    engine or implemented differently from the others (ADR-004 §c), declared as
    data. Returns {} when the engine declares none. Read generically; never
    branch on the engine name."""
    return dict(read_manifest(engine, serve_dir).get("engine_features", {}))


def engine_feature(engine: str, feature: str, serve_dir: str | None = None) -> dict | None:
    """Return a single named engine feature's declaration, or None if the engine
    does not declare it."""
    return engine_features(engine, serve_dir).get(feature)


def capability_map(engine: str, serve_dir: str | None = None) -> dict:
    """Return the engine's Tier-1 capability map (ADR-010) with each capability's
    env var already prefixed.

    Tier 1 is the minimal set MLCC computes and injects (model, tensor-parallel
    degree, LoRA + companions); everything else is Tier-2 prefix pass-through and
    is NOT declared here. Returns {} when the engine declares none (llama-cpp,
    vllm-omni) — an explicit "no injected config" statement. Each entry is
    {envVar, valueType('valued'|'boolean'), requires: [...]}.
    """
    manifest = read_manifest(engine, serve_dir)
    prefix = manifest.get("env_var_prefix", "")
    caps = manifest.get("capability_map", {})
    if not prefix or not isinstance(caps, dict):
        return {}
    out = {}
    for name, decl in caps.items():
        if not isinstance(decl, dict):
            continue
        suffix = decl.get("suffix")
        if not isinstance(suffix, str) or not suffix:
            continue
        # Normalize the companion contract to OR-of-AND-groups (ADR-010):
        #   requires_any_of: [[...],[...]] used as-is; requires: [...] -> [[...]];
        #   neither -> [[]] (one empty group = no companions). The resolver emits
        #   the capability if ANY group fully resolves. `requires` kept for
        #   backward-compatible flat consumers (= intersection across groups).
        if isinstance(decl.get("requires_any_of"), list):
            requires_any_of = [
                list(g) if isinstance(g, list) else [] for g in decl["requires_any_of"]
            ]
        elif isinstance(decl.get("requires"), list):
            requires_any_of = [list(decl["requires"])]
        else:
            requires_any_of = [[]]
        flat = []
        for i, g in enumerate(requires_any_of):
            flat = list(g) if i == 0 else [k for k in flat if k in g]
        out[name] = {
            "envVar": f"{prefix}{suffix}",
            "valueType": "boolean" if decl.get("value_type") == "boolean" else "valued",
            "requires": flat,
            "requiresAnyOf": requires_any_of,
        }
    return out


def resolve_capability_vars(engine: str, values: dict, serve_dir: str | None = None) -> dict:
    """Resolve MLCC-computed Tier-1 capability VALUES into concrete env-var pairs.

    This is the SINGLE home of the companion-flag rule (ADR-010 Req 6): a
    capability is emitted only when it has a resolvable value AND every capability
    in its ``requires`` also has a resolvable value; otherwise it is omitted
    (never emitted bare) with a recorded skip reason. Pure data — never branches
    on the engine name — so a custom plugin's companion contract is honored
    identically.

    Returns {"resolved": [{"key","value"}], "skipped": [{"capability","reason"}]}.
    """
    caps = capability_map(engine, serve_dir)
    resolved = []
    skipped = []

    def _is_enabled(name: str) -> bool:
        v = values.get(name)
        if v is None or v == "":
            return False
        decl = caps.get(name)
        if decl and decl["valueType"] == "boolean":
            return str(v).lower() in ("true", "1", "yes")
        return True

    for name, decl in caps.items():
        if not _is_enabled(name):
            continue
        # Companion gating (OR of AND-groups): emittable if AT LEAST ONE group has
        # every companion resolvable. Single-group (flat requires) is the common
        # case; [[]] always passes. Engine-declared; no engine-name branching.
        groups = decl.get("requiresAnyOf") or [[]]
        satisfied = any(all(_is_enabled(req) for req in group) for group in groups)
        if not satisfied:
            unmet_sets = [[req for req in group if not _is_enabled(req)] for group in groups]
            best = sorted(unmet_sets, key=len)[0] if unmet_sets else []
            joined = ", ".join(best)
            is_are = "is" if len(best) == 1 else "are"
            alt_note = " (or another supported companion group)" if len(groups) > 1 else ""
            skipped.append({
                "capability": name,
                "reason": (
                    f"requires {joined}{alt_note} which {is_are} not set; omitting "
                    f"{decl['envVar']} rather than emitting it without its companion(s)"
                ),
            })
            continue
        if decl["valueType"] == "boolean":
            resolved.append({"key": decl["envVar"], "value": "true"})
        else:
            resolved.append({"key": decl["envVar"], "value": str(values[name])})

    return {"resolved": resolved, "skipped": skipped}


# ── Capability versioning (BL129) ──────────────────────────────────────────────
#
# Engine-agnostic capability versioning: the flat manifest fields (e.g.
# supported_algorithms) describe the engine's latest/default capabilities;
# `version_features` records the engine version at which each capability landed,
# and `min_version` the lowest version MLCC gates against. A consumer resolves the
# EFFECTIVE capability set for a detected engine version = the flat set minus any
# capability whose `since` is above that version.
#
# FAIL-OPEN CONTRACT: when the engine version is unknown (None) the effective set
# equals the flat set — version gating is an enhancement, never a new gate. Below
# `min_version` the effective set is still the flat set (consumers may warn), so a
# version we cannot fully reason about never blocks a user.


def _parse_semver(version_string: str) -> tuple[int, int, int] | None:
    """Parse a dotted version into a (major, minor, patch) tuple, or None.

    Accepts 1-3 numeric segments (missing segments default to 0); a leading 'v'
    is tolerated. Returns None for anything non-numeric so callers can fail open.
    """
    if not version_string or not isinstance(version_string, str):
        return None
    s = version_string.strip()
    if s.startswith("v"):
        s = s[1:]
    parts = s.split(".")
    nums: list[int] = []
    for p in parts[:3]:
        if not p.isdigit():
            return None
        nums.append(int(p))
    if not nums:
        return None
    while len(nums) < 3:
        nums.append(0)
    return (nums[0], nums[1], nums[2])


def _semver_ge(a: str, b: str) -> bool:
    """True if version a >= version b. Unparseable versions compare False."""
    pa, pb = _parse_semver(a), _parse_semver(b)
    if pa is None or pb is None:
        return False
    return pa >= pb


def effective_supported_algorithms(
    engine: str, version: str | None = None, serve_dir: str | None = None
) -> list[str]:
    """Return the supported_algorithms available at the given engine version.

    Starts from the flat supported_algorithms and removes any algorithm gated by
    a version_features entry whose `since` is ABOVE the detected version.

    Fail-open: when `version` is None or unparseable, no gating is applied and the
    full flat list is returned. `min_version` does not remove algorithms here (the
    consumer decides how to treat a below-minimum version); it is surfaced via
    min_version() for messaging.
    """
    manifest = read_manifest(engine, serve_dir)
    flat = list(manifest.get("supported_algorithms", []))

    # Fail-open: unknown/unparseable version → no gating.
    if _parse_semver(version) is None:
        return flat

    gated_out: set[str] = set()
    for feature in manifest.get("version_features", []):
        since = feature.get("since")
        if since is None:
            continue
        # since > version  ⇔  NOT (version >= since)
        if not _semver_ge(version, since):
            for alg in feature.get("adds", {}).get("supported_algorithms", []):
                gated_out.add(alg)

    return [a for a in flat if a not in gated_out]


def min_version(engine: str, serve_dir: str | None = None) -> str | None:
    """Return the engine's declared min_version, or None if it declares none."""
    return read_manifest(engine, serve_dir).get("min_version")


def is_version_supported(
    engine: str, version: str | None, serve_dir: str | None = None
) -> bool:
    """True if the detected version is at or above the engine's min_version.

    Fail-open: True when the engine declares no min_version, or when the version
    is unknown/unparseable (we never block on a version we cannot read).
    """
    mv = min_version(engine, serve_dir)
    if not mv:
        return True
    if _parse_semver(version) is None:
        return True
    return _semver_ge(version, mv)


# ── Version source: base image → engine version (BL129) ────────────────────────
#
# The engine version is resolved statically from the deployment's BASE_IMAGE (in
# do/config), not by probing a running container. The authoritative map is the
# base-image catalog (servers/lib/catalogs/model-servers.json), which records
# `labels.framework_version` per image entry. When the image is not in the catalog
# (custom/override images) we fall back to parsing the version out of the tag
# (e.g. vllm/vllm-openai:v0.29.0 → 0.29.0). Any failure returns None → fail-open.


def _candidate_model_servers_catalogs() -> list[str]:
    """Return candidate model-servers.json paths in resolution order.

    Mirrors the serve.d resolution: the project-local .mlcc copy first (generated
    projects ship the catalog under .mlcc/servers-lib/ or similar), then the MLCC
    source tree, then cwd layouts. Unknown layouts simply miss and we fall back to
    tag parsing.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    templates_root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    # From templates/do/lib/python → repo root is one level above templates/.
    repo_root = os.path.abspath(os.path.join(templates_root, ".."))
    candidates = [
        os.path.join(project_root, ".mlcc", "catalogs", "model-servers.json"),
        os.path.join(project_root, ".mlcc", "servers", "lib", "catalogs", "model-servers.json"),
        os.path.join(repo_root, "servers", "lib", "catalogs", "model-servers.json"),
        os.path.join(os.getcwd(), "servers", "lib", "catalogs", "model-servers.json"),
    ]
    seen: set[str] = set()
    ordered: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


def _parse_version_from_tag(image_or_tag: str) -> str | None:
    """Extract a semver-ish version from an image ref or tag.

    Examples:
        vllm/vllm-openai:v0.29.0     → 0.29.0
        v0.29.0-cu128                → 0.29.0
        0.4.9.post1                  → 0.4.9
    Returns None when no leading numeric version is present (e.g. 'latest').
    """
    if not image_or_tag or not isinstance(image_or_tag, str):
        return None
    tag = image_or_tag.rsplit(":", 1)[-1] if ":" in image_or_tag else image_or_tag
    if tag.startswith("v"):
        tag = tag[1:]
    # Take the leading dotted-numeric run (stop at first non [0-9.] char).
    match = re.match(r"^(\d+(?:\.\d+){0,2})", tag)
    if not match:
        return None
    parsed = _parse_semver(match.group(1))
    if parsed is None:
        return None
    return f"{parsed[0]}.{parsed[1]}.{parsed[2]}"


def engine_version_from_base_image(
    engine: str, base_image: str, catalog_path: str | None = None
) -> str | None:
    """Resolve the engine version for a deployment's BASE_IMAGE.

    Precedence:
      1. model-servers.json: the entry (under key `engine`) whose `image` or `tag`
         matches base_image, using its `labels.framework_version`.
      2. Tag parse: the version embedded in the image ref (fallback for
         custom/override images not in the catalog).
      3. None (fail-open — the consumer applies no gating).
    """
    if not base_image:
        return None

    # 1. Catalog lookup by exact image or tag match.
    roots = [catalog_path] if catalog_path else _candidate_model_servers_catalogs()
    for path in roots:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                catalog = json.load(f)
        except (json.JSONDecodeError, ValueError, OSError):
            continue
        entries = catalog.get(engine, []) if isinstance(catalog, dict) else []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if entry.get("image") == base_image or entry.get("tag") == base_image:
                fw = (entry.get("labels") or {}).get("framework_version")
                if fw and _parse_semver(fw) is not None:
                    return _parse_version_from_tag(fw) or fw
        # Catalog found but no entry matched → break to tag-parse fallback.
        break

    # 2. Tag-parse fallback.
    return _parse_version_from_tag(base_image)


# ── CLI one-shot for bash callers ──────────────────────────────────────────────

_FIELD_PRINTERS = {
    "supported_algorithms": lambda m: json.dumps(m.get("supported_algorithms", [])),
    "env_var_prefix": lambda m: m.get("env_var_prefix", ""),
    "algorithm_map": lambda m: json.dumps(m.get("algorithm_map", {})),
    "dimension_map": lambda m: json.dumps(m.get("dimension_map", {})),
    "engine": lambda m: m.get("engine", ""),
    "hot_reload": lambda m: json.dumps(m.get("hot_reload")),
    "min_version": lambda m: m.get("min_version", ""),
    "version_features": lambda m: json.dumps(m.get("version_features", [])),
    "engine_features": lambda m: json.dumps(m.get("engine_features", {})),
}


def _cli(argv: list[str]) -> int:
    # ── Version-aware operations (BL129) ──────────────────────────────────────
    # These take an extra argument (a version or a base image) and resolve the
    # capability-versioning fields. They are dispatched before the flat field
    # lookup below. All fail open: a missing/unparseable version yields the flat
    # set (no gating), so a version we can't read never blocks a caller.
    if argv and argv[0] == "engine_version":
        # engine_version <engine> <base_image>  → resolved version or empty string.
        if len(argv) != 3:
            print("usage: serve_manifest.py engine_version <engine> <base_image>", file=sys.stderr)
            return 2
        _engine, base_image = argv[1], argv[2]
        version = engine_version_from_base_image(_engine, base_image)
        print(version or "")
        return 0

    if argv and argv[0] == "effective_supported_algorithms":
        # effective_supported_algorithms <engine> [version]  → JSON array.
        if len(argv) not in (2, 3):
            print("usage: serve_manifest.py effective_supported_algorithms <engine> [version]", file=sys.stderr)
            return 2
        _engine = argv[1]
        _version = argv[2] if len(argv) == 3 else None
        try:
            algos = effective_supported_algorithms(_engine, _version)
        except ManifestNotFound as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 3
        except ManifestMalformed as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 4
        print(json.dumps(algos))
        return 0

    if argv and argv[0] == "is_version_supported":
        # is_version_supported <engine> [version]  → prints "true"/"false".
        if len(argv) not in (2, 3):
            print("usage: serve_manifest.py is_version_supported <engine> [version]", file=sys.stderr)
            return 2
        _engine = argv[1]
        _version = argv[2] if len(argv) == 3 else None
        try:
            ok = is_version_supported(_engine, _version)
        except ManifestNotFound as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 3
        except ManifestMalformed as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 4
        print("true" if ok else "false")
        return 0

    # ── Engine-config capability resolution (ADR-010) ─────────────────────────
    # Tier-1 capability map + the single-home companion resolver. Plugin-first:
    # the output derives entirely from the engine's manifest capability_map, so a
    # custom serve.d/<engine>/ participates with zero MLCC-file edits.
    if argv and argv[0] == "capability_map":
        # capability_map <engine>  → JSON object of {cap: {envVar,valueType,requires}}.
        if len(argv) != 2:
            print("usage: serve_manifest.py capability_map <engine>", file=sys.stderr)
            return 2
        _engine = argv[1]
        try:
            caps = capability_map(_engine)
        except ManifestNotFound as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 3
        except ManifestMalformed as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 4
        print(json.dumps(caps))
        return 0

    if argv and argv[0] == "resolve_capability_vars":
        # resolve_capability_vars <engine> <values-json>  → JSON {resolved,skipped}.
        if len(argv) != 3:
            print(
                "usage: serve_manifest.py resolve_capability_vars <engine> <values-json>",
                file=sys.stderr,
            )
            return 2
        _engine, _values_json = argv[1], argv[2]
        try:
            _values = json.loads(_values_json)
        except (ValueError, TypeError) as exc:
            print(f"Error: invalid values JSON: {exc}", file=sys.stderr)
            return 2
        if not isinstance(_values, dict):
            print("Error: values JSON must be an object", file=sys.stderr)
            return 2
        try:
            result = resolve_capability_vars(_engine, _values)
        except ManifestNotFound as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 3
        except ManifestMalformed as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 4
        print(json.dumps(result))
        return 0

    if len(argv) != 2:
        print("usage: serve_manifest.py <field> <engine>", file=sys.stderr)
        return 2

    field, engine = argv

    try:
        manifest = read_manifest(engine)
    except ManifestNotFound as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 3
    except ManifestMalformed as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 4

    if field == "metrics_endpoint":
        me = manifest.get("metrics_endpoint")
        if me is None:
            print(f"Error: engine '{engine}' declares no metrics_endpoint", file=sys.stderr)
            return 5
        print(json.dumps(me))
        return 0

    printer = _FIELD_PRINTERS.get(field)
    if printer is None:
        print(f"Error: unknown field '{field}'", file=sys.stderr)
        return 6

    print(printer(manifest))
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))

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

  Exit codes: 0 on success; non-zero on missing/malformed manifest or
  unknown field. Errors are printed to stderr.
"""

from __future__ import annotations

import json
import os
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


# ── CLI one-shot for bash callers ──────────────────────────────────────────────

_FIELD_PRINTERS = {
    "supported_algorithms": lambda m: json.dumps(m.get("supported_algorithms", [])),
    "env_var_prefix": lambda m: m.get("env_var_prefix", ""),
    "algorithm_map": lambda m: json.dumps(m.get("algorithm_map", {})),
    "dimension_map": lambda m: json.dumps(m.get("dimension_map", {})),
    "engine": lambda m: m.get("engine", ""),
    "hot_reload": lambda m: json.dumps(m.get("hot_reload")),
}


def _cli(argv: list[str]) -> int:
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

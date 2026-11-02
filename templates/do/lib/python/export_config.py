#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""do/export data work (Wave 8 / BL160, OQ-8.5 / OQ-8.6). Stdlib only.

``do/export`` sources ``do/config`` (so ``${VAR:-default}`` expansions and shell
overrides resolve exactly as every other do/ verb sees them) and calls this
helper, which turns the RUNTIME values back into generator parameters:

1. the vars do/config declares (active ``export`` lines, read with the shared
   ``deploy_prompts.parse_config`` parser) are the candidates -- a value that only
   exists in the shell (e.g. a profile-resolved ARN) is never exported;
2. each var maps to its schema parameter through ``export_map.json``, generated
   from ``config/parameter-schema-v2.json`` (``doConfigVar``) by
   ``scripts/codegen-export-map.js`` -- no hand-maintained table here;
3. parameters that do not apply to the effective deployment target
   (``appliesTo.deploymentTargets``, aliases resolved via ``targets.d``) or to the
   project's architecture (do/config ``FRAMEWORK``), whose value equals the schema
   default, or that hold the literal do/config renders when the parameter was not
   given (``doConfigUnsetValue``) are dropped;
4. values are coerced to the schema type; secrets become ``$VAR`` references,
   never values;
5. the SAME resolved list renders either the canonical generator ``--config``
   object (``--format json``, a real JSON serializer, schema parameter keys) or
   the equivalent CLI command (``--format cli``, ``shlex``-quoted).

CLI::

    export_config.py [--format json|cli] [--target T] [--config do/config] [--map export_map.json]
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import re
import shlex
import sys
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import target_manifest  # noqa: E402

_SHELL_DEFAULT = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}")
DEFAULT_MAP = os.path.join(_HERE, "export_map.json")
DEFAULT_CONFIG = os.path.normpath(os.path.join(_HERE, "..", "..", "config"))
CLI_PROGRAM = "ml-container-creator"


def load_map(path: str = DEFAULT_MAP) -> list[dict]:
    """Return the generated parameter entries (schema order)."""
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["parameters"]


def read_declared(config_path: str) -> dict[str, str]:
    """Vars declared by active ``export`` lines in do/config (file-parsed values)."""
    from deploy_prompts import parse_config  # shared do/config parser

    return parse_config(config_path)


@functools.lru_cache(maxsize=None)
def _canonical(target: str) -> str:
    try:
        return target_manifest.resolve_target(target)
    except Exception as exc:  # descriptor dir missing / malformed
        print(f"⚠️  could not resolve target aliases ({exc}); using '{target}' as given", file=sys.stderr)
        return target


def applies(entry: dict, target: str, architecture: str | None = None) -> bool:
    """True when the parameter applies to ``target`` (aliases resolved) and, when
    the project's architecture is known (do/config FRAMEWORK), to that architecture."""
    archs = entry.get("architectures") or ["*"]
    if architecture and "*" not in archs and architecture not in archs:
        return False
    targets = entry.get("deploymentTargets") or ["*"]
    if "*" in targets:
        return True
    canonical = _canonical(target)
    return any(_canonical(t) == canonical for t in targets)


def coerce(entry: dict, raw: str) -> Any:
    """Coerce a do/config string to the parameter's schema type (ValueError if invalid)."""
    kind = entry.get("type")
    if kind == "integer":
        return int(raw.strip())
    if kind == "number":
        num = float(raw.strip())
        return int(num) if num.is_integer() else num
    if kind == "boolean":
        low = raw.strip().lower()
        if low in ("true", "1", "yes"):
            return True
        if low in ("false", "0", "no"):
            return False
        raise ValueError(f"not a boolean: {raw!r}")
    return raw


def parse_env_map(marker: str, lookup) -> dict[str, str]:
    """``"K1=VAR1 K2=VAR2"`` -> ``{K1: value(VAR1), ...}``; unset vars are skipped."""
    result: dict[str, str] = {}
    for pair in marker.split():
        key, sep, var = pair.partition("=")
        if not sep or not key or not var:
            print(f"⚠️  ignoring malformed env key entry '{pair}'", file=sys.stderr)
            continue
        value = lookup(var)
        if value is not None:
            result[key] = value
    return result


def resolve(entries: list[dict], declared: dict[str, str], env: dict[str, str], target: str) -> list[tuple[dict, Any]]:
    """Return ``[(entry, typed value)]`` for every exportable parameter, schema order."""

    def lookup(var: str) -> str | None:
        if var in env:
            return env[var]
        value = declared.get(var)
        if value is None:
            return None
        # Not sourced (helper run directly): resolve ${VAR:-default} like bash would
        # for an unset VAR (parse_config only does this for double-quoted values).
        return _SHELL_DEFAULT.sub(r"\1", value)

    architecture = lookup("FRAMEWORK") or None
    items: list[tuple[dict, Any]] = []
    for entry in entries:
        if not applies(entry, target, architecture):
            continue
        var = entry["doConfigVar"]
        if var not in declared:
            continue
        raw = lookup(var)
        if raw is None or raw == "":
            continue
        if entry.get("unsetValue") is not None and raw == entry["unsetValue"]:
            # do/config renders this literal when the parameter was not given.
            continue
        if entry.get("shape") == "env-map":
            value: Any = parse_env_map(raw, lookup)
            if not value:
                continue
            items.append((entry, value))
            continue
        if entry.get("sensitive"):
            items.append((entry, f"${var}"))
            continue
        try:
            value = coerce(entry, raw)
        except ValueError:
            print(
                f"⚠️  do/config {var}={raw!r} is not a valid {entry.get('type')} for "
                f"'{entry['key']}'; exported as a string",
                file=sys.stderr,
            )
            value = raw
        if is_default(value, entry.get("default")):
            continue
        items.append((entry, value))
    return items


def is_default(value: Any, default: Any) -> bool:
    """Equal to the schema default (booleans never equal numbers: True != 1 here)."""
    if isinstance(value, bool) or isinstance(default, bool):
        return type(value) is type(default) and value == default
    return value == default


def render_json(items: list[tuple[dict, Any]]) -> str:
    """The canonical generator ``--config`` object (schema parameter keys)."""
    return json.dumps({entry["key"]: value for entry, value in items}, indent=2)


def render_cli(items: list[tuple[dict, Any]]) -> tuple[str, list[str]]:
    """``(command, notes)`` -- the CLI equivalent of :func:`render_json`."""
    env_prefix: list[str] = []
    args: list[str] = [CLI_PROGRAM]
    notes: list[str] = []
    for entry, value in items:
        flag = entry.get("cliFlag")
        if not flag:
            notes.append(f"'{entry['key']}' has no CLI flag; use --json / --config")
            continue
        if entry.get("shape") == "env-map":
            for key, val in value.items():
                args.append(f"{flag}={shlex.quote(f'{key}={val}')}")
        elif entry.get("sensitive"):
            # A reference the shell expands at run time -- never the value.
            args.append(f'{flag}="{value}"')
        elif entry.get("type") == "boolean":
            if value:
                args.append(flag)
            elif entry.get("envVar"):
                env_prefix.append(f"{entry['envVar']}=false")
            else:
                notes.append(f"'{entry['key']}=false' cannot be expressed as a CLI flag; use --json / --config")
        else:
            args.append(f"{flag}={shlex.quote(str(value))}")
    args.append("--skip-prompts")
    return " ".join(env_prefix + args), notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export do/config as a generator --config object or CLI command.")
    parser.add_argument("--format", choices=("json", "cli"), default="cli")
    parser.add_argument("--target", default=None, help="effective deployment target (default: $DEPLOYMENT_TARGET)")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help="path to do/config")
    parser.add_argument("--map", default=DEFAULT_MAP, help="path to export_map.json")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.config):
        print(f"❌ do/config not found: {args.config}", file=sys.stderr)
        return 2
    try:
        entries = load_map(args.map)
    except (OSError, ValueError, KeyError) as exc:
        print(f"❌ cannot read the export map {args.map}: {exc}", file=sys.stderr)
        return 2

    env = dict(os.environ)
    target = args.target or env.get("DEPLOYMENT_TARGET") or "realtime-inference"
    target = _canonical(target)
    # The exported deploymentTarget is the effective target (--target override).
    env["DEPLOYMENT_TARGET"] = target
    declared = read_declared(args.config)
    items = resolve(entries, declared, env, target)

    if args.format == "json":
        print(render_json(items))
        return 0
    command, notes = render_cli(items)
    print("")
    for note in notes:
        print(f"# ⚠️  {note}")
    print("# Reproduce this project with a single command:")
    print(command)
    print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())

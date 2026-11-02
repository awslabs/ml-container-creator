from __future__ import annotations
"""Runtime validator for user-authored do/train technique manifests (BL154).

Purpose: load + validate an OPTIONAL ``do/training/<technique>/manifest.json`` at
         do/train RUNTIME. The manifest is user-authored in a generated project, so it
         is untrusted input: every problem is reported (not just the first), as a
         structured ``TrainManifestError`` — never a stack trace.

Contract: the manifest shape is defined by config/train-descriptor.schema.json (repo)
          and its generated, self-contained copy do/training/manifest.schema.json
          (shipped). Each knob entry follows the tune descriptor's
          ``$defs/hyperparameter``. This module re-checks that contract in plain Python
          so the generated project needs NO ``jsonschema`` dependency (R2.4).

Drift guard: ``KNOB_KEYS`` mirrors the ``properties`` of the tune schema's
             ``$defs/hyperparameter``; test/unit/train-manifest-conformance.test.js
             asserts the two agree (a conformance-checked duplicate, repo rule #4).

Callers: tune_config_builder.build_from_train_descriptor (via .train_helper.py
         build-config, invoked by do/train).
"""

import difflib
import json
import os

# No third-party imports (R2.4). tune_config_builder is imported lazily for the shared
# _coerce/_validate (one coercion engine, not two).

# Top-level manifest keys. `$schema` is an editor hint only and is ignored.
TOP_LEVEL_KEYS = (
    "$schema",
    "schema_version",
    "technique",
    "display_name",
    "description",
    "hyperparameters",
)
REQUIRED_TOP_LEVEL_KEYS = ("schema_version", "technique", "hyperparameters")
SCHEMA_VERSION = 1

# Mirrors templates/code/tune.d/manifest.schema.json $defs/hyperparameter.properties
# (drift-checked by test/unit/train-manifest-conformance.test.js).
KNOB_KEYS = (
    "type",
    "required",
    "default",
    "min",
    "max",
    "step",
    "enum",
    "control",
    "tier",
    "display_name",
    "description",
    "hint",
)
# Mirrors $defs/hyperparameter.required.
REQUIRED_KNOB_KEYS = ("type", "required")
KNOB_TYPES = ("string", "integer", "number", "boolean")

# Common misspellings / other-tool vocabulary that difflib would not catch.
_KEY_HINTS = {
    "choices": "enum",
    "options": "enum",
    "values": "enum",
    "minimum": "min",
    "maximum": "max",
    "help": "description",
    "label": "display_name",
    "name": "display_name",
    "visibility_tier": "tier",
    "control_type": "control",
}

_TECHNIQUE_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789_-")


class TrainManifestError(Exception):
    """A present-but-invalid manifest. Carries ``path`` and ``problems`` (every problem
    found, one human-readable string each)."""

    def __init__(self, path: str, problems: list[str]):
        self.path = path
        self.problems = list(problems)
        super().__init__(f"{path}: " + "; ".join(self.problems))

    def format(self, display_path: str | None = None) -> str:
        """The structured, user-facing message do/train prints (no traceback)."""
        lines = [f"\u274c Invalid training manifest: {display_path or self.path}"]
        lines.extend(f"   \u2022 {p}" for p in self.problems)
        lines.append("   \u2192 Fix the manifest, or delete it to fall back to "
                     "defaults.yaml + flags.")
        return "\n".join(lines)


def _suggest(key: str, allowed) -> str:
    hint = _KEY_HINTS.get(key)
    if hint is None:
        close = difflib.get_close_matches(key, list(allowed), n=1)
        hint = close[0] if close else None
    return f" (did you mean '{hint}'?)" if hint else ""


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _valid_technique_id(value: str) -> bool:
    return bool(value) and value[0] not in "_-" and set(value) <= _TECHNIQUE_CHARS


def _validate_knob(name: str, knob, problems: list[str]) -> None:
    where = f"hyperparameters.{name}"
    if not isinstance(knob, dict):
        problems.append(f"{where}: must be an object, got {type(knob).__name__}")
        return

    for key in knob:
        if key not in KNOB_KEYS:
            problems.append(f"{where}: unknown key '{key}'{_suggest(key, KNOB_KEYS)}")
    for key in REQUIRED_KNOB_KEYS:
        if key not in knob:
            problems.append(f"{where}: missing required key '{key}'")

    ktype = knob.get("type")
    type_ok = ktype in KNOB_TYPES
    if "type" in knob and not type_ok:
        problems.append(f"{where}: 'type' must be one of {list(KNOB_TYPES)}, got {ktype!r}")
    if "required" in knob and not isinstance(knob["required"], bool):
        problems.append(f"{where}: 'required' must be true or false, got {knob['required']!r}")

    bounds_ok = True
    for key in ("min", "max", "step"):
        if key in knob and not _is_number(knob[key]):
            problems.append(f"{where}: '{key}' must be a number, got {knob[key]!r}")
            bounds_ok = False
    if bounds_ok and _is_number(knob.get("min")) and _is_number(knob.get("max")) \
            and knob["min"] > knob["max"]:
        problems.append(f"{where}: 'min' ({knob['min']}) is greater than 'max' ({knob['max']})")
        bounds_ok = False

    enum_ok = True
    if "enum" in knob:
        if not isinstance(knob["enum"], list) or not knob["enum"]:
            problems.append(f"{where}: 'enum' must be a non-empty list, got {knob['enum']!r}")
            enum_ok = False

    import tune_config_builder as _tcb  # shared vocabulary + coercion engine
    if "control" in knob and knob["control"] not in _tcb._VALID_CONTROLS:
        problems.append(f"{where}: 'control' must be one of {list(_tcb._VALID_CONTROLS)}, "
                        f"got {knob['control']!r}")
    if "tier" in knob and knob["tier"] not in _tcb._VALID_TIERS:
        problems.append(f"{where}: 'tier' must be one of {list(_tcb._VALID_TIERS)}, "
                        f"got {knob['tier']!r}")
    for key in ("display_name", "description", "hint"):
        if key in knob and not isinstance(knob[key], str):
            problems.append(f"{where}: '{key}' must be a string, got {knob[key]!r}")

    # A declared default must coerce to the type and satisfy its own bounds/enum —
    # checked with the SAME _coerce/_validate the resolver uses. Skipped when the
    # constraints themselves are broken (already reported above).
    if "default" in knob and type_ok and bounds_ok and enum_ok:
        coerced, cerr = _tcb._coerce(name, knob, knob["default"])
        if cerr:
            problems.append(f"{where}: 'default' {knob['default']!r} is invalid: {cerr}")
        elif coerced is not None:
            verr = _tcb._validate(name, knob, coerced)
            if verr:
                problems.append(f"{where}: 'default' {knob['default']!r} is invalid: {verr}")


def validate_train_manifest(data, *, technique: str, path: str) -> list[str]:
    """Pure check of a parsed manifest. Returns ALL problems (empty list == valid)."""
    problems: list[str] = []
    if not isinstance(data, dict):
        return [f"top level must be a JSON object, got {type(data).__name__}"]

    for key in data:
        if key not in TOP_LEVEL_KEYS:
            problems.append(f"unknown top-level key '{key}'{_suggest(key, TOP_LEVEL_KEYS)}")
    for key in REQUIRED_TOP_LEVEL_KEYS:
        if key not in data:
            problems.append(f"missing required top-level key '{key}'")

    if "schema_version" in data and (
            data["schema_version"] != SCHEMA_VERSION or isinstance(data["schema_version"], bool)):
        problems.append(f"'schema_version' must be {SCHEMA_VERSION}, got {data['schema_version']!r}")

    if "technique" in data:
        tech = data["technique"]
        if not isinstance(tech, str) or not _valid_technique_id(tech):
            problems.append(f"'technique' must be a lowercase id ([a-z0-9][a-z0-9_-]*), got {tech!r}")
        elif tech != technique:
            problems.append(f"'technique' is {tech!r} but the manifest lives in the "
                            f"'{technique}' directory (they must match)")

    for key in ("display_name", "description"):
        if key in data and not isinstance(data[key], str):
            problems.append(f"'{key}' must be a string, got {data[key]!r}")

    if "hyperparameters" in data:
        hp = data["hyperparameters"]
        if not isinstance(hp, dict):
            problems.append(f"'hyperparameters' must be an object, got {type(hp).__name__}")
        else:
            for name, knob in hp.items():
                if not isinstance(name, str) or not name.strip():
                    problems.append(f"hyperparameters: knob names must be non-empty strings, got {name!r}")
                    continue
                _validate_knob(name, knob, problems)
    return problems


def manifest_path(training_dir: str, technique: str) -> str:
    return os.path.join(training_dir, technique, "manifest.json")


def load_train_manifest(training_dir: str, technique: str) -> dict | None:
    """Return the parsed, VALIDATED manifest for <training_dir>/<technique>/manifest.json,
    or None when the file is absent (descriptor-less technique). Raises
    TrainManifestError — never anything else — when present but invalid."""
    path = manifest_path(training_dir, technique)
    if not os.path.exists(path):
        return None
    try:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            raise TrainManifestError(path, [f"cannot read file: {exc}"]) from None
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise TrainManifestError(
                path, [f"not valid JSON (line {exc.lineno}, col {exc.colno}): {exc.msg}"]
            ) from None
        problems = validate_train_manifest(data, technique=technique, path=path)
        if problems:
            raise TrainManifestError(path, problems)
        return data
    except TrainManifestError:
        raise
    except Exception as exc:  # noqa: BLE001 — surface, never a traceback (BL165)
        raise TrainManifestError(path, [f"unexpected error while validating: {exc}"]) from None

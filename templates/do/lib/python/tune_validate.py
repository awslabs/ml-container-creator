from __future__ import annotations
"""Tune validate: validate dataset format against expected schema.

Purpose: cmd_validate subcommand for do/tune
Inputs: --schema (JSON string), --file (path or stdin)
Outputs: JSON with valid, error, line_number, malformed_line
Caller: .tune_helper.py dispatcher
Related: tune_stage_hf.py (stages datasets that this validates)
"""

import json
import sys

from common import _output, _error_exit


def _check_type(value, expected_type):
    """Check if a value matches the expected schema type."""
    if expected_type == "string":
        return isinstance(value, str)
    elif expected_type == "number":
        return isinstance(value, (int, float))
    elif expected_type == "array":
        return isinstance(value, list)
    elif expected_type == "object":
        return isinstance(value, dict)
    return True


def _get_type(value):
    """Get a human-readable type name for a value."""
    if value is None:
        return "null"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return type(value).__name__


def _build_expected_format(schema):
    """Build a human-readable expected format description from a schema."""
    required = schema.get("required", [])
    types = schema.get("types", {})

    fields = []
    for key in required:
        field_type = types.get(key, "any")
        fields.append(f'"{key}": <{field_type}>')

    return "Each line must be a JSON object with: {" + ", ".join(fields) + "}"


def cmd_validate(args):
    """Validate dataset format against expected schema.

    The schema is passed as a JSON string argument.

    Returns: {"valid": bool, "error": str|None, "line_number": int|None,
              "malformed_line": str|None}
    """
    # Parse the schema from JSON argument
    try:
        schema = json.loads(args.schema)
    except json.JSONDecodeError as e:
        _error_exit(f"Invalid schema JSON: {e}")

    required_keys = schema.get("required", [])
    type_map = schema.get("types", {})

    # Read lines from stdin or file
    lines = []
    if args.file and args.file != "-":
        try:
            with open(args.file, "r") as f:
                for i, line in enumerate(f):
                    lines.append(line.rstrip("\n"))
                    if i >= 9:  # Only inspect first 10 lines
                        break
        except FileNotFoundError:
            _error_exit(f"Dataset file not found: {args.file}")
        except Exception as e:
            _error_exit(f"Failed to read dataset file: {e}")
    else:
        # Read from stdin
        for i, line in enumerate(sys.stdin):
            lines.append(line.rstrip("\n"))
            if i >= 9:  # Only inspect first 10 lines
                break

    # Validate each line
    for i, line in enumerate(lines):
        line_number = i + 1

        # Skip empty lines
        if not line or not line.strip():
            continue

        # Try to parse as JSON
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as e:
            _output({
                "valid": False,
                "error": f"Line {line_number} is not valid JSON: {e}",
                "line_number": line_number,
                "malformed_line": line,
                "expected_format": _build_expected_format(schema),
            })
            return

        # Check that parsed value is a dict
        if not isinstance(parsed, dict):
            _output({
                "valid": False,
                "error": f"Line {line_number} must be a JSON object.",
                "line_number": line_number,
                "malformed_line": line,
                "expected_format": _build_expected_format(schema),
            })
            return

        # Check required keys
        for key in required_keys:
            if key not in parsed:
                _output({
                    "valid": False,
                    "error": f'Line {line_number} is missing required key "{key}".',
                    "line_number": line_number,
                    "malformed_line": line,
                    "expected_format": _build_expected_format(schema),
                })
                return

        # Check types if specified
        for key, expected_type in type_map.items():
            if key not in parsed:
                continue

            value = parsed[key]
            if not _check_type(value, expected_type):
                actual_type = _get_type(value)
                _output({
                    "valid": False,
                    "error": (
                        f'Line {line_number} has key "{key}" with wrong type. '
                        f'Expected "{expected_type}", got "{actual_type}".'
                    ),
                    "line_number": line_number,
                    "malformed_line": line,
                    "expected_format": _build_expected_format(schema),
                })
                return

    _output({
        "valid": True,
        "error": None,
        "line_number": None,
        "malformed_line": None,
    })

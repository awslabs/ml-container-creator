# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Scale-to-zero capability helper (Wave 10, ADR-014).

Purpose: the one place bash reads a target's ``scale_to_zero`` descriptor block
         from (via target_manifest.py), so do/deploy, deploy.d/realtime-inference,
         clean.d/realtime-inference, do/status and do/add-ic never branch on a
         target name for this capability (ADR-008).

CLI (one-shot, for bash callers):
    python3 do/lib/python/scale_to_zero.py shell <target>
        prints STZ_SUPPORT=..., STZ_MECHANISM=..., STZ_WAKE_SIGNAL=...,
        STZ_REQUESTS_AT_ZERO=..., STZ_IDLE_BILLING=..., STZ_ENABLED=true|false,
        STZ_REASON=... as shell-quoted assignments for ``eval``.
    python3 do/lib/python/scale_to_zero.py warning <target>
        prints the plain cold-start warning (R5.1): wording from the target's
        requests_at_zero, figures from scale_to_zero_reference.json (R5.2).
    python3 do/lib/python/scale_to_zero.py cost-caveat <target>
        prints the Wave 9 cost-caveat extension (R6.1), or nothing when
        scale-to-zero is not on for the target.

  Exit codes: 0 success; 2 usage; 3 unknown target.
"""

from __future__ import annotations

import json
import os
import shlex
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import target_manifest  # noqa: E402

# descriptor key -> shell variable
_SHELL_VARS = (
    ("support", "STZ_SUPPORT"),
    ("mechanism", "STZ_MECHANISM"),
    ("wake_signal", "STZ_WAKE_SIGNAL"),
    ("requests_at_zero", "STZ_REQUESTS_AT_ZERO"),
    ("idle_billing", "STZ_IDLE_BILLING"),
    ("enabled", "STZ_ENABLED"),
    ("reason", "STZ_REASON"),
)


def capability(target: str) -> dict:
    """The target's scale_to_zero block (alias-aware; see target_manifest)."""
    return target_manifest.scale_to_zero(target)


def shell_assignments(target: str) -> list[str]:
    """``VAR='value'`` lines for the block; null -> '', booleans -> true/false."""
    block = capability(target)
    lines = []
    for key, var in _SHELL_VARS:
        value = block.get(key)
        if isinstance(value, bool):
            text = "true" if value else "false"
        elif value is None:
            text = ""
        else:
            text = str(value)
        lines.append(f"{var}={shlex.quote(text)}")
    return lines


REFERENCE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scale_to_zero_reference.json")

# requests_at_zero -> what a caller sees while the target is at zero.
_AT_ZERO = {
    "fail": "While at zero, requests FAIL until a copy is ready (a failed request triggers the wake).",
    "queued": "While at zero, requests are QUEUED until capacity is ready.",
    "unknown": "While at zero, what happens to requests is unverified.",
}
_WAKE_COST = {
    "fail": "in failed requests",
    "queued": "in queued (delayed) requests",
    "unknown": "in requests of unverified outcome",
}


def reference(path: str | None = None) -> dict:
    """The measured reference recovery (source, date, runs, breakdown)."""
    with open(path or REFERENCE_PATH, encoding="utf-8") as f:
        return json.load(f)


def _num(value) -> str:
    return f"{float(value):.1f}"


def _provenance(ref: dict) -> str:
    return (f"{ref['source'].split(',')[0]} {ref['date']}: {ref['model']}, {ref['instance']}, "
            f"{ref['engine']}, {ref['region']}")


def warning_lines(target: str, ref: dict | None = None) -> list[str]:
    """The plain warning (ADR-014 §3, R5.1) for a target that is at, or may
    scale to, zero. Numbers come only from the reference data file."""
    ref = ref or reference()
    block = capability(target)
    runs = " / ".join(_num(m) for m in ref.get("runs_minutes", []))
    phases = " · ".join(f"{_num(p['minutes'])} {p['phase']}" for p in ref["breakdown_minutes"])
    lines = ["⚠️  Scale-to-zero is on: not for interactive SLAs."]
    at_zero = _AT_ZERO.get(block.get("requests_at_zero", ""))
    if at_zero:
        lines.append(f"   {at_zero}")
    lines.append(f"   Reference recovery from zero: {_num(ref['recovery_mean_minutes'])} min mean"
                 + (f" ({len(ref.get('runs_minutes', []))} runs: {runs} min)" if runs else "") + ";")
    lines.append(f"   breakdown (min): {phases}.")
    lines.append(f"   Source: {_provenance(ref)}.")
    lines.append("   Your model and instance were not measured.")
    return lines


def cost_caveat(target: str | None, scale_to_zero: str | None, ref: dict | None = None) -> str:
    """R6.1: the Wave 9 cost-caveat extension when scale-to-zero is on for an
    enabled target, else ''. No idle-adjusted cost is computed (ADR-014)."""
    if (scale_to_zero or "").lower() != "true" or not target:
        return ""
    try:
        block = capability(target)
    except target_manifest.ManifestError:
        return ""
    if not block.get("enabled"):
        return ""
    ref = ref or reference()
    wake = _WAKE_COST.get(block.get("requests_at_zero", ""), "in requests")
    return ("Scale-to-zero is on: savings accrue only on idle stretches longer than the "
            "scale-in delay, and each wake costs the reference cold start "
            f"({_num(ref['recovery_mean_minutes'])} min mean, {_provenance(ref)}) {wake}. "
            "No idle-adjusted cost is computed.")


def _cli(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] in ("shell", "warning", "cost-caveat"):
        try:
            if argv[0] == "shell":
                print("\n".join(shell_assignments(argv[1])))
            elif argv[0] == "warning":
                print("\n".join(warning_lines(argv[1])))
            else:
                line = cost_caveat(argv[1], os.environ.get("SCALE_TO_ZERO"))
                if line:
                    print(line)
        except target_manifest.ManifestError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 3
        return 0
    print("usage: scale_to_zero.py shell|warning|cost-caveat <target>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Wave 10 (ADR-014 R1.3): the Python reader for the scale_to_zero descriptor block.

Asserts properties of the declared capability, not frozen per-target literals:
every target declares the block, an enabled target is native and names its
mechanism and wake signal, a disabled target carries a reason, and the CLI
one-shot (used by do/lib/scale-to-zero.sh) prints the same object.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

import target_manifest

_HERE = os.path.dirname(os.path.abspath(__file__))
_TM = os.path.normpath(os.path.join(_HERE, "..", "..", "templates", "do", "lib", "python", "target_manifest.py"))
_KEYS = {"support", "mechanism", "wake_signal", "requests_at_zero", "idle_billing", "enabled"}


@pytest.mark.parametrize("target", target_manifest.list_targets())
def test_every_target_declares_the_block(target: str) -> None:
    block = target_manifest.scale_to_zero(target)
    assert _KEYS <= set(block), f"{target}: missing {_KEYS - set(block)}"
    assert isinstance(block["enabled"], bool)
    if block["enabled"]:
        assert block["support"] == "native"
        assert block["mechanism"] and block["wake_signal"]
    else:
        assert block.get("reason"), f"{target}: a disabled target explains why"


def test_at_least_one_target_is_enabled_and_one_refused() -> None:
    blocks = [target_manifest.scale_to_zero(t) for t in target_manifest.list_targets()]
    assert any(b["enabled"] for b in blocks)
    assert any(not b["enabled"] for b in blocks)


@pytest.mark.parametrize("target", target_manifest.list_targets())
def test_cli_prints_the_accessor_value(target: str) -> None:
    out = subprocess.run([sys.executable, _TM, "scale_to_zero", target],
                         capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == target_manifest.scale_to_zero(target)


def test_aliases_resolve() -> None:
    for target in target_manifest.list_targets():
        for alias in target_manifest.read_manifest(target).get("aliases", []):
            assert target_manifest.scale_to_zero(alias) == target_manifest.scale_to_zero(target)


def test_unknown_target_cli_exits_3() -> None:
    r = subprocess.run([sys.executable, _TM, "scale_to_zero", "no-such-target"],
                       capture_output=True, text=True)
    assert r.returncode == 3

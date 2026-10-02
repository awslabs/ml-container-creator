# SPDX-License-Identifier: Apache-2.0
"""ADR-008 deployment-target descriptor reader — Python unit tests (pytest only).

Wave 8 T2: exercises templates/do/lib/python/target_manifest.py — the runtime
reader (and its bash CLI shim) that lets do/ scripts read a target's contract
from targets.d/<target>/manifest.json instead of a hardcoded case block.
"""

import importlib.util
import json
import os
import subprocess
import sys

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_READER_PATH = os.path.join(
    _REPO_ROOT, "templates", "do", "lib", "python", "target_manifest.py"
)
_TARGETS_D = os.path.join(_REPO_ROOT, "templates", "do", "targets.d")

TARGETS = ["realtime-inference", "async-inference", "batch-transform",
           "hyperpod-eks", "eks"]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tm = _load("target_manifest", _READER_PATH)


def test_lists_all_five_targets():
    assert tm.list_targets(_TARGETS_D) == sorted(TARGETS)


@pytest.mark.parametrize("target,status_var,success,answer_key", [
    ("realtime-inference", "DEPLOYMENT_TARGET_SMAI_STATUS", "InService", "deploymentTargetSmaiStatus"),
    ("async-inference", "DEPLOYMENT_TARGET_ASYNC_STATUS", "InService", "deploymentTargetAsyncStatus"),
    ("batch-transform", "DEPLOYMENT_TARGET_BATCH_STATUS", "Completed", "deploymentTargetBatchStatus"),
    ("hyperpod-eks", "DEPLOYMENT_TARGET_HP_STATUS", "Running", "deploymentTargetHpStatus"),
    ("eks", "DEPLOYMENT_TARGET_EKS_STATUS", "Running", "deploymentTargetEksStatus"),
])
def test_typed_accessors(target, status_var, success, answer_key):
    assert tm.status_var(target, _TARGETS_D) == status_var
    assert tm.success_status(target, _TARGETS_D) == success
    assert tm.answer_key(target, _TARGETS_D) == answer_key


def test_alias_resolution():
    assert tm.resolve_target("managed-inference", _TARGETS_D) == "realtime-inference"
    assert tm.resolve_target("hyperpod", _TARGETS_D) == "hyperpod-eks"
    assert tm.resolve_target("async", _TARGETS_D) == "async-inference"
    assert tm.resolve_target("batch", _TARGETS_D) == "batch-transform"
    # canonical name resolves to itself; unknown passes through
    assert tm.resolve_target("eks", _TARGETS_D) == "eks"
    assert tm.resolve_target("bogus", _TARGETS_D) == "bogus"


def test_read_manifest_by_alias():
    m = tm.read_manifest("managed-inference", _TARGETS_D)
    assert m["target"] == "realtime-inference"


def test_unknown_target_raises():
    with pytest.raises(tm.ManifestNotFound):
        tm.read_manifest("does-not-exist", _TARGETS_D)


def test_runtime_owned_vars_include_status_var():
    for t in TARGETS:
        rov = tm.runtime_owned_vars(t, _TARGETS_D)
        assert tm.status_var(t, _TARGETS_D) in rov


# ── CLI shim (what bash calls) ─────────────────────────────────────────────────

def _cli(*args):
    return subprocess.run(
        [sys.executable, _READER_PATH, *args],
        capture_output=True, text=True
    )


def test_cli_status_var():
    r = _cli("status_var", "eks")
    assert r.returncode == 0
    assert r.stdout.strip() == "DEPLOYMENT_TARGET_EKS_STATUS"


def test_cli_resolve_alias():
    r = _cli("resolve", "hyperpod")
    assert r.returncode == 0
    assert r.stdout.strip() == "hyperpod-eks"


def test_cli_array_field_is_json():
    r = _cli("runtime_owned_vars", "hyperpod-eks")
    assert r.returncode == 0
    assert "DEPLOYMENT_TARGET_HP_STATUS" in json.loads(r.stdout)


def test_cli_unknown_target_exit_3():
    r = _cli("status_var", "nope")
    assert r.returncode == 3


def test_cli_unknown_field_exit_6():
    r = _cli("bogus_field", "eks")
    assert r.returncode == 6


def test_cli_usage_exit_2():
    r = _cli("status_var")  # missing target arg
    assert r.returncode == 2

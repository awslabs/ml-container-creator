# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for do/tune dataset-management relocation (BL092, Property 7).

do/tune no longer owns dataset management:
  - `--list-datasets` is soft-deprecated: prints a hint to `do/register dataset`
    and exits 0 (no listing).
  - `--dataset hf://...` is a hard error with migration guidance directing the
    user to `do/register dataset --hf-id ...` (no silent staging/delegation).

do/tune is a plain bash script. The tests run it in an isolated sandbox with
stubbed lib sourcing (script-contract.sh, config, profile.sh) so the early flag
handling can be exercised without AWS or a real project.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

import pytest

_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
_TUNE = os.path.join(_REPO_ROOT, "templates", "do", "tune")


@pytest.fixture
def sandbox():
    root = tempfile.mkdtemp(prefix="tune-dep-")
    try:
        do = os.path.join(root, "do")
        lib = os.path.join(do, "lib")
        os.makedirs(lib)

        shutil.copy2(_TUNE, os.path.join(do, "tune"))
        os.chmod(os.path.join(do, "tune"), 0o755)

        with open(os.path.join(lib, "script-contract.sh"), "w") as fh:
            fh.write("_require_python_env(){ :; }\n_require_guard(){ :; }\n")
        with open(os.path.join(lib, "profile.sh"), "w") as fh:
            fh.write(":\n")
        with open(os.path.join(do, "config"), "w") as fh:
            fh.write(
                'PROJECT_NAME="p"\nAWS_REGION="us-west-2"\n'
                'TUNE_SUPPORTED="true"\nCORE_BUCKET="mlcc-core-1-us-west-2"\n'
            )
        # Minimal helper stub (should NOT be invoked by these paths).
        with open(os.path.join(do, ".tune_helper.py"), "w") as fh:
            fh.write("import sys; sys.exit(2)\n")
        with open(os.path.join(do, ".register_helper.py"), "w") as fh:
            fh.write("import sys; sys.exit(2)\n")

        yield os.path.join(do, "tune")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _run(tune, *args):
    return subprocess.run(["bash", tune, *args], capture_output=True, text=True)


def test_list_datasets_soft_deprecated_exits_zero(sandbox):
    r = _run(sandbox, "--list-datasets")
    combined = r.stdout + r.stderr
    assert r.returncode == 0, combined
    assert "deprecated" in combined.lower()
    assert "./do/register dataset" in combined


def test_hf_dataset_hard_errors_with_migration_guidance():
    """`--dataset hf://` hard-errors with migration guidance (no silent staging).

    The hf:// branch lives in `_validate_dataset`, which runs after model
    resolution; reaching it in a subprocess requires a full catalog + model
    fixture. This asserts at the source level that the branch (a) errors, (b)
    directs the user to `do/register dataset --hf-id`, and (c) no longer stages
    HuggingFace datasets inline.
    """
    src = open(_TUNE, encoding="utf-8").read()

    # The hf:// branch must be a hard error with migration guidance.
    assert 'is no longer supported' in src
    assert './do/register dataset <name> --hf-id' in src
    # The old inline staging (stage-hf delegation) must be gone from tune.
    assert 'Staging Hugging Face dataset' not in src
    assert 'stage-hf' not in src

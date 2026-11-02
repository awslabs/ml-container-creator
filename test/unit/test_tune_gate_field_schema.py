# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL129 do/tune Gate — field-schema half (task 7.1).

Feature: v2-w3-01-bl129

do/tune is PLAIN bash (no EJS). This test extracts the `_validate_rl_field_schema`
function from templates/do/tune, sources it into a sandbox with a stubbed `aws` (that
drops a crafted parquet) and a real lib/python/tune_manifest.py + tune.d descriptors,
and drives the Gate's field-schema check. Asserts:
  - a parquet MISSING a required verl field (reward_model) fails fast naming it
  - a valid verl 5-field parquet passes
  - mtrl (unverified contract → required_dataset_fields == []) is format-checked ONLY
    (field check skipped), even on a parquet missing verl fields
  - pipefail safety: the function body runs under `set -o pipefail` without a silent
    SIGPIPE abort

Offline: stubs aws; builds parquet fixtures with pyarrow (skip if unavailable).
"""

import os
import re
import shutil
import subprocess
import tempfile

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_TUNE_PATH = os.path.join(_REPO_ROOT, "templates", "do", "tune")
_LIB_PY = os.path.join(_REPO_ROOT, "templates", "do", "lib", "python")
_TUNE_D = os.path.join(_REPO_ROOT, "templates", "code", "tune.d")


def _extract_function(src_text, name):
    """Extract a top-level bash function `name() { ... }` by brace-matching."""
    start = src_text.index(f"{name}() {{")
    depth = 0
    i = src_text.index("{", start)
    for j in range(i, len(src_text)):
        c = src_text[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src_text[start:j + 1]
    raise AssertionError(f"unbalanced braces extracting {name}")


@pytest.fixture(scope="module")
def func_src():
    with open(_TUNE_PATH, encoding="utf-8") as f:
        text = f.read()
    return _extract_function(text, "_validate_rl_field_schema")


def _write_parquet(path, rows):
    pq.write_table(pa.Table.from_pylist(rows), path)


def _run_gate(func_src, sandbox, sample_object, technique):
    """Source the extracted function in a sandbox and invoke it. Returns CompletedProcess.

    The sandbox provides:
      - SCRIPT_DIR with a lib/python/tune_manifest.py + tune.d copy (so the reader
        resolves the committed descriptors),
      - a stubbed `aws` on PATH that copies a pre-staged local parquet to the cp dest,
      - set -e/-u/-o pipefail to mirror do/tune's shell options (pipefail safety).
    """
    stub_bin = os.path.join(sandbox, "bin")
    os.makedirs(stub_bin, exist_ok=True)
    # aws stub: `aws s3 cp <src> <dst> ...` → copy the staged fixture to <dst>.
    aws_stub = os.path.join(stub_bin, "aws")
    with open(aws_stub, "w", encoding="utf-8") as fh:
        fh.write(
            "#!/bin/bash\n"
            'if [ "$1" = "s3" ] && [ "$2" = "cp" ]; then\n'
            '  cp "$STAGED_PARQUET" "$4"; exit $?\n'
            "fi\n"
            "exit 0\n"
        )
    os.chmod(aws_stub, 0o755)

    # Ensure the harness's bare `python3` is THIS interpreter (which has pyarrow). A
    # bare symlink breaks venv site-packages discovery (venv keys off the executable's
    # real location), so use a thin exec-wrapper that calls the real interpreter.
    import sys
    py3 = os.path.join(stub_bin, "python3")
    with open(py3, "w", encoding="utf-8") as fh:
        fh.write(f'#!/bin/bash\nexec "{sys.executable}" "$@"\n')
    os.chmod(py3, 0o755)

    harness = os.path.join(sandbox, "run.sh")
    with open(harness, "w", encoding="utf-8") as fh:
        fh.write("#!/bin/bash\nset -e\nset -u\nset -o pipefail\n")
        fh.write(f'SCRIPT_DIR="{sandbox}/do"\nAWS_REGION="us-west-2"\n')
        fh.write(func_src + "\n")
        fh.write(f'_validate_rl_field_schema "{sample_object}" "{technique}"\n')
    os.chmod(harness, 0o755)

    env = dict(os.environ)
    # The harness calls bare `python3`; make it resolve to the SAME interpreter running
    # this test (which has pyarrow — importorskip guaranteed it), so the field check
    # exercises the real pyarrow read rather than skipping. In a generated project
    # do/tune's _require_python_env activates the venv that carries pyarrow.
    import sys
    py_bin_dir = os.path.dirname(sys.executable)
    env["PATH"] = stub_bin + os.pathsep + py_bin_dir + os.pathsep + env["PATH"]
    return subprocess.run(["bash", harness], capture_output=True, text=True, env=env)


@pytest.fixture
def sandbox():
    d = tempfile.mkdtemp(prefix="mcc-gate-")
    # project do/ layout: do/lib/python/tune_manifest.py + co, do/.. /code? No — the
    # reader resolves tune.d via the MLCC source-tree candidate, so copy tune.d to the
    # repo-relative spot the reader also checks: we point it via a .mlcc/tune.d copy.
    do_dir = os.path.join(d, "do")
    os.makedirs(os.path.join(do_dir, "lib", "python"), exist_ok=True)
    for mod in ("tune_manifest.py",):
        shutil.copy(os.path.join(_LIB_PY, mod), os.path.join(do_dir, "lib", "python", mod))
    # The reader's candidate chain includes <project>/.mlcc/tune.d (project root is
    # do/../.. = sandbox). Put the descriptors there.
    shutil.copytree(_TUNE_D, os.path.join(d, ".mlcc", "tune.d"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


VALID_VERL_ROW = {
    "data_source": "gsm8k",
    "prompt": [{"role": "user", "content": "2+2?"}],
    "ability": "math",
    "reward_model": {"style": "rule", "ground_truth": "4"},
    "extra_info": {"index": 0},
}


def test_missing_reward_model_fails_fast_naming_the_field(func_src, sandbox):
    bad = {k: v for k, v in VALID_VERL_ROW.items() if k != "reward_model"}
    staged = os.path.join(sandbox, "bad.parquet")
    _write_parquet(staged, [bad])
    env_sample = "s3://bucket/datasets/d/data/train.parquet"
    os.environ["STAGED_PARQUET"] = staged
    try:
        res = _run_gate(func_src, sandbox, env_sample, "rlvr")
    finally:
        os.environ.pop("STAGED_PARQUET", None)
    assert res.returncode == 1, f"expected fail-fast; got rc={res.returncode}\n{res.stdout}\n{res.stderr}"
    assert "reward_model" in res.stdout, f"error must name the missing field:\n{res.stdout}"


def test_valid_verl_parquet_passes(func_src, sandbox):
    staged = os.path.join(sandbox, "good.parquet")
    _write_parquet(staged, [VALID_VERL_ROW])
    os.environ["STAGED_PARQUET"] = staged
    try:
        res = _run_gate(func_src, sandbox, "s3://bucket/d/data/train.parquet", "rlaif")
    finally:
        os.environ.pop("STAGED_PARQUET", None)
    assert res.returncode == 0, f"valid parquet should pass:\n{res.stdout}\n{res.stderr}"
    assert "field-schema check passed" in res.stdout


def test_mtrl_is_format_checked_only_not_field_checked(func_src, sandbox):
    # mtrl's contract is mtrl-rollout → required_dataset_fields == [] → the field check
    # is skipped even on a parquet with NO verl fields.
    staged = os.path.join(sandbox, "mtrl.parquet")
    _write_parquet(staged, [{"foo": "bar"}])
    os.environ["STAGED_PARQUET"] = staged
    try:
        res = _run_gate(func_src, sandbox, "s3://bucket/d/data/train.parquet", "mtrl")
    finally:
        os.environ.pop("STAGED_PARQUET", None)
    assert res.returncode == 0, f"mtrl must not be field-checked:\n{res.stdout}\n{res.stderr}"
    assert "reward_model" not in res.stdout

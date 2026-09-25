# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL101 Task 8.5: do/benchmark --set-baseline set / clear / latest.

Runs the real do/benchmark template against a minimal generated-project fixture
and asserts BENCHMARK_PINNED_BASELINE is written/cleared in do/config.
"""

import os
import shutil
import stat
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DO_DIR = PROJECT_ROOT / "templates" / "do"
BENCHMARK = DO_DIR / "benchmark"
SCRIPT_CONTRACT = DO_DIR / "lib" / "script-contract.sh"
PROFILE_LIB = DO_DIR / "lib" / "profile.sh"
RESOLVE_INSTANCE = DO_DIR / "lib" / "resolve-instance.sh"
RESOLVE_SERVING = DO_DIR / "lib" / "resolve-serving-config.sh"
GPU_METRICS = DO_DIR / "lib" / "python" / "benchmark_gpu_metrics.py"


def _make_project(tmp_path: Path) -> Path:
    do_dir = tmp_path / "do"
    lib_dir = do_dir / "lib"
    py_dir = lib_dir / "python"
    bin_dir = tmp_path / "bin"
    for d in (py_dir, bin_dir):
        d.mkdir(parents=True, exist_ok=True)

    shutil.copy2(BENCHMARK, do_dir / "benchmark")
    shutil.copy2(SCRIPT_CONTRACT, lib_dir / "script-contract.sh")
    shutil.copy2(PROFILE_LIB, lib_dir / "profile.sh")
    shutil.copy2(RESOLVE_INSTANCE, lib_dir / "resolve-instance.sh")
    shutil.copy2(RESOLVE_SERVING, lib_dir / "resolve-serving-config.sh")
    shutil.copy2(GPU_METRICS, py_dir / "benchmark_gpu_metrics.py")

    # Project-local venv marker so the venv guard passes.
    venv_bin = tmp_path / ".mlcc" / "hey-venv" / "bin"
    venv_bin.mkdir(parents=True, exist_ok=True)
    (venv_bin / "activate").write_text("# test venv marker\n")

    (do_dir / "config").write_text(
        "\n".join([
            'export PROJECT_NAME="sb-test"',
            'export AWS_REGION="us-east-1"',
            'export DEPLOYMENT_TARGET="realtime-inference"',
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
            'export INSTANCE_TYPE="ml.g6.24xlarge"',
            'export HF_MODEL_ID="meta-llama/Llama-3.1-8B-Instruct"',
            "",
        ])
    )

    # Stub aws so any incidental call (e.g. resolve-instance) is a no-op.
    aws = bin_dir / "aws"
    aws.write_text(
        "#!/usr/bin/env bash\n"
        "if [ \"${1:-}\" = \"--version\" ]; then echo 'aws-cli/2.31.0'; exit 0; fi\n"
        "exit 0\n"
    )
    aws.chmod(aws.stat().st_mode | stat.S_IXUSR)
    return do_dir


def _run(do_dir: Path, tmp_path: Path, *args):
    import subprocess
    env = os.environ | {
        "VIRTUAL_ENV": sys.prefix,
        "PATH": f"{tmp_path / 'bin'}:{Path(sys.executable).parent}:{os.environ['PATH']}",
    }
    return subprocess.run(
        ["bash", str(do_dir / "benchmark"), *args],
        cwd=tmp_path, env=env, text=True, capture_output=True, check=False,
    )


def _config_text(do_dir: Path) -> str:
    return (do_dir / "config").read_text()


class TestSetBaseline:
    def test_set_explicit_job(self, tmp_path):
        do_dir = _make_project(tmp_path)
        result = _run(do_dir, tmp_path, "--set-baseline", "sb-test-benchmark-20260101-000000")
        assert result.returncode == 0, result.stderr
        assert 'export BENCHMARK_PINNED_BASELINE="sb-test-benchmark-20260101-000000"' in _config_text(do_dir)

    def test_clear_removes_var(self, tmp_path):
        do_dir = _make_project(tmp_path)
        _run(do_dir, tmp_path, "--set-baseline", "some-job")
        assert "BENCHMARK_PINNED_BASELINE" in _config_text(do_dir)
        result = _run(do_dir, tmp_path, "--set-baseline", "--clear")
        assert result.returncode == 0, result.stderr
        assert "BENCHMARK_PINNED_BASELINE" not in _config_text(do_dir)

    def test_latest_resolves_from_local_dirs(self, tmp_path):
        do_dir = _make_project(tmp_path)
        # Two local benchmark result dirs; most-recent should win.
        benchdir = tmp_path / "benchmarks"
        older = benchdir / "sb-test-benchmark-20260101-000000"
        newer = benchdir / "sb-test-benchmark-20260201-000000"
        for d in (older, newer):
            (d / "output").mkdir(parents=True, exist_ok=True)
            (d / "output" / "profile_export.jsonl").write_text(
                '{"metrics":{"output_token_throughput_tps":1.0}}\n'
            )
        # Make newer actually newer on disk.
        os.utime(older, (1, 1))
        result = _run(do_dir, tmp_path, "--set-baseline", "latest")
        assert result.returncode == 0, result.stderr
        assert 'BENCHMARK_PINNED_BASELINE="sb-test-benchmark-20260201-000000"' in _config_text(do_dir)

    def test_latest_no_results_errors(self, tmp_path):
        do_dir = _make_project(tmp_path)
        result = _run(do_dir, tmp_path, "--set-baseline", "latest")
        assert result.returncode == 1
        assert "No local benchmark results" in (result.stdout + result.stderr)

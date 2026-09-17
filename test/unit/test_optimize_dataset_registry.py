"""Unit tests for do/optimize dataset registry integration (BL092).

Covers the `--dataset` flag's three input forms (raw s3://, registered name with
optional @v pinning, and hf:// passthrough), the Throughput_Guard, resolution
failure handling, and `--list-datasets`.

The tests build a minimal generated-project fixture with a stubbed `bin/aws`
(so the AWS CLI v2 check passes) and a stubbed `.register_helper.py` that records
its invocations and returns canned JSON, following the harness pattern from
test_optimize_speculative_apply.py.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
OPTIMIZE_TEMPLATE = PROJECT_ROOT / "templates" / "do" / "optimize"
SCRIPT_CONTRACT = PROJECT_ROOT / "templates" / "do" / "lib" / "script-contract.sh"


def _build_project(tmp_path: Path, resolve_s3_uri: str | None) -> tuple[Path, Path]:
    """Create a minimal do/ project fixture.

    ``resolve_s3_uri`` controls the stubbed ``.register_helper.py resolve-dataset``
    response: a value yields ``{"s3_uri": <value>}``; ``None`` yields ``{}`` (a
    not-found / empty response). The helper logs each invocation's argv to
    ``resolver_calls.log`` so tests can assert whether/how it was called.
    """
    do_dir = tmp_path / "do"
    lib_dir = do_dir / "lib"
    bin_dir = tmp_path / "bin"
    lib_dir.mkdir(parents=True)
    bin_dir.mkdir()

    optimize = do_dir / "optimize"
    shutil.copy2(OPTIMIZE_TEMPLATE, optimize)
    shutil.copy2(SCRIPT_CONTRACT, lib_dir / "script-contract.sh")
    (lib_dir / "wait.sh").write_text("#!/usr/bin/env bash\n")
    (do_dir / "config").write_text(
        "\n".join(
            [
                'export PROJECT_NAME="dataset-test"',
                'export AWS_REGION="us-east-1"',
                'export DEPLOYMENT_TARGET="realtime-inference"',
                'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
                'export MODEL_NAME="meta-llama/Llama-3.1-8B"',
                "",
            ]
        )
    )

    log_file = tmp_path / "resolver_calls.log"

    # Stubbed register helper: logs argv, returns canned resolve/list JSON.
    resolve_body = (
        f"print(json.dumps({{'s3_uri': {resolve_s3_uri!r}}}))"
        if resolve_s3_uri is not None
        else "print(json.dumps({}))"
    )
    helper = do_dir / ".register_helper.py"
    helper.write_text(
        "#!/usr/bin/env python3\n"
        "import sys, json\n"
        f"with open({str(log_file)!r}, 'a') as fh:\n"
        "    fh.write(' '.join(sys.argv[1:]) + '\\n')\n"
        "sub = sys.argv[1] if len(sys.argv) > 1 else ''\n"
        "if sub == 'resolve-dataset':\n"
        f"    {resolve_body}\n"
        "elif sub == 'list-datasets':\n"
        "    print(json.dumps({\n"
        "        'local': [{'name': 'calibration-sample', 'technique': 'sft',\n"
        "                   'latest_version': '2', 'version_count': 2,\n"
        "                   'row_count': 100, 's3_uri': 's3://reg/calibration.jsonl'}],\n"
        "        'remote': []}))\n"
        "else:\n"
        "    sys.exit(2)\n"
    )
    helper.chmod(helper.stat().st_mode | stat.S_IXUSR)

    # Stubbed aws: passes the CLI-v2 check, fails all real API calls so the
    # script stops before submitting a job (after dataset resolution).
    aws = bin_dir / "aws"
    aws.write_text(
        "#!/usr/bin/env bash\n"
        "if [ \"${1:-}\" = \"--version\" ]; then echo 'aws-cli/2.31.0'; exit 0; fi\n"
        "exit 1\n"
    )
    aws.chmod(aws.stat().st_mode | stat.S_IXUSR)

    return optimize, log_file


def _run(optimize: Path, tmp_path: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    environment = os.environ | {
        "VIRTUAL_ENV": sys.prefix,
        "PATH": f"{bin_dir}:{Path(sys.executable).parent}:{os.environ['PATH']}",
    }
    return subprocess.run(
        ["bash", str(optimize), *args],
        cwd=tmp_path,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


def test_raw_s3_uri_passthrough_no_resolver_call(tmp_path: Path):
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri=None)
    result = _run(optimize, tmp_path, ["--goal", "throughput", "--dataset", "s3://my-bucket/calibration.jsonl"])

    combined = result.stdout + result.stderr
    # Raw s3:// must not be sent to the resolver.
    assert not log_file.exists(), combined
    # Not rejected by the s3-only validation.
    assert "must be an s3:// URI" not in combined


def test_named_dataset_resolves_via_resolve_dataset(tmp_path: Path):
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri="s3://reg/calibration.jsonl")
    result = _run(optimize, tmp_path, ["--goal", "throughput", "--dataset", "calibration-sample"])

    combined = result.stdout + result.stderr
    assert log_file.exists(), combined
    calls = log_file.read_text()
    assert "resolve-dataset --name calibration-sample" in calls
    assert "--version" not in calls
    assert "Resolved to: s3://reg/calibration.jsonl" in combined


def test_version_pinned_ordinal_and_semver(tmp_path: Path):
    # Ordinal @v2
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri="s3://reg/v2.jsonl")
    result = _run(optimize, tmp_path, ["--goal", "throughput", "--dataset", "calibration-sample@v2"])
    assert log_file.read_text().strip().splitlines()[0] == "resolve-dataset --name calibration-sample --version 2", (
        result.stdout + result.stderr
    )

    # Semver @v1.0.0 (fresh project so the log starts empty)
    optimize2, log_file2 = _build_project(tmp_path / "semver", resolve_s3_uri="s3://reg/v1.jsonl")
    result2 = _run(optimize2, tmp_path / "semver", ["--goal", "throughput", "--dataset", "calibration-sample@v1.0.0"])
    assert log_file2.read_text().strip().splitlines()[0] == "resolve-dataset --name calibration-sample --version 1.0.0", (
        result2.stdout + result2.stderr
    )


def test_dataset_with_latency_goal_exits_before_resolver(tmp_path: Path):
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri="s3://reg/x.jsonl")
    result = _run(optimize, tmp_path, ["--goal", "latency", "--dataset", "calibration-sample"])

    assert result.returncode != 0
    combined = result.stdout + result.stderr
    assert "only with --goal throughput" in combined
    # Throughput_Guard fires before any resolver call.
    assert not log_file.exists(), combined


def test_dataset_with_cost_goal_exits_before_resolver(tmp_path: Path):
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri="s3://reg/x.jsonl")
    result = _run(optimize, tmp_path, ["--goal", "cost", "--dataset", "calibration-sample"])

    assert result.returncode != 0
    assert not log_file.exists()


def test_hf_reference_passthrough_no_resolver_no_s3_check(tmp_path: Path):
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri=None)
    result = _run(optimize, tmp_path, ["--goal", "throughput", "--dataset", "hf://my-org/calibration-data"])

    combined = result.stdout + result.stderr
    assert not log_file.exists(), combined
    assert "must be an s3:// URI" not in combined


def test_resolution_failure_prints_guidance_and_exits_nonzero(tmp_path: Path):
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri=None)  # empty s3_uri
    result = _run(optimize, tmp_path, ["--goal", "throughput", "--dataset", "missing-dataset"])

    assert result.returncode != 0
    combined = result.stdout + result.stderr
    assert "Could not resolve dataset 'missing-dataset'" in combined
    assert "./do/optimize --list-datasets" in combined
    assert log_file.exists()


def test_list_datasets_lists_and_exits_zero(tmp_path: Path):
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri=None)
    result = _run(optimize, tmp_path, ["--list-datasets"])

    assert result.returncode == 0, result.stdout + result.stderr
    combined = result.stdout + result.stderr
    assert "Registered datasets" in combined
    assert "calibration-sample" in combined
    assert "list-datasets" in log_file.read_text()


def test_list_datasets_with_goal_lists_and_exits_zero(tmp_path: Path):
    optimize, log_file = _build_project(tmp_path, resolve_s3_uri=None)
    result = _run(optimize, tmp_path, ["--list-datasets", "--goal", "throughput"])

    # --list-datasets wins over --goal, no mutual-exclusion error.
    assert result.returncode == 0, result.stdout + result.stderr
    assert "calibration-sample" in result.stdout + result.stderr


def test_list_datasets_missing_helper_is_nonfatal(tmp_path: Path):
    optimize, _ = _build_project(tmp_path, resolve_s3_uri=None)
    # Remove the helper to simulate an unavailable registry.
    (tmp_path / "do" / ".register_helper.py").unlink()
    result = _run(optimize, tmp_path, ["--list-datasets"])

    assert result.returncode == 0, result.stdout + result.stderr
    assert "(none)" in result.stdout + result.stderr

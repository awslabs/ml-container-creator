# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL165 (Wave 6 R9 / R8.6): seeded helper failures surface, not swallow.

The BL165 sweep replaced `2>/dev/null` on PRIMARY operations in do/register and
do/benchmark with capture-and-surface, and narrowed bare `except Exception`
blocks in their Python helpers so NameError / AttributeError (programming
errors) are never swallowed as "best-effort" (the BL172 lesson).

Each test SEEDS a failure in a stubbed helper / aws binary and asserts the
script reports a structured error (non-zero exit + the helper's real stderr /
{"error","code"} JSON) instead of the old silent no-op or misleading message.
Also carries the BL171 (hub-content-name sanitizer warning visibility) and
BL172 (TAG_DELETED / --delete no-op) regression classes.

Sandboxes follow test_register_dataset_paths.py (render do/register via EJS,
stub lib + helpers) and test_bl101_set_baseline.py (copy do/benchmark + real
lib files into a tmp project). All offline: no AWS, no MLflow.
"""
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DO_DIR = PROJECT_ROOT / "templates" / "do"
REGISTER_TEMPLATE = DO_DIR / "register"
BENCHMARK = DO_DIR / "benchmark"
LIB_DIR = DO_DIR / "lib"

_CORE_BUCKET = "mlcc-core-111122223333-us-west-2"

# A NameError traceback a buggy helper would print (the BL172 shape).
_NAMEERROR_TRACEBACK = (
    "Traceback (most recent call last):\n"
    '  File "helper.py", line 42, in main\n'
    "NameError: name 'TAG_DELETED' is not defined\n"
)


def _write_exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


# ════════════════════════════════════════════════════════════════════════════
# do/register
# ════════════════════════════════════════════════════════════════════════════

_RENDER_VARS = {
    "projectName": "testproj",
    "deploymentConfig": "transformers-vllm",
    "framework": "transformers",
    "modelServer": "vllm",
    "awsRegion": "us-west-2",
    "buildTarget": "codebuild",
    "deploymentTarget": "realtime-inference",
    "instanceType": "ml.g5.xlarge",
    "modelName": "meta-llama/Llama-3-8B",
    "modelFormat": None,
    "modelEnvVars": {},
    "serverEnvVars": {},
    "orderedEnvVars": [],
    "baseImage": "vllm/vllm-openai:v0.8.5",
    "roleArn": "arn:aws:iam::111122223333:role/SageMakerRole",
    "icCpuCount": None,
    "icMemorySize": None,
    "icGpuCount": 1,
    "icCopyCount": 1,
    "icModelWeight": None,
    "endpointInitialInstanceCount": None,
    "endpointDataCapturePercent": None,
    "endpointVariantName": None,
    "endpointVolumeSize": None,
    "inferenceAmiVersion": None,
    "hfToken": None,
    "hfTokenArn": None,
    "ngcTokenArn": None,
    "ngcApiKey": None,
}


@pytest.fixture(scope="module")
def rendered_register():
    if shutil.which("node") is None:
        pytest.skip("node is required to render the register template")
    node_script = (
        "const ejs=require('ejs');const fs=require('fs');"
        "const t=fs.readFileSync(process.argv[1],'utf8');"
        "process.stdout.write(ejs.render(t,JSON.parse(process.argv[2])));"
    )
    r = subprocess.run(
        ["node", "-e", node_script, str(REGISTER_TEMPLATE), json.dumps(_RENDER_VARS)],
        cwd=PROJECT_ROOT, capture_output=True, text=True,
    )
    if r.returncode != 0:
        pytest.skip(f"Could not render register template (node/ejs missing?): {r.stderr}")
    return r.stdout


class _RegisterSandbox:
    def __init__(self, root: Path, rendered: str):
        self.root = root
        self.do = root / "do"
        self.bin = root / "bin"
        (self.do / "lib").mkdir(parents=True)
        self.bin.mkdir()
        _write_exec(self.do / "register", rendered)
        (self.do / "lib" / "script-contract.sh").write_text(
            "_require_python_env(){ :; }\n_require_guard(){ :; }\n"
        )
        for name in ("profile.sh", "resolve-instance.sh"):
            (self.do / "lib" / name).write_text(":\n")
        (self.do / "config").write_text(
            'PROJECT_NAME="testproj"\n'
            'AWS_REGION="us-west-2"\n'
            'DEPLOYMENT_CONFIG="transformers-vllm"\n'
            'DEPLOYMENT_TARGET="realtime-inference"\n'
            'BUILD_TARGET="codebuild"\n'
            'GENERATOR_VERSION="0.0.0"\n'
            f'CORE_BUCKET="{_CORE_BUCKET}"\n'
        )
        _write_exec(self.bin / "aws", "#!/bin/bash\nexit 0\n")

    def helper(self, body: str) -> None:
        """Install a .register_helper.py stub."""
        (self.do / ".register_helper.py").write_text(body)

    def run(self, *args):
        env = dict(os.environ)
        env["PATH"] = f"{self.bin}{os.pathsep}{env['PATH']}"
        return subprocess.run(
            [str(self.do / "register"), *args],
            capture_output=True, text=True, env=env,
        )


@pytest.fixture
def reg(rendered_register, tmp_path):
    return _RegisterSandbox(tmp_path, rendered_register)


# A helper that crashes with a programming error and prints NO JSON.
_CRASHING_HELPER = (
    "import sys\n"
    f"sys.stderr.write({_NAMEERROR_TRACEBACK!r})\n"
    "sys.exit(1)\n"
)

# A helper that fails with the repo's structured {"error","code"} contract.
_STRUCTURED_FAILING_HELPER = (
    "import sys, json\n"
    "print(json.dumps({'error': 'Could not write dataset sidecar: AccessDenied',"
    " 'code': 'SIDECAR_WRITE_FAILED'}))\n"
    "sys.stderr.write('botocore.exceptions.ClientError: AccessDenied (PutObject)\\n')\n"
    "sys.exit(1)\n"
)


class TestRegisterSurfacesHelperFailures:
    def test_list_failure_is_not_a_silent_none(self, reg):
        # Before BL165: `2>/dev/null || _ds_output=""` → printed "(none)", exit 0.
        reg.helper(_CRASHING_HELPER)
        r = reg.run("dataset", "--list")
        out = r.stdout + r.stderr
        assert r.returncode != 0, out
        assert "Could not list registered datasets" in out
        assert "NameError: name 'TAG_DELETED' is not defined" in out
        assert "(none)" not in r.stdout

    def test_register_dataset_failure_surfaces_structured_error(self, reg):
        # Before BL165: stderr discarded and JSON ignored → "❌ Dataset registration failed".
        reg.helper(_STRUCTURED_FAILING_HELPER)
        r = reg.run("dataset", "alpaca", "--s3-uri", "s3://src/data.jsonl",
                    "--technique", "sft")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "Dataset registration failed: Could not write dataset sidecar: AccessDenied" in out
        assert "code: SIDECAR_WRITE_FAILED" in out
        assert "ClientError: AccessDenied (PutObject)" in out

    def test_list_versions_crash_is_not_reported_as_not_found(self, reg):
        # Before BL165: stderr captured then deleted → "❌ Dataset not found: x".
        reg.helper(_CRASHING_HELPER)
        r = reg.run("dataset", "--list-versions", "alpaca")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "NameError" in out
        assert "Dataset not found" not in out

    def test_delete_failure_surfaces_helper_stderr(self, reg):
        reg.helper(_CRASHING_HELPER)
        r = reg.run("dataset", "--delete", "alpaca", "--force")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "Delete failed for alpaca" in out
        assert "NameError" in out


class TestRegisterBestEffortWarningsVisible:
    """BL171/BL172 classes: a best-effort sub-step's warning must reach the user."""

    def test_bl171_native_registry_warning_reaches_user(self, reg):
        # BL171: the native AI Registry rejected an underscore name; the helper
        # degraded to a warning but do/register's `2>/dev/null` hid it, so the
        # dataset silently never appeared in Studio Assets.
        reg.helper(
            "import sys, json\n"
            "sys.stderr.write('\\u26a0\\ufe0f  Native AI Registry registration failed "
            "(ValidationException: hubContentName must match [a-zA-Z0-9](-*[a-zA-Z0-9]){0,62})\\n')\n"
            "print(json.dumps({'name': 'Intel_orca_dpo', 'registered': True, 'arn': None}))\n"
        )
        r = reg.run("dataset", "Intel_orca_dpo", "--s3-uri", "s3://src/data.jsonl",
                    "--technique", "dpo")
        assert r.returncode == 0, r.stdout + r.stderr
        assert "Native AI Registry registration failed" in r.stderr
        assert "hubContentName" in r.stderr
        assert "Dataset registered successfully" in r.stdout

    def test_bl172_delete_mlflow_skip_warning_reaches_user(self, reg):
        # BL172: the MLflow soft-delete silently did nothing. Even on a
        # "successful" delete, the helper's best-effort warning must be shown.
        reg.helper(
            "import sys, json\n"
            "sys.stderr.write('\\u26a0\\ufe0f  MLflow soft-delete tagging skipped (boom)\\n')\n"
            "print(json.dumps({'name': 'alpaca', 'deleted': True, 'scope': 'dataset'}))\n"
        )
        r = reg.run("dataset", "--delete", "alpaca", "--force")
        assert r.returncode == 0, r.stdout + r.stderr
        assert "MLflow soft-delete tagging skipped" in r.stderr
        assert "Deregistered" in r.stdout


# ════════════════════════════════════════════════════════════════════════════
# do/benchmark
# ════════════════════════════════════════════════════════════════════════════

_AWS_STUB_ACCESS_DENIED = """#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then echo 'aws-cli/2.31.0'; exit 0; fi
for a in "$@"; do
  if [ "$a" = "describe-ai-benchmark-job" ]; then
    echo "An error occurred (AccessDeniedException) when calling the DescribeAIBenchmarkJob operation: not authorized" >&2
    exit 254
  fi
done
exit 0
"""


class _BenchmarkSandbox:
    def __init__(self, root: Path):
        self.root = root
        self.do = root / "do"
        self.bin = root / "bin"
        self.home = root / "home"
        py_dir = self.do / "lib" / "python"
        for d in (py_dir, self.bin, self.home / ".ml-container-creator"):
            d.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BENCHMARK, self.do / "benchmark")
        for name in ("script-contract.sh", "profile.sh", "resolve-instance.sh",
                     "resolve-serving-config.sh"):
            shutil.copy2(LIB_DIR / name, self.do / "lib" / name)
        shutil.copy2(LIB_DIR / "python" / "benchmark_gpu_metrics.py",
                     py_dir / "benchmark_gpu_metrics.py")
        venv_bin = root / ".mlcc" / "hey-venv" / "bin"
        venv_bin.mkdir(parents=True, exist_ok=True)
        (venv_bin / "activate").write_text("# test venv marker\n")
        self.config_lines = [
            'export PROJECT_NAME="sb-test"',
            'export AWS_REGION="us-east-1"',
            'export DEPLOYMENT_TARGET="realtime-inference"',
            'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
            'export INSTANCE_TYPE="ml.g6.24xlarge"',
            'export HF_MODEL_ID="meta-llama/Llama-3.1-8B-Instruct"',
        ]
        self.write_config()
        _write_exec(self.bin / "aws",
                    "#!/usr/bin/env bash\n"
                    "if [ \"${1:-}\" = \"--version\" ]; then echo 'aws-cli/2.31.0'; exit 0; fi\n"
                    "exit 0\n")

    def write_config(self, *extra):
        self.config_lines.extend(extra)
        (self.do / "config").write_text("\n".join(self.config_lines) + "\n")

    def profile(self, **fields):
        (self.home / ".ml-container-creator" / "config.json").write_text(json.dumps(
            {"activeProfile": "default", "profiles": {"default": fields}}
        ))

    def run(self, *args):
        env = os.environ | {
            "HOME": str(self.home),
            "VIRTUAL_ENV": sys.prefix,
            "PATH": f"{self.bin}:{Path(sys.executable).parent}:{os.environ['PATH']}",
        }
        return subprocess.run(
            ["bash", str(self.do / "benchmark"), *args],
            cwd=self.root, env=env, text=True, capture_output=True, check=False,
        )


@pytest.fixture
def bench(tmp_path):
    return _BenchmarkSandbox(tmp_path)


class TestBenchmarkSurfacesHelperFailures:
    def test_recommend_engine_crash_is_not_no_history(self, bench):
        # Before BL165: `_run_athena_recommendations 2>/dev/null || ""` →
        # "No benchmark history available", exit 0, for ANY failure.
        bench.profile(ciBenchmarkResultsBucket="bench-results-bucket")
        (bench.do / ".optimize_engine.py").write_text(
            "import sys\n"
            f"sys.stderr.write({_NAMEERROR_TRACEBACK!r})\n"
            "sys.exit(1)\n"
        )
        r = bench.run("--recommend", "--no-bedrock")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "recommendation query failed" in out
        assert "NameError: name 'TAG_DELETED' is not defined" in out
        assert "No benchmark history available" not in out

    def test_recommend_structured_engine_error_is_surfaced(self, bench):
        bench.profile(ciBenchmarkResultsBucket="bench-results-bucket")
        (bench.do / ".optimize_engine.py").write_text(
            "import sys, json\n"
            "print(json.dumps({'error': 'Athena query failed: AccessDeniedException'}))\n"
            "sys.exit(1)\n"
        )
        r = bench.run("--recommend", "--no-bedrock")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "Athena query failed: AccessDeniedException" in out

    def test_recommend_success_path_unchanged_and_warnings_visible(self, bench):
        # Happy path still exits 0 and renders; engine warnings (e.g. a degraded
        # Athena poll) that used to be discarded are now shown on stderr.
        bench.profile(ciBenchmarkResultsBucket="bench-results-bucket")
        (bench.do / ".optimize_engine.py").write_text(
            "import sys, json\n"
            "sys.stderr.write('Athena query timed out after 30s\\n')\n"
            "print(json.dumps({'status': 'ok', 'model_name': 'm', 'instance_type': 'i',"
            " 'match_level': 'none', 'recommendations': []}))\n"
        )
        r = bench.run("--recommend", "--no-bedrock")
        assert r.returncode == 0, r.stdout + r.stderr
        assert "No recommendations available" in r.stdout
        assert "Athena query timed out after 30s" in r.stderr

    def test_recommend_missing_bucket_reason_is_visible(self, bench):
        # The function's own guidance used to be discarded with its stderr.
        bench.profile()  # no ciBenchmarkResultsBucket
        r = bench.run("--recommend", "--no-bedrock")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "No benchmark results bucket configured" in out

    def test_status_describe_error_shows_real_cause(self, bench):
        bench.write_config('export BENCHMARK_JOB_NAME="sb-test-benchmark-20260101-000000"')
        _write_exec(bench.bin / "aws", _AWS_STUB_ACCESS_DENIED)
        r = bench.run("--status")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "Status: Unknown" in out
        assert "AccessDeniedException" in out

    def test_dataset_resolve_failure_surfaces_resolver_error(self, bench):
        # Before BL165: resolve-dataset stderr discarded → generic "may not exist".
        bench.profile(benchmarkS3Bucket="bench-out-bucket",
                      codebuildSourceS3Bucket=_CORE_BUCKET)
        (bench.do / ".register_helper.py").write_text(
            "import sys, json\n"
            "print(json.dumps({'error': 'Could not read dataset sidecar: AccessDenied',"
            " 'code': 'SIDECAR_READ_FAILED'}))\n"
            "sys.stderr.write('botocore.exceptions.ClientError: AccessDenied (GetObject)\\n')\n"
            "sys.exit(1)\n"
        )
        r = bench.run("--dataset", "my-traffic")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "Could not resolve dataset 'my-traffic'" in out
        assert "SIDECAR_READ_FAILED" in out
        assert "ClientError: AccessDenied (GetObject)" in out

    def test_corrupt_profile_reason_is_reported(self, bench):
        # The profile reader's bare `except:` (R9.2) hid WHY the profile was empty.
        (bench.home / ".ml-container-creator" / "config.json").write_text("{not json")
        r = bench.run("--dataset", "my-traffic")
        out = r.stdout + r.stderr
        assert r.returncode == 1, out
        assert "Could not read active profile" in out
        assert "No benchmark S3 bucket recorded in profile" in out


# ════════════════════════════════════════════════════════════════════════════
# Python helpers — R9.2 (programming errors are not swallowed) + BL172
# ════════════════════════════════════════════════════════════════════════════

import mlcc_mlflow  # noqa: E402  (lib/python on sys.path via conftest)
import register_dataset  # noqa: E402


class TestBL172TagDeletedRegression:
    def test_tag_deleted_constant_is_defined(self):
        # BL172 root cause: TAG_DELETED was referenced but never defined.
        assert isinstance(mlcc_mlflow.TAG_DELETED, str) and mlcc_mlflow.TAG_DELETED

    def test_soft_delete_tags_only_matching_dataset_runs(self, monkeypatch):
        # BL172: the soft-delete was a silent no-op. Assert it actually tags.
        def _run(run_id, ds_name):
            ds = MagicMock()
            ds.name = ds_name
            di = MagicMock()
            di.dataset = ds
            run = MagicMock()
            run.info.run_id = run_id
            run.inputs.dataset_inputs = [di]
            return run

        runs = {"r1": _run("r1", "alpaca"), "r2": _run("r2", "other")}
        client = MagicMock()
        fake_mlflow = MagicMock()
        fake_mlflow.get_run.side_effect = lambda rid: runs[rid]
        monkeypatch.setitem(sys.modules, "mlflow", fake_mlflow)
        monkeypatch.setattr(mlcc_mlflow, "_resolve_experiment_ids",
                            lambda **kw: ["1"])
        monkeypatch.setattr(mlcc_mlflow, "_search_runs",
                            lambda **kw: list(runs.values()))

        mlcc_mlflow.tag_dataset_runs_deleted("alpaca", client=client)

        client.set_tag.assert_called_once_with("r1", mlcc_mlflow.TAG_DELETED, "true")

    def test_soft_delete_programming_error_is_not_swallowed(self, monkeypatch):
        # R9.2: the BL172 NameError must now propagate, not vanish.
        monkeypatch.setitem(sys.modules, "mlflow", MagicMock())

        def _boom(**kw):
            raise NameError("name 'TAG_DELETED' is not defined")

        monkeypatch.setattr(mlcc_mlflow, "_resolve_experiment_ids", _boom)
        with pytest.raises(NameError):
            mlcc_mlflow.tag_dataset_runs_deleted("alpaca", client=MagicMock())

    def test_soft_delete_transient_error_still_tolerated(self, monkeypatch):
        # Best-effort contract preserved for genuine runtime/transport errors.
        monkeypatch.setitem(sys.modules, "mlflow", MagicMock())

        def _transient(**kw):
            raise ConnectionError("MLflow App unreachable")

        monkeypatch.setattr(mlcc_mlflow, "_resolve_experiment_ids", _transient)
        assert mlcc_mlflow.tag_dataset_runs_deleted("alpaca", client=MagicMock()) is None


class TestRegisterDatasetBestEffortNarrowing:
    def test_native_registration_transient_failure_degrades_to_warning(
            self, monkeypatch, capsys):
        import ai_registry_native
        monkeypatch.setattr(ai_registry_native, "resolve_training_role", lambda: None)
        monkeypatch.setattr(ai_registry_native, "resolve_domain_id", lambda: None)

        def _fail(**kw):
            raise RuntimeError("ValidationException: hubContentName invalid")

        monkeypatch.setattr(ai_registry_native, "register_dataset_native", _fail)
        arn, info = register_dataset._register_dataset_native(
            name="Intel_orca_dpo", s3_uri="s3://b/k.jsonl", technique="dpo",
            region="us-west-2", description=None, custom_metadata={},
        )
        assert (arn, info) == (None, None)
        assert "Native AI Registry registration failed" in capsys.readouterr().err

    def test_native_registration_programming_error_propagates(self, monkeypatch):
        import ai_registry_native
        monkeypatch.setattr(ai_registry_native, "resolve_training_role", lambda: None)
        monkeypatch.setattr(ai_registry_native, "resolve_domain_id", lambda: None)

        def _bug(**kw):
            raise AttributeError("'NoneType' object has no attribute 'arn'")

        monkeypatch.setattr(ai_registry_native, "register_dataset_native", _bug)
        with pytest.raises(AttributeError):
            register_dataset._register_dataset_native(
                name="x", s3_uri="s3://b/k.jsonl", technique="sft",
                region="us-west-2", description=None, custom_metadata={},
            )

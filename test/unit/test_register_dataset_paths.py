# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for `do/register dataset` — S3 and HuggingFace staging paths.

`do/register` is an EJS template. These tests render it to bash once, then run
the rendered `dataset` subcommand in an isolated sandbox with stubbed external
commands so both input paths can be exercised without touching AWS:

  --s3-uri <s3://...>  → copies the dataset to the canonical MLCC location
                         (s3://<CORE_BUCKET>/datasets/<name>/) with `aws s3 cp`
                         (or `aws s3 sync` for a directory/prefix), then registers.
  --hf-id <org/name>   → stages via the stage-hf Processing Job (delegated to the
                         tune helper), then registers the resulting canonical URI.

The `aws` binary and both Python helpers (.register_helper.py / .tune_helper.py)
are replaced with lightweight stubs that record their invocations.
"""

import json
import os
import shutil
import subprocess
import tempfile

import pytest

_REPO_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..")
)
_TEMPLATE_PATH = os.path.join(_REPO_ROOT, "templates", "do", "register")

_CORE_BUCKET = "mlcc-core-111122223333-us-west-2"

# Template variables sufficient to render the register template for a
# real-time inference project.
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


def _render_register_template() -> str:
    """Render the do/register EJS template to bash using node + ejs."""
    node_script = (
        "const ejs=require('ejs');const fs=require('fs');"
        "const t=fs.readFileSync(process.argv[1],'utf8');"
        "const vars=JSON.parse(process.argv[2]);"
        "process.stdout.write(ejs.render(t,vars));"
    )
    result = subprocess.run(
        ["node", "-e", node_script, _TEMPLATE_PATH, json.dumps(_RENDER_VARS)],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"Could not render register template (node/ejs missing?): {result.stderr}")
    return result.stdout


@pytest.fixture(scope="module")
def rendered_register():
    if shutil.which("node") is None:
        pytest.skip("node is required to render the register template")
    return _render_register_template()


# Stub helpers ---------------------------------------------------------------

_AWS_STUB = """#!/bin/bash
echo "$*" >> "$AWS_LOG"
exit 0
"""

# .register_helper.py stub: echoes back the --name/--s3-uri it received as JSON,
# preceded by a noise line to exercise the `grep -E '^{'` extraction.
_REGISTER_HELPER_STUB = """import sys, json
argv = sys.argv
name = argv[argv.index("--name") + 1] if "--name" in argv else ""
s3 = argv[argv.index("--s3-uri") + 1] if "--s3-uri" in argv else ""
tech = argv[argv.index("--technique") + 1] if "--technique" in argv else ""
rows = argv[argv.index("--row-count") + 1] if "--row-count" in argv else ""
with open(sys.argv[0] + ".log", "a") as fh:
    fh.write(" ".join(argv[1:]) + "\\n")
print("registering...")
print(json.dumps({"name": name, "s3_uri": s3, "technique": tech,
                  "row_count": rows, "version": 1}))
"""

# .tune_helper.py stub: only implements stage-hf. Returns a staged URI under the
# provided --output-bucket and records the args it received.
_TUNE_HELPER_STUB = """import sys, json
argv = sys.argv
assert argv[1] == "stage-hf", argv
with open(sys.argv[0] + ".log", "a") as fh:
    fh.write(" ".join(argv[1:]) + "\\n")
ob = argv[argv.index("--output-bucket") + 1]
name = argv[argv.index("--hf-name") + 1]
take = argv[argv.index("--take") + 1] if "--take" in argv else "0"
print(json.dumps({"s3_uri": f"s3://{ob}/datasets/{name}/data.jsonl",
                  "num_records": int(take) if take.isdigit() else 500}))
"""


class _Sandbox:
    """A rendered do/register in an isolated dir with stubbed dependencies."""

    def __init__(self, root: str):
        self.root = root
        self.do = os.path.join(root, "do")
        self.bin = os.path.join(root, "bin")
        self.aws_log = os.path.join(root, "aws.log")

    def run_dataset(self, *args):
        env = dict(os.environ)
        env["PATH"] = self.bin + os.pathsep + env["PATH"]
        env["AWS_LOG"] = self.aws_log
        return subprocess.run(
            [os.path.join(self.do, "register"), "dataset", *args],
            capture_output=True,
            text=True,
            env=env,
        )

    def aws_calls(self):
        if not os.path.exists(self.aws_log):
            return []
        with open(self.aws_log) as fh:
            return [ln.strip() for ln in fh if ln.strip()]

    def helper_calls(self, helper: str):
        log = os.path.join(self.do, f"{helper}.log")
        if not os.path.exists(log):
            return []
        with open(log) as fh:
            return [ln.strip() for ln in fh if ln.strip()]


@pytest.fixture
def sandbox(rendered_register):
    root = tempfile.mkdtemp(prefix="register-ds-")
    try:
        do = os.path.join(root, "do")
        lib = os.path.join(do, "lib")
        bindir = os.path.join(root, "bin")
        os.makedirs(lib)
        os.makedirs(bindir)

        # Rendered script under test
        reg = os.path.join(do, "register")
        with open(reg, "w") as fh:
            fh.write(rendered_register)
        os.chmod(reg, 0o755)

        # lib stubs sourced by the script
        with open(os.path.join(lib, "script-contract.sh"), "w") as fh:
            fh.write("_require_python_env(){ :; }\n_require_guard(){ :; }\n")
        for name in ("profile.sh", "resolve-instance.sh"):
            with open(os.path.join(lib, name), "w") as fh:
                fh.write(":\n")

        # do/config sourced by the script — provides required vars + CORE_BUCKET
        with open(os.path.join(do, "config"), "w") as fh:
            fh.write(
                'PROJECT_NAME="testproj"\n'
                'AWS_REGION="us-west-2"\n'
                'DEPLOYMENT_CONFIG="transformers-vllm"\n'
                'DEPLOYMENT_TARGET="realtime-inference"\n'
                'BUILD_TARGET="codebuild"\n'
                'GENERATOR_VERSION="0.0.0"\n'
                f'CORE_BUCKET="{_CORE_BUCKET}"\n'
            )

        # aws stub on PATH
        aws = os.path.join(bindir, "aws")
        with open(aws, "w") as fh:
            fh.write(_AWS_STUB)
        os.chmod(aws, 0o755)

        # Python helper stubs next to the script
        with open(os.path.join(do, ".register_helper.py"), "w") as fh:
            fh.write(_REGISTER_HELPER_STUB)
        with open(os.path.join(do, ".tune_helper.py"), "w") as fh:
            fh.write(_TUNE_HELPER_STUB)

        yield _Sandbox(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ── S3 path ──────────────────────────────────────────────────────────────────


class TestS3Path:
    def test_single_object_uses_cp_and_registers_canonical(self, sandbox):
        r = sandbox.run_dataset(
            "alpaca", "--s3-uri", "s3://src/data.jsonl",
            "--technique", "sft", "--row-count", "1000",
        )
        assert r.returncode == 0, r.stderr + r.stdout

        canonical = f"s3://{_CORE_BUCKET}/datasets/alpaca/"

        # Copy used `aws s3 cp` to the canonical destination
        aws = sandbox.aws_calls()
        assert len(aws) == 1
        assert aws[0].startswith("s3 cp s3://src/data.jsonl " + canonical)

        # Registered the canonical URI (not the source URI)
        reg = sandbox.helper_calls(".register_helper.py")
        assert len(reg) == 1
        assert f"--s3-uri {canonical}" in reg[0]
        assert "--name alpaca" in reg[0]
        assert "--technique sft" in reg[0]
        assert "--row-count 1000" in reg[0]

        # stage-hf must NOT have been called for the S3 path
        assert sandbox.helper_calls(".tune_helper.py") == []

    def test_directory_prefix_uses_sync(self, sandbox):
        r = sandbox.run_dataset("mydir", "--s3-uri", "s3://src/dir/")
        assert r.returncode == 0, r.stderr + r.stdout

        canonical = f"s3://{_CORE_BUCKET}/datasets/mydir/"
        aws = sandbox.aws_calls()
        assert len(aws) == 1
        assert aws[0].startswith("s3 sync s3://src/dir/ " + canonical)

    def test_rejects_non_s3_uri(self, sandbox):
        r = sandbox.run_dataset("bad", "--s3-uri", "hf://org/name")
        assert r.returncode != 0
        assert "must be an s3:// URI" in r.stdout


# ── HuggingFace path ───────────────────────────────────────────────────────────


class TestHuggingFacePath:
    def test_hf_id_stages_then_registers(self, sandbox):
        r = sandbox.run_dataset(
            "guanaco", "--hf-id", "timdettmers/openassistant-guanaco",
            "--technique", "sft", "--row-count", "500",
        )
        assert r.returncode == 0, r.stderr + r.stdout

        # stage-hf invoked with org/name split out and CORE_BUCKET as output bucket
        stage = sandbox.helper_calls(".tune_helper.py")
        assert len(stage) == 1
        assert "--hf-org timdettmers" in stage[0]
        assert "--hf-name openassistant-guanaco" in stage[0]
        assert f"--output-bucket {_CORE_BUCKET}" in stage[0]
        assert "--project-name testproj" in stage[0]
        assert "--region us-west-2" in stage[0]
        assert "--technique sft" in stage[0]
        # --row-count is forwarded to staging as --take
        assert "--take 500" in stage[0]

        # No direct aws s3 copy on the HF path (staging owns the transfer)
        assert sandbox.aws_calls() == []

        # Registered the staged canonical URI returned by stage-hf
        reg = sandbox.helper_calls(".register_helper.py")
        assert len(reg) == 1
        expected = f"s3://{_CORE_BUCKET}/datasets/openassistant-guanaco/data.jsonl"
        assert f"--s3-uri {expected}" in reg[0]
        assert "--name guanaco" in reg[0]

    def test_hf_split_and_column_map_forwarded(self, sandbox):
        r = sandbox.run_dataset(
            "ds", "--hf-id", "org/name",
            "--hf-split", "validation",
            "--column-map", "prompt=question,completion=answer",
        )
        assert r.returncode == 0, r.stderr + r.stdout
        stage = sandbox.helper_calls(".tune_helper.py")[0]
        assert "--hf-split validation" in stage
        assert "--column-map prompt=question,completion=answer" in stage

    def test_invalid_hf_id_rejected(self, sandbox):
        r = sandbox.run_dataset("ds", "--hf-id", "noslash")
        assert r.returncode != 0
        assert "Invalid --hf-id" in r.stdout


# ── Validation / mutual exclusion ───────────────────────────────────────────────


class TestValidation:
    def test_missing_source_fails(self, sandbox):
        r = sandbox.run_dataset("ds")
        assert r.returncode != 0
        assert "Provide a dataset source" in r.stdout

    def test_mutually_exclusive_sources_fail(self, sandbox):
        r = sandbox.run_dataset("ds", "--s3-uri", "s3://a/b", "--hf-id", "o/n")
        assert r.returncode != 0
        assert "mutually exclusive" in r.stdout

    def test_missing_name_fails(self, sandbox):
        r = sandbox.run_dataset("--s3-uri", "s3://a/b")
        assert r.returncode != 0
        assert "Dataset name is required" in r.stdout

    def test_invalid_technique_rejected(self, sandbox):
        r = sandbox.run_dataset("ds", "--s3-uri", "s3://a/b.jsonl", "--technique", "bogus")
        assert r.returncode != 0
        assert "Invalid technique" in r.stdout


# ── S3 sidecar wiring (BL092) ───────────────────────────────────────────────────


class TestSidecarWiring:
    def test_core_bucket_forwarded_to_helper(self, sandbox):
        r = sandbox.run_dataset("alpaca", "--s3-uri", "s3://src/data.jsonl")
        assert r.returncode == 0, r.stderr + r.stdout
        reg = sandbox.helper_calls(".register_helper.py")[0]
        assert f"--core-bucket {_CORE_BUCKET}" in reg

    def test_custom_metadata_forwarded(self, sandbox):
        r = sandbox.run_dataset(
            "alpaca", "--s3-uri", "s3://src/data.jsonl",
            "--attribution", "acme",
            "--lineage", "derived",
            "--origination", "hf://org/name@rev",
            "--application", "throughput-calibration",
        )
        assert r.returncode == 0, r.stderr + r.stdout
        reg = sandbox.helper_calls(".register_helper.py")[0]
        assert "--attribution acme" in reg
        assert "--lineage derived" in reg
        assert "--origination hf://org/name@rev" in reg
        assert "--application throughput-calibration" in reg

    def test_unset_custom_metadata_not_forwarded(self, sandbox):
        r = sandbox.run_dataset("alpaca", "--s3-uri", "s3://src/data.jsonl")
        assert r.returncode == 0, r.stderr + r.stdout
        reg = sandbox.helper_calls(".register_helper.py")[0]
        assert "--attribution" not in reg
        assert "--lineage" not in reg

    def test_list_delegates_to_list_datasets(self, sandbox):
        r = sandbox.run_dataset("--list")
        assert r.returncode == 0, r.stderr + r.stdout
        # No register-dataset call for a --list invocation.
        reg = sandbox.helper_calls(".register_helper.py")
        assert all("register-dataset" not in c for c in reg)

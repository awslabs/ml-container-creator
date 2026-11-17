# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""BL154 do/train wiring — sandbox runs of the real script (Wave 7, R2.1/R3/R5/R6/R11).

Feature: v2-w7-01-train-plugin

do/train is a bash script. Each test copies it, the real .train_helper.py /
.train_build_request.py / the resolver modules, and the shipped do/training/ recipes
into an isolated sandbox with stubbed lib sourcing (script-contract.sh, profile.sh,
resolve-instance.sh), then runs it with --dry-run (prints the CreateTrainingJob
request, never submits). No AWS call is made on any path exercised here.
"""
from __future__ import annotations

import json
import os
import pty
import shutil
import subprocess
import sys

import pytest

_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
_DO = os.path.join(_REPO_ROOT, "templates", "do")
_LIB_MODULES = ("__init__.py", "common.py", "tune_config_builder.py", "train_manifest.py",
                "tune_manifest.py")

_CONFIG_YAML = """\
# sandbox config
technique: "{technique}"
image: "123456789012.dkr.ecr.us-west-2.amazonaws.com/img:latest"
script: "do/training/{technique}/train.py"
instance_type: "ml.g5.xlarge"
instance_count: 1
dataset: "s3://bucket/data/"
output_path: "s3://bucket/out/"
{hyperparameters}
max_runtime_seconds: 86400
"""


def _bash():
    return "/bin/bash" if os.path.exists("/bin/bash") else shutil.which("bash")


def _real_contract_function(name):
    """The real definition of a small helper from script-contract.sh (not a copy), so
    the sandbox stub uses the same config-var key form as a generated project."""
    import re
    text = open(os.path.join(_DO, "lib", "script-contract.sh")).read()
    m = re.search(r"^" + re.escape(name) + r"\(\) \{\n.*?^\}\n", text, re.M | re.S)
    assert m, f"{name} not found in script-contract.sh"
    return m.group(0)


@pytest.fixture
def sandbox(tmp_path):
    do = tmp_path / "do"
    lib = do / "lib"
    (lib / "python").mkdir(parents=True)
    shutil.copy2(os.path.join(_DO, "train"), do / "train")
    for f in (".train_helper.py", ".train_build_request.py"):
        shutil.copy2(os.path.join(_DO, f), do / f)
    for m in _LIB_MODULES:
        shutil.copy2(os.path.join(_DO, "lib", "python", m), lib / "python" / m)
    shutil.copytree(os.path.join(_DO, "training"), do / "training")
    (lib / "script-contract.sh").write_text("_require_python_env(){ :; }\n_require_guard(){ :; }\n"
                                            + _real_contract_function("_additive_upper"))
    (lib / "profile.sh").write_text(":\n")
    shutil.copy2(os.path.join(_DO, "lib", "s3-layout.sh"), lib / "s3-layout.sh")  # bucket consolidation R3
    (lib / "resolve-instance.sh").write_text(":\n")
    (do / "config").write_text('PROJECT_NAME="p"\nAWS_REGION="us-west-2"\n'
                               'ROLE_ARN="arn:aws:iam::123456789012:role/r"\n')

    class Box:
        root = do

        def config(self, technique="sft", hyperparameters="hyperparameters: {}"):
            (do / "training" / "config.yaml").write_text(
                _CONFIG_YAML.format(technique=technique, hyperparameters=hyperparameters))

        def env(self):
            env = dict(os.environ)
            # python3 must resolve to an interpreter with PyYAML (the project venv in a
            # real project; the test interpreter here).
            env["PATH"] = os.path.dirname(sys.executable) + os.pathsep + env.get("PATH", "")
            env["TMPDIR"] = str(tmp_path)
            env.pop("TRAIN_JOB_NAME", None)
            return env

        def run(self, *args, stdin=subprocess.DEVNULL):
            return subprocess.run([_bash(), str(do / "train"), *args], capture_output=True,
                                  text=True, env=self.env(), stdin=stdin, timeout=120)

    box = Box()
    box.config()
    return box


def _request_hp(result):
    """HyperParameters from the --dry-run request JSON on stdout."""
    out = result.stdout
    start = out.index("CreateTrainingJob request:")
    body = out[out.index("{", start):]
    depth, end = 0, 0
    for i, ch in enumerate(body):
        depth += ch == "{"
        depth -= ch == "}"
        if depth == 0:
            end = i + 1
            break
    return json.loads(body[:end])["HyperParameters"]


def test_script_parses_under_bin_bash():
    r = subprocess.run([_bash(), "-n", os.path.join(_DO, "train")], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_set_and_flags_resolve_through_the_manifest(sandbox):
    r = sandbox.run("--technique", "sft", "--set", "learning_rate=1e-4", "--epochs", "2", "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    hp = _request_hp(r)
    assert hp["learning_rate"] == "1e-4"           # string form preserved
    assert hp["epochs"] == "2"
    assert hp["lora_r"] == "16"                    # from sft/defaults.yaml
    assert "Hyperparameters this job will use (sft, manifest.json)" in r.stderr
    assert "(flag)" in r.stderr and "(defaults.yaml)" in r.stderr


def test_legacy_aliases_equal_set(sandbox):
    a = sandbox.run("--technique", "dpo", "--learning-rate", "1e-6", "--lora-r", "8",
                    "--batch-size", "4", "--beta", "0.2", "--epochs", "2", "--dry-run")
    b = sandbox.run("--technique", "dpo", "--set", "learning_rate=1e-6", "--set", "lora_r=8",
                    "--set", "batch_size=4", "--set", "beta=0.2", "--set", "epochs=2", "--dry-run")
    assert a.returncode == 0 and b.returncode == 0, a.stderr + b.stderr
    assert _request_hp(a) == _request_hp(b)


def test_config_yaml_hyperparameters_are_the_config_tier(sandbox):
    sandbox.config("sft", 'hyperparameters:\n  epochs: "5"\n  my_extra: "on"')
    r = sandbox.run("--dry-run")
    assert r.returncode == 0, r.stderr
    hp = _request_hp(r)
    assert hp["epochs"] == "5" and hp["my_extra"] == "on"
    assert "passed to train.py unchanged: my_extra" in r.stderr


def test_typo_rejected_before_any_aws_call(sandbox):
    r = sandbox.run("--technique", "sft", "--set", "learnign_rate=1e-4", "--dry-run")
    assert r.returncode == 1
    assert "did you mean 'learning_rate'?" in r.stderr
    assert "CreateTrainingJob request" not in r.stdout


def test_legacy_flag_for_undeclared_knob_rejected_then_allowed(sandbox):
    r = sandbox.run("--technique", "sft", "--beta", "0.1", "--dry-run")
    assert r.returncode == 1 and "unknown knob 'beta'" in r.stderr
    r = sandbox.run("--technique", "sft", "--beta", "0.1", "--allow-unknown", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert _request_hp(r)["beta"] == "0.1"


def test_out_of_range_value_rejected(sandbox):
    r = sandbox.run("--technique", "grpo", "--set", "num_generations=1", "--dry-run")
    assert r.returncode == 1
    assert "num_generations" in r.stderr and ">= 2" in r.stderr


def test_malformed_manifest_exits_2_with_structured_message(sandbox):
    (sandbox.root / "training" / "sft" / "manifest.json").write_text(
        '{"schema_version": 1, "technique": "sft", "hyperparameters": '
        '{"learning_rate": {"type": "number", "required": false, "min": 1.0, "max": 0.1}, '
        '"scheduler": {"type": "string", "required": false, "choices": ["a"]}}}')
    r = sandbox.run("--technique", "sft", "--dry-run")
    assert r.returncode == 2
    combined = r.stdout + r.stderr
    assert "Traceback" not in combined
    assert "Invalid training manifest: do/training/sft/manifest.json" in r.stderr
    assert "'min' (1.0) is greater than 'max' (0.1)" in r.stderr
    assert "unknown key 'choices' (did you mean 'enum'?)" in r.stderr
    assert "CreateTrainingJob request" not in r.stdout


def test_descriptorless_unchanged_plus_set_passthrough(sandbox):
    sandbox.config("custom", 'hyperparameters:\n  epochs: "10"\n  batch_size: "32"')
    r = sandbox.run("--set", "anything=goes", "--epochs", "3", "--beta", "0.5",
                    "--allow-unknown", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert _request_hp(r) == {"epochs": "3", "batch_size": "32", "anything": "goes", "beta": "0.5"}
    assert "descriptor-less" in r.stderr


def test_advanced_without_interactive_is_a_notice(sandbox):
    r = sandbox.run("--technique", "sft", "--advanced", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert "--advanced only affects interactive knob prompts" in r.stdout


def test_forward_compat_old_dir_with_prompts_json_no_manifest(sandbox):
    """A pre-Wave-7 technique dir (prompts.json, no manifest) → descriptor-less path."""
    old = sandbox.root / "training" / "oldtech"
    shutil.copytree(sandbox.root / "training" / "sft", old)
    (old / "manifest.json").unlink()
    (old / "prompts.json").write_text('{"prompts": [{"name": "max_seq_length", "message": "Max?"}]}')
    sandbox.config("oldtech", 'hyperparameters:\n  epochs: "7"')
    r = sandbox.run("--set", "whatever=1", "--dry-run")
    assert r.returncode == 0, r.stderr
    hp = _request_hp(r)
    assert hp["epochs"] == "7" and hp["whatever"] == "1" and hp["learning_rate"] == "2e-4"
    assert "descriptor-less" in r.stderr


def test_forward_compat_manifest_wins_over_leftover_prompts_json(sandbox):
    (sandbox.root / "training" / "sft" / "prompts.json").write_text('{"prompts": []}')
    r = sandbox.run("--technique", "sft", "--set", "learnign_rate=1", "--dry-run")
    assert r.returncode == 1 and "did you mean 'learning_rate'?" in r.stderr


def test_plain_run_on_a_tty_never_prompts(sandbox):
    """do/train stays non-interactive by default: a TTY alone must not start prompts."""
    master, slave = pty.openpty()
    try:
        r = sandbox.run("--technique", "sft", "--dry-run", stdin=slave)
    finally:
        os.close(slave)
        os.close(master)
    assert r.returncode == 0, r.stderr
    assert "(prompt)" not in r.stderr
    assert "no TTY" not in r.stderr


def test_hyphenated_technique_keeps_do_config_sourceable(sandbox):
    """A technique named with a hyphen (allowed by the manifest schema) must not write an
    invalid shell identifier into do/config. Regression: TRAIN_DATASET_S3_URI_SFT-NEFTUNE
    made do/config unsourceable, so the NEXT do/ command failed."""
    shutil.copytree(sandbox.root / "training" / "sft", sandbox.root / "training" / "my-tech")
    manifest = sandbox.root / "training" / "my-tech" / "manifest.json"
    data = json.loads(manifest.read_text())
    data["technique"] = "my-tech"
    manifest.write_text(json.dumps(data))
    sandbox.config("my-tech")
    first = sandbox.run("--dry-run")
    assert first.returncode == 0, first.stdout + first.stderr
    second = sandbox.run("--dry-run")
    assert second.returncode == 0, second.stdout + second.stderr
    assert "not a valid identifier" not in first.stderr + second.stderr
    config = (sandbox.root / "config").read_text()
    assert "TRAIN_DATASET_S3_URI_MY_TECH=" in config
    assert "MY-TECH" not in config
    r = subprocess.run([_bash(), "-c", f'set -e; source "{sandbox.root / "config"}"; echo ok'],
                       capture_output=True, text=True)
    assert r.returncode == 0 and "ok" in r.stdout, r.stderr

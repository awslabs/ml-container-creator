from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
OPTIMIZE_TEMPLATE = PROJECT_ROOT / "templates" / "do" / "optimize"
SCRIPT_CONTRACT = PROJECT_ROOT / "templates" / "do" / "lib" / "script-contract.sh"


def _run_apply(tmp_path: Path, recommendation: dict) -> tuple[subprocess.CompletedProcess[str], str]:
    """Execute --apply against a minimal generated-project fixture."""
    do_dir = tmp_path / "do"
    lib_dir = do_dir / "lib"
    bin_dir = tmp_path / "bin"
    lib_dir.mkdir(parents=True)
    bin_dir.mkdir()

    # Satisfy script-contract.sh's venv guard via path 2 (project-local hey-venv):
    # create a sourceable .mlcc/hey-venv/bin/activate marker so the guard passes
    # regardless of whether pytest itself runs inside a venv.
    _venv_bin = tmp_path / ".mlcc" / "hey-venv" / "bin"
    _venv_bin.mkdir(parents=True, exist_ok=True)
    (_venv_bin / "activate").write_text("# test venv marker\n")

    optimize = do_dir / "optimize"
    shutil.copy2(OPTIMIZE_TEMPLATE, optimize)
    shutil.copy2(SCRIPT_CONTRACT, lib_dir / "script-contract.sh")
    (lib_dir / "wait.sh").write_text("#!/usr/bin/env bash\n")
    (do_dir / "config").write_text(
        "\n".join(
            [
                'export PROJECT_NAME="apply-test"',
                'export AWS_REGION="us-east-1"',
                'export DEPLOYMENT_TARGET="realtime-inference"',
                'export DEPLOYMENT_TARGET_SMAI_STATUS="InService"',
                'export OPTIMIZE_JOB_NAME="apply-test-job"',
                "",
            ]
        )
    )

    fixture = tmp_path / "recommendation.json"
    fixture.write_text(json.dumps({"Recommendations": [recommendation]}))
    aws = bin_dir / "aws"
    aws.write_text(
        "#!/usr/bin/env bash\n"
        "if [ \"${1:-}\" = \"--version\" ]; then echo 'aws-cli/2.31.0'; exit 0; fi\n"
        "if [ \"${1:-}\" = \"sagemaker\" ] && [ \"${2:-}\" = \"describe-ai-recommendation-job\" ]; then cat \"${AWS_FIXTURE}\"; exit 0; fi\n"
        "exit 1\n"
    )
    aws.chmod(aws.stat().st_mode | stat.S_IXUSR)

    environment = os.environ | {
        "AWS_FIXTURE": str(fixture),
        "VIRTUAL_ENV": sys.prefix,
        "PATH": f"{bin_dir}:{Path(sys.executable).parent}:{os.environ['PATH']}",
    }
    result = subprocess.run(
        ["bash", str(optimize), "--apply", "top"],
        cwd=tmp_path,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    return result, (do_dir / "config").read_text()


def test_dataset_uri_uses_dataset_config_and_enables_throughput_optimization():
    script = OPTIMIZE_TEMPLATE.read_text()

    assert "--dataset)" in script
    assert "--dataset-uri" not in script
    assert 'WORKLOAD_CONFIG_CMD+=(--dataset-config "${DATASET_CONFIG}")' in script
    assert '"S3Uri": sys.argv[1]' in script
    assert '[ "${PERF_METRIC}" = "throughput" ] && [ -z "${DATASET_URI}" ]' in script
    assert "HP_SPECULATIVE_STEPS" not in script


def test_apply_maps_speculative_details_to_canonical_config_variables(tmp_path: Path):
    recommendation = {
        "ModelDetails": {
            "ModelPackageArn": "arn:aws:sagemaker:us-east-1:123456789012:model-package/optimized/1",
            "InferenceSpecificationName": "vllm-optimized",
            "InstanceDetails": [{"InstanceType": "ml.g6.12xlarge"}],
        },
        "OptimizationDetails": [
            {
                "OptimizationName": "EAGLE3 speculative decoding",
                "SpeculativeDecodingConfig": {
                    "DraftModelArn": "acme/eagle3-draft",
                    "NumSpeculativeTokens": 7,
                },
            }
        ],
    }

    result, config = _run_apply(tmp_path, recommendation)

    assert result.returncode == 0, result.stderr + result.stdout
    assert 'export OPTIMIZE_MODEL_PACKAGE_ARN="arn:aws:sagemaker:us-east-1:123456789012:model-package/optimized/1"' in config
    assert 'export OPTIMIZE_INFERENCE_SPEC="vllm-optimized"' in config
    assert 'export INSTANCE_TYPE="ml.g6.12xlarge"' in config
    assert 'export HP_SPECULATIVE_MODEL="acme/eagle3-draft"' in config
    assert 'export HP_SPECULATIVE_NUM_TOKENS="7"' in config
    assert 'export HP_SPECULATIVE_ALGORITHM="eagle3"' in config
    assert "HP_SPECULATIVE_STEPS" not in config


def test_apply_extracts_hf_model_id_from_draft_model_arn(tmp_path: Path):
    recommendation = {
        "ModelDetails": {
            "ModelPackageArn": "arn:aws:sagemaker:us-east-1:123456789012:model-package/optimized/1",
            "InferenceSpecificationName": "vllm-optimized",
            "InstanceDetails": [{"InstanceType": "ml.g6.12xlarge"}],
        },
        "OptimizationDetails": [
            {
                "OptimizationName": "draft-model speculative decoding",
                "SpeculativeDecodingConfig": {
                    "DraftModelArn": "arn:aws:sagemaker:us-east-1:123456789012:hub-content/HuggingFaceH4/model/huggingface.co/acme/draft-3b",
                    "NumSpeculativeTokens": 4,
                },
            }
        ],
    }

    result, config = _run_apply(tmp_path, recommendation)

    assert result.returncode == 0, result.stderr + result.stdout
    assert 'export HP_SPECULATIVE_MODEL="acme/draft-3b"' in config
    assert 'export HP_SPECULATIVE_ALGORITHM="draft-model"' in config
    assert 'export HP_SPECULATIVE_NUM_TOKENS="4"' in config


def test_apply_skips_speculative_variables_when_details_are_empty(tmp_path: Path):
    recommendation = {
        "ModelDetails": {
            "ModelPackageArn": "arn:aws:sagemaker:us-east-1:123456789012:model-package/optimized/1",
            "InferenceSpecificationName": "vllm-optimized",
            "InstanceDetails": [{"InstanceType": "ml.g6.12xlarge"}],
        },
        "OptimizationDetails": [],
    }

    result, config = _run_apply(tmp_path, recommendation)

    assert result.returncode == 0, result.stderr + result.stdout
    assert 'export OPTIMIZE_MODEL_PACKAGE_ARN=' in config
    assert "HP_SPECULATIVE_MODEL" not in config
    assert "HP_SPECULATIVE_NUM_TOKENS" not in config
    assert "HP_SPECULATIVE_ALGORITHM" not in config

"""Test that _persist_deploy_vars writes non-empty vars to do/config (FR-2.5).

Validates:
- Only non-empty vars are written to config
- _update_config creates new entries and updates existing ones
- The helper-invoked flag gates persistence (no redundant writes on repeat deploy)
"""
import os
import subprocess
import tempfile

# Minimal bash script that defines _update_config and _persist_deploy_vars,
# then invokes persistence and dumps the resulting config.
_SCRIPT_TEMPLATE = """\
#!/bin/bash
set -e
SCRIPT_DIR="{tmpdir}"

_update_config() {{
    local key="$1" value="$2"
    local config="${{SCRIPT_DIR}}/config"
    if grep -q "^export ${{key}}=" "$config" 2>/dev/null; then
        sed -i.bak \\
          "s|^export ${{key}}=.*|export ${{key}}=\\"${{value}}\\"|" \\
          "$config"
        rm -f "${{config}}.bak"
    else
        echo "export ${{key}}=\\"${{value}}\\"" >> "$config"
    fi
}}

_persist_deploy_vars() {{
    local vars=(
        DEPLOYMENT_TARGET INSTANCE_TYPE ENDPOINT_NAME ENDPOINT_STRATEGY
        IC_GPU_COUNT INSTANCE_TYPES HP_CLUSTER_NAME HP_GPU_COUNT
        HP_NAMESPACE HP_REPLICAS HP_QUEUE ASYNC_S3_OUTPUT_PATH
        ASYNC_SNS_TOPIC ASYNC_MAX_CONCURRENT BATCH_INPUT_PATH
        BATCH_OUTPUT_PATH BATCH_SPLIT_TYPE BATCH_STRATEGY BATCH_MAX_CONCURRENT
    )
    for var in "${{vars[@]}}"; do
        local val="${{!var:-}}"
        if [ -n "$val" ]; then
            _update_config "$var" "$val"
        fi
    done
}}

# Set up environment (simulating exported vars from helper)
{exports}

# Invoke persistence
_HELPER_INVOKED={helper_invoked}
if [ "$_HELPER_INVOKED" -eq 1 ]; then
    _persist_deploy_vars
fi

cat "${{SCRIPT_DIR}}/config"
"""


def _run_persist_test(
    initial_config: str,
    exports: str,
    helper_invoked: int = 1,
) -> str:
    """Run the persistence script and return the final config content."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        with open(config_path, "w") as f:
            f.write(initial_config)

        script = _SCRIPT_TEMPLATE.format(
            tmpdir=tmpdir,
            exports=exports,
            helper_invoked=helper_invoked,
        )
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"Script failed: {result.stderr}"
        return result.stdout


def test_persist_managed_inference_vars():
    """First deploy with managed-inference target persists all relevant vars."""
    initial = 'export DEPLOYMENT_TARGET=""\nexport INSTANCE_TYPE=""\n'
    exports = (
        'export DEPLOYMENT_TARGET="managed-inference"\n'
        'export INSTANCE_TYPE="ml.g5.xlarge"\n'
        'export ENDPOINT_NAME="my-ep"\n'
        'export ENDPOINT_STRATEGY="new"\n'
        'export IC_GPU_COUNT="1"\n'
    )
    config = _run_persist_test(initial, exports)
    assert 'export DEPLOYMENT_TARGET="managed-inference"' in config
    assert 'export INSTANCE_TYPE="ml.g5.xlarge"' in config
    assert 'export ENDPOINT_NAME="my-ep"' in config
    assert 'export ENDPOINT_STRATEGY="new"' in config
    assert 'export IC_GPU_COUNT="1"' in config


def test_persist_hyperpod_vars():
    """HyperPod target persists cluster and GPU vars."""
    initial = 'export DEPLOYMENT_TARGET=""\n'
    exports = (
        'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
        'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
        'export HP_CLUSTER_NAME="my-cluster"\n'
        'export HP_GPU_COUNT="4"\n'
        'export HP_NAMESPACE="default"\n'
        'export HP_REPLICAS="2"\n'
    )
    config = _run_persist_test(initial, exports)
    assert 'export DEPLOYMENT_TARGET="hyperpod-eks"' in config
    assert 'export HP_CLUSTER_NAME="my-cluster"' in config
    assert 'export HP_GPU_COUNT="4"' in config
    assert 'export HP_NAMESPACE="default"' in config
    assert 'export HP_REPLICAS="2"' in config


def test_persist_async_vars_with_s3_path():
    """Async target persists S3 paths correctly (slashes in value)."""
    initial = 'export DEPLOYMENT_TARGET=""\n'
    exports = (
        'export DEPLOYMENT_TARGET="async-inference"\n'
        'export INSTANCE_TYPE="ml.g5.xlarge"\n'
        'export ASYNC_S3_OUTPUT_PATH="s3://my-bucket/async-output/project/"\n'
        'export ASYNC_MAX_CONCURRENT="5"\n'
    )
    config = _run_persist_test(initial, exports)
    assert 'export DEPLOYMENT_TARGET="async-inference"' in config
    assert 'export ASYNC_S3_OUTPUT_PATH="s3://my-bucket/async-output/project/"' in config
    assert 'export ASYNC_MAX_CONCURRENT="5"' in config


def test_persist_batch_vars():
    """Batch target persists input/output paths and strategy."""
    initial = 'export DEPLOYMENT_TARGET=""\n'
    exports = (
        'export DEPLOYMENT_TARGET="batch-transform"\n'
        'export INSTANCE_TYPE="ml.m5.xlarge"\n'
        'export BATCH_INPUT_PATH="s3://data/input/"\n'
        'export BATCH_OUTPUT_PATH="s3://data/output/"\n'
        'export BATCH_SPLIT_TYPE="Line"\n'
        'export BATCH_STRATEGY="MultiRecord"\n'
        'export BATCH_MAX_CONCURRENT="3"\n'
    )
    config = _run_persist_test(initial, exports)
    assert 'export BATCH_INPUT_PATH="s3://data/input/"' in config
    assert 'export BATCH_OUTPUT_PATH="s3://data/output/"' in config
    assert 'export BATCH_SPLIT_TYPE="Line"' in config
    assert 'export BATCH_STRATEGY="MultiRecord"' in config
    assert 'export BATCH_MAX_CONCURRENT="3"' in config


def test_empty_vars_not_persisted():
    """Empty vars are NOT written to config."""
    initial = 'export DEPLOYMENT_TARGET=""\n'
    exports = (
        'export DEPLOYMENT_TARGET="managed-inference"\n'
        'export INSTANCE_TYPE="ml.g5.xlarge"\n'
        # These are empty — should not appear in config
        'export ENDPOINT_NAME=""\n'
        'export HP_CLUSTER_NAME=""\n'
    )
    config = _run_persist_test(initial, exports)
    assert 'export DEPLOYMENT_TARGET="managed-inference"' in config
    assert 'export INSTANCE_TYPE="ml.g5.xlarge"' in config
    # Empty vars should not be written
    assert "ENDPOINT_NAME" not in config
    assert "HP_CLUSTER_NAME" not in config


def test_no_persist_when_helper_not_invoked():
    """When helper is NOT invoked (repeat deploy), no writes happen."""
    initial = 'export DEPLOYMENT_TARGET="managed-inference"\nexport INSTANCE_TYPE="ml.g5.xlarge"\n'
    exports = (
        'export DEPLOYMENT_TARGET="managed-inference"\n'
        'export INSTANCE_TYPE="ml.g5.xlarge"\n'
        'export ENDPOINT_NAME="new-ep-name"\n'
    )
    # helper_invoked=0 means we came through the existing-config path
    config = _run_persist_test(initial, exports, helper_invoked=0)
    # Config should be unchanged — ENDPOINT_NAME NOT added
    assert "ENDPOINT_NAME" not in config
    # Original values preserved as-is
    assert 'export DEPLOYMENT_TARGET="managed-inference"' in config
    assert 'export INSTANCE_TYPE="ml.g5.xlarge"' in config


def test_update_existing_values_in_place():
    """Existing values in config are updated in-place (not duplicated)."""
    initial = (
        'export DEPLOYMENT_TARGET="managed-inference"\n'
        'export INSTANCE_TYPE="ml.g5.xlarge"\n'
    )
    exports = (
        'export DEPLOYMENT_TARGET="managed-inference"\n'
        'export INSTANCE_TYPE="ml.g5.2xlarge"\n'  # Changed!
    )
    config = _run_persist_test(initial, exports, helper_invoked=1)
    # Should be updated, not duplicated
    assert config.count("INSTANCE_TYPE") == 1
    assert 'export INSTANCE_TYPE="ml.g5.2xlarge"' in config

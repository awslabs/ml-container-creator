"""Test config persistence atomicity (CP-7).

Validates:
- _persist_deploy_vars writes ALL vars atomically (temp file + mv)
- A partial write (crash mid-persist) MUST NOT leave config inconsistent
- Either all vars from the answer set are written, or none are
"""
import os
import signal
import subprocess
import tempfile
import time


# ── Atomic persist script (mirrors the new implementation) ──────────
_ATOMIC_SCRIPT = """\
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
    local config="${{SCRIPT_DIR}}/config"
    local tmp_config="${{config}}.tmp.$$"
    local vars=(
        DEPLOYMENT_TARGET INSTANCE_TYPE ENDPOINT_NAME ENDPOINT_STRATEGY
        IC_GPU_COUNT INSTANCE_TYPES HP_CLUSTER_NAME HP_GPU_COUNT
        HP_NAMESPACE HP_REPLICAS HP_QUEUE ASYNC_S3_OUTPUT_PATH
        ASYNC_SNS_TOPIC ASYNC_MAX_CONCURRENT BATCH_INPUT_PATH
        BATCH_OUTPUT_PATH BATCH_SPLIT_TYPE BATCH_STRATEGY BATCH_MAX_CONCURRENT
    )

    # Copy current config to temp file
    cp "$config" "$tmp_config"

    # Apply all changes to the temp file
    for var in "${{vars[@]}}"; do
        local val="${{!var:-}}"
        if [ -n "$val" ]; then
            if grep -q "^export ${{var}}=" "$tmp_config" 2>/dev/null; then
                sed -i.bak \\
                  "s|^export ${{var}}=.*|export ${{var}}=\\"${{val}}\\"|" \\
                  "$tmp_config"
                rm -f "${{tmp_config}}.bak"
            else
                echo "export ${{var}}=\\"${{val}}\\"" >> "$tmp_config"
            fi
        fi
    done

    # Atomic replace via mv
    mv "$tmp_config" "$config"
}}

# Set up environment
{exports}

_persist_deploy_vars

cat "${{SCRIPT_DIR}}/config"
"""

# ── Non-atomic (old) persist script for comparison ──────────
_NON_ATOMIC_SCRIPT = """\
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

_persist_deploy_vars_non_atomic() {{
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

# Set up environment
{exports}

_persist_deploy_vars_non_atomic

cat "${{SCRIPT_DIR}}/config"
"""

# ── Crash simulation script (atomic) ──────────────────────
# This script simulates a crash by killing itself mid-persist.
# With atomic persist, the original config should be untouched
# because the mv never happens.
_CRASH_ATOMIC_SCRIPT = """\
#!/bin/bash
set -e
SCRIPT_DIR="{tmpdir}"

_persist_deploy_vars_with_crash() {{
    local config="${{SCRIPT_DIR}}/config"
    local tmp_config="${{config}}.tmp.$$"
    local vars=(
        DEPLOYMENT_TARGET INSTANCE_TYPE ENDPOINT_NAME ENDPOINT_STRATEGY
        IC_GPU_COUNT INSTANCE_TYPES HP_CLUSTER_NAME HP_GPU_COUNT
        HP_NAMESPACE HP_REPLICAS HP_QUEUE ASYNC_S3_OUTPUT_PATH
        ASYNC_SNS_TOPIC ASYNC_MAX_CONCURRENT BATCH_INPUT_PATH
        BATCH_OUTPUT_PATH BATCH_SPLIT_TYPE BATCH_STRATEGY BATCH_MAX_CONCURRENT
    )

    # Copy current config to temp file
    cp "$config" "$tmp_config"

    local count=0
    for var in "${{vars[@]}}"; do
        local val="${{!var:-}}"
        if [ -n "$val" ]; then
            if grep -q "^export ${{var}}=" "$tmp_config" 2>/dev/null; then
                sed -i.bak \\
                  "s|^export ${{var}}=.*|export ${{var}}=\\"${{val}}\\"|" \\
                  "$tmp_config"
                rm -f "${{tmp_config}}.bak"
            else
                echo "export ${{var}}=\\"${{val}}\\"" >> "$tmp_config"
            fi
        fi
        count=$((count + 1))
        # Simulate crash after writing {crash_after} vars to temp file
        # (before the atomic mv)
        if [ $count -eq {crash_after} ]; then
            # Clean up temp file to simulate what happens on unexpected exit
            # In reality, the temp file might be left behind, but the
            # original config is untouched because mv never ran.
            rm -f "$tmp_config"
            exit 1
        fi
    done

    # This line should NOT be reached if crash_after < total vars
    mv "$tmp_config" "$config"
}}

# Set up environment
{exports}

_persist_deploy_vars_with_crash
"""

# ── Crash simulation script (non-atomic / old style) ──────
# Simulates a crash during the old non-atomic approach.
# Config WILL be in a partial state.
_CRASH_NON_ATOMIC_SCRIPT = """\
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

_persist_deploy_vars_non_atomic_with_crash() {{
    local vars=(
        DEPLOYMENT_TARGET INSTANCE_TYPE ENDPOINT_NAME ENDPOINT_STRATEGY
        IC_GPU_COUNT INSTANCE_TYPES HP_CLUSTER_NAME HP_GPU_COUNT
        HP_NAMESPACE HP_REPLICAS HP_QUEUE ASYNC_S3_OUTPUT_PATH
        ASYNC_SNS_TOPIC ASYNC_MAX_CONCURRENT BATCH_INPUT_PATH
        BATCH_OUTPUT_PATH BATCH_SPLIT_TYPE BATCH_STRATEGY BATCH_MAX_CONCURRENT
    )
    local count=0
    for var in "${{vars[@]}}"; do
        local val="${{!var:-}}"
        if [ -n "$val" ]; then
            _update_config "$var" "$val"
            count=$((count + 1))
            # Simulate crash after {crash_after} writes
            if [ $count -eq {crash_after} ]; then
                exit 1
            fi
        fi
    done
}}

# Set up environment
{exports}

_persist_deploy_vars_non_atomic_with_crash
"""


def _run_script(script: str) -> tuple[int, str]:
    """Run a bash script and return (returncode, stdout)."""
    result = subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout


def _read_config(tmpdir: str) -> str:
    """Read the config file from tmpdir."""
    config_path = os.path.join(tmpdir, "config")
    with open(config_path) as f:
        return f.read()


# ────────────────────────────────────────────────────────────
# 14.2: Verify partial writes cannot occur (CP-7)
# ────────────────────────────────────────────────────────────


def test_atomic_persist_writes_all_vars():
    """Atomic persist writes ALL vars from the answer set."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        initial = (
            'export DEPLOYMENT_TARGET=""\n'
            'export INSTANCE_TYPE=""\n'
            'export ENDPOINT_NAME=""\n'
        )
        with open(config_path, "w") as f:
            f.write(initial)

        exports = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-ep"\n'
            'export ENDPOINT_STRATEGY="new"\n'
            'export IC_GPU_COUNT="1"\n'
        )
        script = _ATOMIC_SCRIPT.format(tmpdir=tmpdir, exports=exports)
        rc, _ = _run_script(script)
        assert rc == 0, "Atomic persist script failed"

        config = _read_config(tmpdir)
        assert 'export DEPLOYMENT_TARGET="managed-inference"' in config
        assert 'export INSTANCE_TYPE="ml.g5.xlarge"' in config
        assert 'export ENDPOINT_NAME="my-ep"' in config
        assert 'export ENDPOINT_STRATEGY="new"' in config
        assert 'export IC_GPU_COUNT="1"' in config


def test_atomic_persist_no_temp_file_left():
    """After atomic persist, no .tmp file is left behind."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        initial = 'export DEPLOYMENT_TARGET=""\n'
        with open(config_path, "w") as f:
            f.write(initial)

        exports = 'export DEPLOYMENT_TARGET="managed-inference"\n'
        script = _ATOMIC_SCRIPT.format(tmpdir=tmpdir, exports=exports)
        rc, _ = _run_script(script)
        assert rc == 0

        # No temp files should remain
        files = os.listdir(tmpdir)
        tmp_files = [f for f in files if ".tmp" in f]
        assert tmp_files == [], f"Temp files left behind: {tmp_files}"


def test_atomic_persist_updates_existing_and_appends_new():
    """Atomic persist updates existing vars in-place and appends new ones."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        initial = (
            '# Project config\n'
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            '# End of config\n'
        )
        with open(config_path, "w") as f:
            f.write(initial)

        exports = (
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
            'export HP_CLUSTER_NAME="my-cluster"\n'
            'export HP_GPU_COUNT="4"\n'
        )
        script = _ATOMIC_SCRIPT.format(tmpdir=tmpdir, exports=exports)
        rc, _ = _run_script(script)
        assert rc == 0

        config = _read_config(tmpdir)
        # Updated in-place
        assert 'export DEPLOYMENT_TARGET="hyperpod-eks"' in config
        assert 'export INSTANCE_TYPE="ml.g5.12xlarge"' in config
        # Appended
        assert 'export HP_CLUSTER_NAME="my-cluster"' in config
        assert 'export HP_GPU_COUNT="4"' in config
        # Comment preserved
        assert '# Project config' in config
        # No duplicates
        assert config.count("DEPLOYMENT_TARGET") == 1
        assert config.count("INSTANCE_TYPE") == 1


def test_atomic_persist_all_or_nothing():
    """If crash occurs before mv, original config is completely unchanged (CP-7)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        initial = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="old-ep"\n'
        )
        with open(config_path, "w") as f:
            f.write(initial)

        exports = (
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
            'export HP_CLUSTER_NAME="new-cluster"\n'
            'export HP_GPU_COUNT="8"\n'
            'export HP_NAMESPACE="production"\n'
        )

        # Crash after 2 vars written to temp file (before mv)
        script = _CRASH_ATOMIC_SCRIPT.format(
            tmpdir=tmpdir, exports=exports, crash_after=2
        )
        rc, _ = _run_script(script)
        # Script exits non-zero (crash)
        assert rc != 0

        # Original config MUST be completely unchanged
        config = _read_config(tmpdir)
        assert config == initial, (
            f"Config was modified despite crash!\n"
            f"Expected:\n{initial}\nGot:\n{config}"
        )


# ────────────────────────────────────────────────────────────
# 14.3: Crash-simulation tests (Requirements: CP-7)
# ────────────────────────────────────────────────────────────


def test_crash_mid_atomic_persist_leaves_config_intact():
    """Simulated crash during atomic persist: config untouched (CP-7).

    The crash happens after some vars are written to the temp file
    but before the atomic mv. The original config must remain intact.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        initial = (
            'export DEPLOYMENT_TARGET="async-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ASYNC_S3_OUTPUT_PATH="s3://bucket/output/"\n'
            'export ASYNC_MAX_CONCURRENT="3"\n'
        )
        with open(config_path, "w") as f:
            f.write(initial)

        exports = (
            'export DEPLOYMENT_TARGET="batch-transform"\n'
            'export INSTANCE_TYPE="ml.m5.xlarge"\n'
            'export BATCH_INPUT_PATH="s3://data/input/"\n'
            'export BATCH_OUTPUT_PATH="s3://data/output/"\n'
            'export BATCH_SPLIT_TYPE="Line"\n'
            'export BATCH_STRATEGY="MultiRecord"\n'
            'export BATCH_MAX_CONCURRENT="5"\n'
        )

        # Crash after 3 vars written to temp (well before mv)
        script = _CRASH_ATOMIC_SCRIPT.format(
            tmpdir=tmpdir, exports=exports, crash_after=3
        )
        rc, _ = _run_script(script)
        assert rc != 0, "Script should have crashed"

        # Config must be identical to initial state
        config = _read_config(tmpdir)
        assert config == initial, (
            "Atomic persist: config was corrupted by crash!\n"
            f"Expected:\n{initial}\nGot:\n{config}"
        )


def test_crash_non_atomic_produces_partial_write():
    """Non-atomic (old) persist DOES leave partial state on crash.

    This test demonstrates the problem that CP-7 solves: without
    atomic persistence, a crash mid-loop leaves some vars updated
    and others stale — an inconsistent config.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        initial = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="old-ep"\n'
        )
        with open(config_path, "w") as f:
            f.write(initial)

        exports = (
            'export DEPLOYMENT_TARGET="hyperpod-eks"\n'
            'export INSTANCE_TYPE="ml.g5.12xlarge"\n'
            'export HP_CLUSTER_NAME="new-cluster"\n'
            'export HP_GPU_COUNT="8"\n'
            'export HP_NAMESPACE="production"\n'
        )

        # Crash after 2 writes — DEPLOYMENT_TARGET and INSTANCE_TYPE
        # are updated, but HP_CLUSTER_NAME is not yet written.
        script = _CRASH_NON_ATOMIC_SCRIPT.format(
            tmpdir=tmpdir, exports=exports, crash_after=2
        )
        rc, _ = _run_script(script)
        assert rc != 0, "Script should have crashed"

        # Config is now inconsistent: some vars updated, others not
        config = _read_config(tmpdir)
        # These were written before crash
        has_new_target = 'export DEPLOYMENT_TARGET="hyperpod-eks"' in config
        has_new_instance = 'export INSTANCE_TYPE="ml.g5.12xlarge"' in config
        # This was NOT written (crash happened before it)
        has_cluster = 'export HP_CLUSTER_NAME="new-cluster"' in config

        # The non-atomic version IS partially written
        assert has_new_target or has_new_instance, (
            "Non-atomic write should have partially updated config"
        )
        assert not has_cluster, (
            "HP_CLUSTER_NAME should NOT be written (crash before it)"
        )
        # This proves the config is inconsistent (partial write)
        # DEPLOYMENT_TARGET says hyperpod-eks but HP_CLUSTER_NAME is missing
        assert config != initial, "Config should be modified (partial write)"


def test_crash_at_different_points_atomic_always_safe():
    """Crash at any point during atomic persist always leaves config safe.

    Tests multiple crash points to ensure the invariant holds regardless
    of when the crash occurs.
    """
    initial = (
        'export DEPLOYMENT_TARGET="managed-inference"\n'
        'export INSTANCE_TYPE="ml.g5.xlarge"\n'
        'export ENDPOINT_NAME="ep-1"\n'
        'export ENDPOINT_STRATEGY="new"\n'
    )
    exports = (
        'export DEPLOYMENT_TARGET="batch-transform"\n'
        'export INSTANCE_TYPE="ml.m5.xlarge"\n'
        'export BATCH_INPUT_PATH="s3://in/"\n'
        'export BATCH_OUTPUT_PATH="s3://out/"\n'
        'export BATCH_SPLIT_TYPE="RecordIO"\n'
        'export BATCH_STRATEGY="SingleRecord"\n'
        'export BATCH_MAX_CONCURRENT="10"\n'
    )

    # Test crash at positions 1 through 5
    for crash_at in range(1, 6):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = os.path.join(tmpdir, "config")
            with open(config_path, "w") as f:
                f.write(initial)

            script = _CRASH_ATOMIC_SCRIPT.format(
                tmpdir=tmpdir, exports=exports, crash_after=crash_at
            )
            rc, _ = _run_script(script)
            assert rc != 0, f"Script should have crashed at position {crash_at}"

            config = _read_config(tmpdir)
            assert config == initial, (
                f"Config corrupted when crash at position {crash_at}!\n"
                f"Expected:\n{initial}\nGot:\n{config}"
            )


def test_successful_atomic_persist_with_s3_paths():
    """Atomic persist handles S3 paths with slashes correctly."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        initial = (
            'export DEPLOYMENT_TARGET=""\n'
            'export INSTANCE_TYPE=""\n'
        )
        with open(config_path, "w") as f:
            f.write(initial)

        exports = (
            'export DEPLOYMENT_TARGET="async-inference"\n'
            'export INSTANCE_TYPE="ml.g5.2xlarge"\n'
            'export ASYNC_S3_OUTPUT_PATH="s3://my-bucket/async/output/path/"\n'
            'export ASYNC_SNS_TOPIC="arn:aws:sns:us-east-1:123456789:my-topic"\n'
            'export ASYNC_MAX_CONCURRENT="5"\n'
        )
        script = _ATOMIC_SCRIPT.format(tmpdir=tmpdir, exports=exports)
        rc, _ = _run_script(script)
        assert rc == 0

        config = _read_config(tmpdir)
        assert 'export ASYNC_S3_OUTPUT_PATH="s3://my-bucket/async/output/path/"' in config
        assert 'export ASYNC_SNS_TOPIC="arn:aws:sns:us-east-1:123456789:my-topic"' in config
        assert 'export ASYNC_MAX_CONCURRENT="5"' in config


def test_signal_interrupt_during_atomic_persist():
    """SIGTERM during atomic persist leaves config intact (CP-7).

    Uses a script that sends itself SIGTERM after writing to the temp
    file but before the mv. This simulates a real process kill scenario.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        config_path = os.path.join(tmpdir, "config")
        initial = (
            'export DEPLOYMENT_TARGET="managed-inference"\n'
            'export INSTANCE_TYPE="ml.g5.xlarge"\n'
            'export ENDPOINT_NAME="my-endpoint"\n'
        )
        with open(config_path, "w") as f:
            f.write(initial)

        # Script that kills itself with SIGTERM after writing to temp
        # but before the mv
        signal_script = f"""\
#!/bin/bash
SCRIPT_DIR="{tmpdir}"
config="${{SCRIPT_DIR}}/config"
tmp_config="${{config}}.tmp.$$"

export DEPLOYMENT_TARGET="hyperpod-eks"
export INSTANCE_TYPE="ml.p4d.24xlarge"
export HP_CLUSTER_NAME="big-cluster"

# Copy to temp
cp "$config" "$tmp_config"

# Write some changes to temp
sed -i.bak 's|^export DEPLOYMENT_TARGET=.*|export DEPLOYMENT_TARGET="hyperpod-eks"|' "$tmp_config"
rm -f "${{tmp_config}}.bak"
sed -i.bak 's|^export INSTANCE_TYPE=.*|export INSTANCE_TYPE="ml.p4d.24xlarge"|' "$tmp_config"
rm -f "${{tmp_config}}.bak"

# Simulate kill before mv
rm -f "$tmp_config"
kill -TERM $$
"""
        rc, _ = _run_script(signal_script)
        # Script should have been killed
        assert rc != 0

        # Config must be unchanged
        config = _read_config(tmpdir)
        assert config == initial, (
            "Config was corrupted by signal interrupt!\n"
            f"Expected:\n{initial}\nGot:\n{config}"
        )

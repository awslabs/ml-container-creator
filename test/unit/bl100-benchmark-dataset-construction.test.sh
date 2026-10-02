#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# BL100 — do/benchmark BYOD dataset-picker: functional test of the workload-spec
# and DatasetConfig construction block.
#
# Rather than duplicating the construction logic, this test slices the real
# construction fragment out of templates/do/benchmark (between two stable
# content anchors), injects stub input variables, executes it, and validates the
# emitted PARAMS_JSON / WORKLOAD_SPEC / DATASET_CONFIG_JSON as JSON.
#
# Covers:
#   1. DatasetConfig JSON construction (ChannelName 'traffic', S3Uri from dataset)
#   2. custom_dataset_type + input_file params populated from the dataset
#   3. --dataset and synthetic token-mean params are mutually exclusive in the
#      same params JSON
#   4. synthetic path unchanged when no dataset is set

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BENCHMARK_TPL="${REPO_ROOT}/templates/do/benchmark"

_fail=0
_pass=0
_check() {
    # _check <description> <condition-exit-status>
    if [ "$2" -eq 0 ]; then
        _pass=$((_pass + 1))
        echo "  ok - $1"
    else
        _fail=$((_fail + 1))
        echo "  FAIL - $1"
    fi
}

# Slice the construction fragment: from the BENCHMARK_TOKENIZER assignment down
# to (and including) the DATASET_CONFIG_JSON 'fi'. awk emits the range between
# the first anchor and the first 'fi' that closes the DATASET_CONFIG_JSON block.
_extract_fragment() {
    awk '
        /^BENCHMARK_TOKENIZER="\$\{HF_MODEL_ID/ { grab=1 }
        grab { print }
        grab && /DATASET_CONFIG_JSON="\{/ { seen_ds=1 }
        seen_ds && /^fi$/ { exit }
    ' "${BENCHMARK_TPL}"
}

FRAGMENT="$(_extract_fragment)"

if [ -z "${FRAGMENT}" ]; then
    echo "FAIL - could not extract construction fragment from ${BENCHMARK_TPL}"
    exit 1
fi

# ── Scenario A: BYOD (dataset set) ────────────────────────────────────────────
run_byod() {
    # Stub inputs the fragment consumes.
    HF_MODEL_ID="Qwen/Qwen3-0.6B"
    MODEL_NAME="s3://bucket/model/"
    BENCHMARK_CONCURRENCY=8
    BENCHMARK_STREAMING=true
    BENCHMARK_REQUEST_COUNT=100
    BENCHMARK_INPUT_TOKENS_MEAN=550
    BENCHMARK_OUTPUT_TOKENS_MEAN=150
    SECRET_ARN=""
    BENCHMARK_DATASET_S3URI="s3://b/med-voice/v2/train.jsonl"
    BENCHMARK_DATASET_FORMAT="jsonl"
    BENCHMARK_DATASET_INPUT_FILE="/opt/ml/input/data/traffic/train.jsonl"
    BENCHMARK_DATASET_CHANNEL="traffic"

    eval "${FRAGMENT}"

    printf '%s\n' "${PARAMS_JSON}" > "${_TMP}/params_byod.json"
    printf '%s\n' "${WORKLOAD_SPEC}" > "${_TMP}/spec_byod.json"
    printf '%s\n' "${DATASET_CONFIG_JSON}" > "${_TMP}/dsconfig_byod.json"
}

# ── Scenario B: synthetic (no dataset) ────────────────────────────────────────
run_synthetic() {
    HF_MODEL_ID="Qwen/Qwen3-0.6B"
    MODEL_NAME="s3://bucket/model/"
    BENCHMARK_CONCURRENCY=8
    BENCHMARK_STREAMING=true
    BENCHMARK_REQUEST_COUNT=100
    BENCHMARK_INPUT_TOKENS_MEAN=550
    BENCHMARK_OUTPUT_TOKENS_MEAN=150
    SECRET_ARN=""
    BENCHMARK_DATASET_S3URI=""
    BENCHMARK_DATASET_FORMAT=""
    BENCHMARK_DATASET_INPUT_FILE=""
    BENCHMARK_DATASET_CHANNEL="traffic"

    eval "${FRAGMENT}"

    printf '%s\n' "${PARAMS_JSON}" > "${_TMP}/params_syn.json"
    printf '%s\n' "${DATASET_CONFIG_JSON}" > "${_TMP}/dsconfig_syn.json"
}

_TMP="$(mktemp -d)"
trap 'rm -rf "${_TMP}"' EXIT

# Execute both scenarios in subshells to isolate variable state.
( run_byod )
( run_synthetic )

# JSON helper: read a key path via python3.
_json_get() { python3 -c "import sys,json; d=json.load(open('$1')); print(d$2)" 2>/dev/null; }
_is_valid_json() { python3 -c "import sys,json; json.load(open('$1'))" 2>/dev/null; }

# ── Assertions: BYOD params ───────────────────────────────────────────────────
_is_valid_json "${_TMP}/params_byod.json"; _check "BYOD PARAMS_JSON is valid JSON" $?

v=$(_json_get "${_TMP}/params_byod.json" "['custom_dataset_type']")
[ "$v" = "jsonl" ]; _check "BYOD params: custom_dataset_type=jsonl" $?

v=$(_json_get "${_TMP}/params_byod.json" "['input_file']")
[ "$v" = "/opt/ml/input/data/traffic/train.jsonl" ]; _check "BYOD params: input_file points at channel mount" $?

# Mutual exclusivity: synthetic token-mean fields absent under BYOD.
python3 -c "import json;d=json.load(open('${_TMP}/params_byod.json'));import sys;sys.exit(0 if ('prompt_input_tokens_mean' not in d and 'output_tokens_mean' not in d) else 1)"
_check "BYOD params: prompt_input_tokens_mean / output_tokens_mean OMITTED" $?

# Concurrency/streaming/tokenizer/request_count retained under BYOD.
python3 -c "import json;d=json.load(open('${_TMP}/params_byod.json'));import sys;sys.exit(0 if all(k in d for k in ('concurrency','streaming','tokenizer','request_count')) else 1)"
_check "BYOD params: concurrency/streaming/tokenizer/request_count retained" $?

# ── Assertions: DatasetConfig JSON ────────────────────────────────────────────
_is_valid_json "${_TMP}/dsconfig_byod.json"; _check "BYOD DATASET_CONFIG_JSON is valid JSON" $?

v=$(_json_get "${_TMP}/dsconfig_byod.json" "['InputDataConfig'][0]['ChannelName']")
[ "$v" = "traffic" ]; _check "DatasetConfig: ChannelName=traffic" $?

v=$(_json_get "${_TMP}/dsconfig_byod.json" "['InputDataConfig'][0]['DataSource']['S3DataSource']['S3Uri']")
[ "$v" = "s3://b/med-voice/v2/train.jsonl" ]; _check "DatasetConfig: S3Uri from resolved dataset" $?

# ── Assertions: synthetic path unchanged ──────────────────────────────────────
_is_valid_json "${_TMP}/params_syn.json"; _check "synthetic PARAMS_JSON is valid JSON" $?

python3 -c "import json;d=json.load(open('${_TMP}/params_syn.json'));import sys;sys.exit(0 if ('prompt_input_tokens_mean' in d and 'output_tokens_mean' in d) else 1)"
_check "synthetic params: token-mean fields PRESENT" $?

python3 -c "import json;d=json.load(open('${_TMP}/params_syn.json'));import sys;sys.exit(0 if ('custom_dataset_type' not in d and 'input_file' not in d) else 1)"
_check "synthetic params: custom_dataset_type / input_file OMITTED" $?

# DatasetConfig empty (not passed) under synthetic path.
[ ! -s "${_TMP}/dsconfig_syn.json" ] || [ "$(tr -d '[:space:]' < "${_TMP}/dsconfig_syn.json")" = "" ]
_check "synthetic: DATASET_CONFIG_JSON empty (--dataset-config not passed)" $?

echo ""
echo "BL100 do/benchmark construction: ${_pass} passed, ${_fail} failed"
[ "${_fail}" -eq 0 ]

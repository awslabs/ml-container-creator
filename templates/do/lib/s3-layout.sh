#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# do/lib/s3-layout.sh — thin shell wrapper over do/lib/python/s3_layout.py, the
# ONE module that composes MLCC S3 paths (bucket consolidation R3, Option D).
# Shell callers never assemble models/, .mlcc-adapters/ or fine-tune keys
# themselves (test/unit/s3-layout-path-drift.test.js); they call these helpers.
# Bucket names come from do/lib/profile.sh (CORE_S3_BUCKET, ARTIFACTS_S3_BUCKET).
# bash 3.2 compatible. Requires SCRIPT_DIR (the do/ directory).

# _s3_layout <subcommand> [args...] — run s3_layout.py (JSON on stdout).
_s3_layout() {
    python3 "${SCRIPT_DIR}/lib/python/s3_layout.py" "$@"
}

# _s3_layout_field <json> <key> — one field of a s3_layout.py JSON result.
_s3_layout_field() {
    printf '%s' "$1" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read() or "{}")
except ValueError:
    d = {}
v = d.get(sys.argv[1], "") if isinstance(d, dict) else ""
print("" if v is None else v)
' "$2"
}

# _s3_layout_promote <raw-uri> <adapter|model> <name> <technique> <source-job> <base-id> <created-by>
# Publish a finished job's servable output from the artifacts bucket to its
# canonical home in the core bucket, with a manifest (source job, technique,
# rank, base model, content hash, timestamp):
#   adapter → <base prefix>/.mlcc-adapters/<project>/<name>/v<hash12>/   (mlcc-adapter.json;
#             content-addressed, BL199: new content → a new version directory)
#   model   → models/mlcc-<project>/<name>/                    (mlcc-model.json)
# Idempotent on the source content hash. Sets PROMOTED_URI (the location
# s3_layout.py reports, never re-derived here); leaves it empty on
# any failure (warned) so the caller keeps the raw path — a promotion problem
# never fails the job that produced the output.
PROMOTED_URI=""
_s3_layout_promote() {
    local _raw="$1" _otype="$2" _name="$3" _tech="$4" _job="$5" _base="$6" _by="${7:-do}"
    local _kind="lora_adapter" _dest_json _dest _out
    PROMOTED_URI=""
    if [ -z "${CORE_S3_BUCKET:-}" ]; then
        echo "   ⚠️  Not promoted: the profile has no coreS3Bucket (ml-container-creator bootstrap update --module core)."
        return 0
    fi
    if [ "${_otype}" = "adapter" ]; then
        _dest_json=$(_s3_layout adapter-uri --bucket "${CORE_S3_BUCKET}" --model "${_base}" \
            --project "${PROJECT_NAME}" --name "${_name}" 2>&1) || {
            echo "   ⚠️  Not promoted: ${_dest_json}"
            return 0
        }
    else
        _kind="full_model"
        _dest_json=$(_s3_layout finetune-uri --bucket "${CORE_S3_BUCKET}" \
            --project "${PROJECT_NAME}" --name "${_name}" 2>&1) || {
            echo "   ⚠️  Not promoted: ${_dest_json}"
            return 0
        }
    fi
    _dest=$(_s3_layout_field "${_dest_json}" uri)
    [ -n "${_dest}" ] || return 0
    echo "   📤 Promoting to the canonical prefix: ${_dest}"
    # stderr is kept apart so stdout stays the JSON result; its "dest" is the
    # promoted location (an adapter's content-addressed version <home>/v<hash12>/, BL199).
    local _errf
    _errf="$(mktemp)"
    if ! _out=$(_s3_layout promote --source "${_raw}" --dest "${_dest}" --kind "${_kind}" \
        --project "${PROJECT_NAME}" --name "${_name}" --base-model "${_base}" --source-job "${_job}" \
        --technique "${_tech}" --created-by "${_by}" --region "${AWS_REGION:-}" 2>"${_errf}"); then
        echo "   ⚠️  Promotion failed (the raw output stays the recorded path). Retry later with"
        echo "      ./do/adapter promote ${_name} --from-tune ${_tech} --update-config"
        { printf '%s\n' "${_out}"; cat "${_errf}"; } | sed '/^[[:space:]]*$/d; s/^/      /'
        rm -f "${_errf}"
        return 0
    fi
    rm -f "${_errf}"
    PROMOTED_URI=$(_s3_layout_field "${_out}" dest)
    if [ -z "${PROMOTED_URI}" ]; then
        echo "   ⚠️  Promotion result unreadable (the raw output stays the recorded path): ${_out}"
        return 0
    fi
    echo "   ✅ Promoted ($(_s3_layout_field "${_out}" action)): ${PROMOTED_URI}"
}

# _s3_layout_clean_project <force:true|false>
# `./do/clean adapters` (Wave 6.1 R1.7, bucket consolidation R3.6): delete ONLY
# this project's canonical adapters (models/<org>/<base>/.mlcc-adapters/<project>/
# under every base) and its full fine-tunes (models/mlcc-<project>/) from the core
# bucket. Never another project's adapters, never base-model weights — the key
# filter is s3_layout.is_project_owned_key. Recorded raw job output in the
# artifacts bucket is not touched (re-promote with ./do/adapter promote).
_s3_layout_clean_project() {
    local _force="${1:-false}" _plan _n
    _require_bucket CORE_S3_BUCKET || return 1
    _plan=$(_s3_layout clean-plan --bucket "${CORE_S3_BUCKET}" --project "${PROJECT_NAME}" \
        --region "${AWS_REGION:-}") || return 1
    _n=$(printf '%s' "${_plan}" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["keys"]))')
    echo "🧹 Canonical artifacts of project ${PROJECT_NAME} in s3://${CORE_S3_BUCKET}/:"
    if [ "${_n}" = "0" ]; then
        echo "   (none)"
        return 0
    fi
    printf '%s' "${_plan}" | python3 -c 'import json,sys
for p in json.load(sys.stdin)["prefixes"]:
    print("   • " + p)'
    echo "   ${_n} objects. Base models and other projects' adapters are not touched."
    if [ "${_force}" != "true" ]; then
        echo ""
        read -p "   Delete them? (yes/no): " -r
        if [[ ! "${REPLY}" =~ ^[Yy][Ee][Ss]$ ]]; then
            echo "❌ Operation cancelled"
            return 1
        fi
    fi
    _s3_layout clean --bucket "${CORE_S3_BUCKET}" --project "${PROJECT_NAME}" --region "${AWS_REGION:-}" >/dev/null || return 1
    echo "✅ Deleted ${_n} objects (this project's adapters and fine-tunes)."
}

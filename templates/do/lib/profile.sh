#!/usr/bin/env bash
# Profile loader — reads active bootstrap profile into _PROFILE[] associative array.
# Source this file after do/config. Values provide defaults; explicit env vars take precedence.
#
# Requires bash 4+ for associative array support.
# macOS ships with bash 3.2 — install bash 4+ via Homebrew: brew install bash
#
# Expected keys in _PROFILE:
#   awsRegion, accountId, awsProfile, roleArn, ecrRepositoryName,
#   benchmarkS3Bucket, ciBenchmarkResultsBucket, asyncS3Bucket, batchS3Bucket,
#   ciTableName, ciInfraProvisioned

# Temporarily disable unbound variable checking for profile loading
# (keys may not exist in the profile config, and declare -A behavior
# varies across bash versions with set -u)
set +u 2>/dev/null || true

declare -A _PROFILE 2>/dev/null || true
if command -v python3 &>/dev/null; then
    _PROFILE_RAW=$(python3 -c "
import json, os
try:
    with open(os.path.expanduser('~/.ml-container-creator/config.json')) as f:
        c = json.load(f)
    p = c['profiles'][c['activeProfile']]
    # Output as KEY=VALUE lines (simple, no JSON parsing in bash)
    for k, v in p.items():
        if isinstance(v, (str, int, float, bool)):
            print(f'{k}={v}')
except:
    pass
" 2>/dev/null) || _PROFILE_RAW=""

    if [ -n "${_PROFILE_RAW}" ]; then
        while IFS='=' read -r key value; do
            [ -n "${key}" ] && _PROFILE["${key}"]="${value}"
        done <<< "${_PROFILE_RAW}"
    fi
fi

set -u 2>/dev/null || true

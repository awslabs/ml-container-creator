#!/usr/bin/env bash
# Profile loader — reads active bootstrap profile into _PROFILE_<key> variables.
# Source this file after do/config. Values provide defaults; explicit env vars take precedence.
#
# POSIX-compatible: works on bash 3.2+ (macOS default) and bash 4+/5+.
# No associative arrays required.
#
# After sourcing, access values via:
#   ${_PROFILE_roleArn:-}
#   ${_PROFILE_ecrRepositoryName:-ml-container-creator}
#   ${_PROFILE_awsRegion:-us-east-1}
#   ${_PROFILE_accountId:-}
#   ${_PROFILE_benchmarkS3Bucket:-}
#   ${_PROFILE_asyncS3Bucket:-}
#   ${_PROFILE_batchS3Bucket:-}
#
# Expected keys (set as _PROFILE_<key>):
#   awsRegion, accountId, awsProfile, roleArn, ecrRepositoryName,
#   benchmarkS3Bucket, ciBenchmarkResultsBucket, asyncS3Bucket, batchS3Bucket,
#   ciTableName, ciInfraProvisioned

# Temporarily disable unbound variable checking for profile loading
set +u 2>/dev/null || true

if command -v python3 &>/dev/null; then
    _PROFILE_RAW=$(python3 -c "
import json, os
try:
    with open(os.path.expanduser('~/.ml-container-creator/config.json')) as f:
        c = json.load(f)
    p = c['profiles'][c['activeProfile']]
    # Output as _PROFILE_KEY=VALUE lines — safe for eval with known prefix
    for k, v in p.items():
        if isinstance(v, (str, int, float, bool)):
            # Sanitize: only allow alphanumeric key names
            if k.isalnum() or all(c.isalnum() or c == '_' for c in k):
                print(f'_PROFILE_{k}=\"{v}\"')
except:
    pass
" 2>/dev/null) || _PROFILE_RAW=""

    if [ -n "${_PROFILE_RAW}" ]; then
        eval "${_PROFILE_RAW}"
    fi
fi

# NOTE: set -u is NOT re-enabled here. The caller is responsible for managing
# their own shell options.

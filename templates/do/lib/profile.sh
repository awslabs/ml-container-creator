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
#   trainingS3Bucket, adapterS3Bucket, modelsS3Bucket,
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
    # Emit provisionedModules as comma-separated string for guard checks
    modules = p.get('provisionedModules', [])
    if isinstance(modules, list) and modules:
        print(f'_PROFILE_provisionedModules=\"{(\",\").join(modules)}\"')
except:
    pass
" 2>/dev/null) || _PROFILE_RAW=""

    if [ -n "${_PROFILE_RAW}" ]; then
        eval "${_PROFILE_RAW}"
    fi
fi

# Map commonly-used profile values to the variable names scripts expect.
# Explicit env vars take precedence (${X:-...} pattern).
ROLE_ARN="${ROLE_ARN:-${_PROFILE_roleArn:-}}"
CI_BENCHMARK_RESULTS_BUCKET="${CI_BENCHMARK_RESULTS_BUCKET:-${_PROFILE_ciBenchmarkResultsBucket:-}}"
# Training module buckets (denormalized from moduleOutputs.training by bootstrap)
S3_BUCKET="${S3_BUCKET:-${_PROFILE_trainingS3Bucket:-}}"
ADAPTER_S3_BUCKET="${ADAPTER_S3_BUCKET:-${_PROFILE_adapterS3Bucket:-}}"
# Core bucket (staged weights, lifecycle scripts, etc.) — from moduleOutputs.core.ModelsBucket
# _PROFILE_coreS3Bucket is the canonical key (BL072); _PROFILE_modelsS3Bucket is the deprecated alias
MODELS_S3_BUCKET="${MODELS_S3_BUCKET:-${_PROFILE_coreS3Bucket:-${_PROFILE_modelsS3Bucket:-}}}"
CODEBUILD_SOURCE_S3_BUCKET="${CODEBUILD_SOURCE_S3_BUCKET:-${_PROFILE_codebuildSourceS3Bucket:-}}"

# ── Profile secrets (BL076) ───────────────────────────────────────────────
# Secret ARNs are stored in the active bootstrap profile's 'secrets' map.
# profile.sh exports them as _PROFILE_secrets_<key> so scripts can resolve
# them without hardcoding account-specific ARNs.
if command -v python3 &>/dev/null; then
    _PROFILE_SECRETS_RAW=$(python3 -c "
import json, os
try:
    with open(os.path.expanduser('~/.ml-container-creator/config.json')) as f:
        c = json.load(f)
    p = c['profiles'][c['activeProfile']]
    for k, v in p.get('secrets', {}).items():
        if isinstance(v, str) and all(c.isalnum() or c == '_' for c in k):
            print(f'_PROFILE_secrets_{k}=\"{v}\"')
except:
    pass
" 2>/dev/null) || _PROFILE_SECRETS_RAW=""
    if [ -n "${_PROFILE_SECRETS_RAW}" ]; then
        eval "${_PROFILE_SECRETS_RAW}"
    fi
fi

# ── Secret auto-discovery (BL067 runtime extension) ───────────────────────
# If no hfToken secret is registered in the active profile, attempt to
# discover one from Secrets Manager by name pattern. This enables seamless
# profile switching: when you move to a new account/region that has an HF
# token stored under a known naming convention, it's found automatically.
# Discovery is non-blocking — failures are silent and scripts fall back to
# prompting or proceeding without a token.
if [ -z "${_PROFILE_secrets_hfToken:-}" ] && command -v python3 &>/dev/null && [ -n "${_PROFILE_awsRegion:-}" ]; then
    _DISCOVERED_HF_ARN=$(python3 -c "
import boto3, os, sys
region = '${_PROFILE_awsRegion:-us-east-1}'
profile_name = '${_PROFILE_awsProfile:-}'
try:
    session_args = {'region_name': region}
    if profile_name:
        session_args['profile_name'] = profile_name
    session = boto3.Session(**session_args)
    client = session.client('secretsmanager', region_name=region)
    # Search for secrets matching common MLCC HF token naming patterns
    for name_filter in ['mlcc', 'huggingface', 'hf-token', 'hf_token']:
        resp = client.list_secrets(Filters=[{'Key': 'name', 'Values': [name_filter]}], MaxResults=10)
        for secret in resp.get('SecretList', []):
            sname = (secret.get('Name') or '').lower()
            # Match secrets that look like HF tokens (contain 'hf' and 'token')
            if 'hf' in sname and 'token' in sname:
                print(secret['ARN'])
                sys.exit(0)
            # Also match 'huggingface' named secrets
            if 'huggingface' in sname:
                print(secret['ARN'])
                sys.exit(0)
except:
    pass
" 2>/dev/null) || _DISCOVERED_HF_ARN=""
    if [ -n "${_DISCOVERED_HF_ARN}" ]; then
        _PROFILE_secrets_hfToken="${_DISCOVERED_HF_ARN}"
    fi
fi

# NGC API key auto-discovery (same pattern as HF token)
if [ -z "${_PROFILE_secrets_ngcApiKey:-}" ] && command -v python3 &>/dev/null && [ -n "${_PROFILE_awsRegion:-}" ]; then
    _DISCOVERED_NGC_ARN=$(python3 -c "
import boto3, sys
region = '${_PROFILE_awsRegion:-us-east-1}'
profile_name = '${_PROFILE_awsProfile:-}'
try:
    session_args = {'region_name': region}
    if profile_name:
        session_args['profile_name'] = profile_name
    session = boto3.Session(**session_args)
    client = session.client('secretsmanager', region_name=region)
    for name_filter in ['mlcc', 'ngc', 'nvidia']:
        resp = client.list_secrets(Filters=[{'Key': 'name', 'Values': [name_filter]}], MaxResults=10)
        for secret in resp.get('SecretList', []):
            sname = (secret.get('Name') or '').lower()
            if 'ngc' in sname and ('api' in sname or 'key' in sname or 'token' in sname):
                print(secret['ARN'])
                sys.exit(0)
            if 'nvidia' in sname and ('api' in sname or 'key' in sname):
                print(secret['ARN'])
                sys.exit(0)
except:
    pass
" 2>/dev/null) || _DISCOVERED_NGC_ARN=""
    if [ -n "${_DISCOVERED_NGC_ARN}" ]; then
        _PROFILE_secrets_ngcApiKey="${_DISCOVERED_NGC_ARN}"
    fi
fi

# ── Bucket resolver (BL076) ───────────────────────────────────────────────
# Constructs an MLCC S3 bucket name from the active profile at runtime,
# eliminating hardcoded account IDs in do/config.
# Usage: $(_resolve_bucket core)  → mlcc-core-<accountId>-<region>
_resolve_bucket() {
    local purpose="${1:?_resolve_bucket requires a purpose argument}"
    echo "mlcc-${purpose}-${_PROFILE_accountId:-unknown}-${_PROFILE_awsRegion:-us-east-1}"
}

# Export AWS_PROFILE so boto3/sagemaker-core Python scripts authenticate
# using the same profile as the CLI. Without this, Python SDK calls fail
# with "Unable to locate credentials" when the profile uses SSO or
# federated credentials.
if [ -z "${AWS_PROFILE:-}" ] && [ -n "${_PROFILE_awsProfile:-}" ]; then
    export AWS_PROFILE="${_PROFILE_awsProfile}"
fi

# NOTE: set -u is NOT re-enabled here. The caller is responsible for managing
# their own shell options.

#!/usr/bin/env bash
# Profile loader — reads active bootstrap profile into _PROFILE_<key> variables.
# Source this file after do/config. Values provide defaults; explicit env vars take precedence.
#
# POSIX-compatible: works on bash 3.2+ (macOS default) and bash 4+/5+.
# No associative arrays required.
#
# Set MLCC_SKIP_SECRET_DISCOVERY=1 to skip AWS Secrets Manager auto-discovery
# (HF/NGC token lookup). Useful offline, in CI, and in unit tests where the
# boto3 calls would otherwise block on credential/endpoint resolution.
#
# After sourcing, access values via:
#   ${_PROFILE_roleArn:-}
#   ${_PROFILE_ecrRepositoryName:-ml-container-creator}
#   ${_PROFILE_awsRegion:-us-east-1}
#   ${_PROFILE_accountId:-}
#   ${_PROFILE_benchmarkS3Bucket:-}
#
# Expected keys (set as _PROFILE_<key>):
#   awsRegion, accountId, awsProfile, roleArn, ecrRepositoryName,
#   coreS3Bucket, artifactsS3Bucket, benchmarkS3Bucket, codebuildSourceS3Bucket,
#   ciBenchmarkResultsBucket, trainingS3Bucket, adapterS3Bucket, modelsS3Bucket,
#   ciTableName, ciInfraProvisioned, mlflowAppArn
#
# BUCKET NAMES (bucket consolidation R2.1): profile keys are the ONLY source of a
# bucket name. Bootstrap writes them from the owning stack's CloudFormation outputs
# (infra/bootstrap-modules/<stack dir>/buckets.json declares each bucket once).
# Nothing here or in any do/ script rebuilds a name from the account/region, and
# there is no literal fallback. A caller that needs a bucket runs
#   _require_bucket CORE_S3_BUCKET || exit 1
# which fails fast naming the bootstrap module to add.

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
# ── Bucket names (profile keys → env vars; explicit env vars take precedence) ──
# Core models bucket (staged weights, datasets, reward prompts, lifecycle scripts)
# — moduleOutputs.core.ModelsBucket → coreS3Bucket. modelsS3Bucket is the
# deprecated alias key; MODELS_S3_BUCKET is kept as an alias env var.
CORE_S3_BUCKET="${CORE_S3_BUCKET:-${MODELS_S3_BUCKET:-${_PROFILE_coreS3Bucket:-${_PROFILE_modelsS3Bucket:-}}}}"
MODELS_S3_BUCKET="${MODELS_S3_BUCKET:-${CORE_S3_BUCKET}}"
# Artifacts bucket (per-project tune/train/optimize output + MLflow store) —
# moduleOutputs.training.ArtifactsBucket → artifactsS3Bucket. TUNE_S3_BUCKET is
# accepted ONLY as an override alias (older do/config files may export it).
ARTIFACTS_S3_BUCKET="${ARTIFACTS_S3_BUCKET:-${TUNE_S3_BUCKET:-${_PROFILE_artifactsS3Bucket:-}}}"
TUNE_S3_BUCKET="${TUNE_S3_BUCKET:-${ARTIFACTS_S3_BUCKET}}"
# Benchmark results bucket — moduleOutputs.benchmark.BenchmarkBucket → benchmarkS3Bucket.
BENCHMARK_S3_BUCKET="${BENCHMARK_S3_BUCKET:-${_PROFILE_benchmarkS3Bucket:-${_PROFILE_ciBenchmarkResultsBucket:-}}}"
# CodeBuild source bucket — moduleOutputs.ci.SourceBucket → codebuildSourceS3Bucket.
CODEBUILD_SOURCE_S3_BUCKET="${CODEBUILD_SOURCE_S3_BUCKET:-${_PROFILE_codebuildSourceS3Bucket:-}}"
# Legacy (frozen) training-module buckets — kept readable for recorded URIs.
S3_BUCKET="${S3_BUCKET:-${_PROFILE_trainingS3Bucket:-}}"
ADAPTER_S3_BUCKET="${ADAPTER_S3_BUCKET:-${_PROFILE_adapterS3Bucket:-}}"

# _require_bucket <ENV_VAR>
# Fail fast (return 1, message on stderr) when a bucket the caller needs is not in
# the active profile. Names the profile key and the bootstrap module that provides
# it. The env var ↔ profile key ↔ module table mirrors the stacks' buckets.json
# declarations; test/unit/no-literal-bucket-names.test.js asserts they agree.
_require_bucket() {
    local _rb_var="${1:?_require_bucket requires an env var name}"
    local _rb_key="" _rb_module="" _rb_val=""
    case "${_rb_var}" in
        CORE_S3_BUCKET) _rb_key="coreS3Bucket"; _rb_module="core" ;;
        ARTIFACTS_S3_BUCKET) _rb_key="artifactsS3Bucket"; _rb_module="training" ;;
        BENCHMARK_S3_BUCKET) _rb_key="benchmarkS3Bucket"; _rb_module="benchmark" ;;
        CODEBUILD_SOURCE_S3_BUCKET) _rb_key="codebuildSourceS3Bucket"; _rb_module="ci" ;;
        *) echo "❌ _require_bucket: unknown bucket variable '${_rb_var}'" >&2; return 2 ;;
    esac
    eval "_rb_val=\"\${${_rb_var}:-}\""
    if [ -n "${_rb_val}" ]; then
        return 0
    fi
    echo "❌ No ${_rb_var}: the active bootstrap profile has no '${_rb_key}'." >&2
    echo "   This bucket is provided by the '${_rb_module}' bootstrap module. Add it:" >&2
    echo "     ml-container-creator bootstrap add-module ${_rb_module}" >&2
    if [ "${_rb_module}" = "core" ]; then
        echo "   (core is always provisioned — refresh the profile: ml-container-creator bootstrap update --module core)" >&2
    else
        echo "   (already provisioned? refresh the profile: ml-container-creator bootstrap update --module ${_rb_module})" >&2
    fi
    if [ "${_rb_var}" = "ARTIFACTS_S3_BUCKET" ]; then
        echo "   (existing profiles can also seed it from the MLflow App: ml-container-creator bootstrap migrate)" >&2
    fi
    echo "   Or set ${_rb_var} explicitly to an existing bucket." >&2
    return 1
}
# ── MLflow tracking ref (BL163) ───────────────────────────────────────────
# Map the profile's mlflowAppArn (the one key the bootstrap ensureMlflowApp()
# denormalizes) to the env var the tune path consumes (tune_submit.py reads
# MLFLOW_APP_ARN from the environment). This gives the tune flow the SAME
# profile-resolved tracking ref the register/list/resolve flows already use
# via _config_tracking_uri(), with no manual step. EXPORTED (unlike the bucket
# vars) because tune_submit.py reads it through os.environ. When the profile
# has no mlflowAppArn the value stays empty and the tune path wires no MLflow
# (today's behavior) — it never falls back to a local ./mlruns store.
MLFLOW_APP_ARN="${MLFLOW_APP_ARN:-${_PROFILE_mlflowAppArn:-}}"
[ -n "${MLFLOW_APP_ARN}" ] && export MLFLOW_APP_ARN

# Map the profile's rewardLambdaRoleArn (provisioned by the training bootstrap
# module — the dual-trust sagemaker+lambda role) to the env var the evaluator
# register path consumes. `do/register evaluator --finalize` reads
# MLCC_REWARD_LAMBDA_ROLE_ARN from the environment to pass as the created Lambda's
# execution role; without it, SageMaker's create fails with a Lambda trust error.
# EXPORTED (like MLFLOW_APP_ARN) because register_evaluator reads os.environ. Empty
# when the module predates this role — the register path then guides the user to
# re-bootstrap the training module.
MLCC_REWARD_LAMBDA_ROLE_ARN="${MLCC_REWARD_LAMBDA_ROLE_ARN:-${_PROFILE_rewardLambdaRoleArn:-}}"
[ -n "${MLCC_REWARD_LAMBDA_ROLE_ARN}" ] && export MLCC_REWARD_LAMBDA_ROLE_ARN
# Map the profile's hpTrainRoleArn (Wave 11 R3.2: the training bootstrap module's
# Pod Identity role for HyperPod training jobs) to MLCC_HP_TRAIN_ROLE_ARN. The
# hp-eks cluster contract (hyperpod_ops.py contract) checks the owner's
# association for mlcc-train-sa points at exactly this role and prints the
# create command otherwise. Empty when the training module predates the role.
MLCC_HP_TRAIN_ROLE_ARN="${MLCC_HP_TRAIN_ROLE_ARN:-${_PROFILE_hpTrainRoleArn:-}}"
[ -n "${MLCC_HP_TRAIN_ROLE_ARN}" ] && export MLCC_HP_TRAIN_ROLE_ARN

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
if [ -z "${MLCC_SKIP_SECRET_DISCOVERY:-}" ] && [ -z "${_PROFILE_secrets_hfToken:-}" ] && command -v python3 &>/dev/null && [ -n "${_PROFILE_awsRegion:-}" ]; then
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
if [ -z "${MLCC_SKIP_SECRET_DISCOVERY:-}" ] && [ -z "${_PROFILE_secrets_ngcApiKey:-}" ] && command -v python3 &>/dev/null && [ -n "${_PROFILE_awsRegion:-}" ]; then
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

# (The BL076 _resolve_bucket helper that rebuilt mlcc-<purpose>-<acct>-<region>
# names by convention was removed — bucket names come only from profile keys.)

# Export AWS_PROFILE so boto3/sagemaker-core Python scripts authenticate
# using the same profile as the CLI. Without this, Python SDK calls fail
# with "Unable to locate credentials" when the profile uses SSO or
# federated credentials.
if [ -z "${AWS_PROFILE:-}" ] && [ -n "${_PROFILE_awsProfile:-}" ]; then
    export AWS_PROFILE="${_PROFILE_awsProfile}"
fi

# NOTE: set -u is NOT re-enabled here. The caller is responsible for managing
# their own shell options.

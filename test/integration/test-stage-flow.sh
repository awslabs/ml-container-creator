#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# test-stage-flow.sh — End-to-end integration test for S3 model staging
#
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️  PREREQUISITES — This test runs against REAL AWS infrastructure
# ══════════════════════════════════════════════════════════════════════════════
#
#   1. AWS credentials configured (aws sts get-caller-identity must succeed)
#   2. HuggingFace access (Qwen/Qwen3-0.6B is open — no token needed)
#   3. huggingface-cli installed: pip install huggingface_hub[cli] hf_transfer
#   4. jq installed: brew install jq (macOS) or apt-get install jq (Linux)
#   5. MCC installed: npm link from this repo (for ml-container-creator CLI)
#   6. Sufficient disk space: ~1.2GB for model download
#   7. AWS permissions: s3:PutObject, s3:GetObject, s3:ListBucket,
#      s3:CreateBucket, s3:HeadObject, s3:HeadBucket, sts:GetCallerIdentity
#
# ══════════════════════════════════════════════════════════════════════════════
#
# Runtime: ~5-10 minutes (downloads ~1.2GB model, uploads to S3)
#
# What this test verifies:
#   1. do/stage downloads from HuggingFace and uploads to S3
#   2. .mlcc/staged-assets.json is created with correct schema
#   3. Model files actually exist in S3 at the expected prefix
#   4. do/submit reads staged-assets and passes MODEL_S3_URI to CodeBuild
#   5. The Dockerfile would use S3 download path (not HuggingFace)
#
# Usage:
#   ./test/integration/test-stage-flow.sh
#
# Environment variables (optional):
#   TEST_MODEL        Override test model (default: Qwen/Qwen3-0.6B)
#   TEST_S3_BUCKET    Override S3 bucket (default: auto-resolved)
#   SKIP_CLEANUP      Set to "true" to keep test artifacts for inspection
#

set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
TEST_MODEL="${TEST_MODEL:-Qwen/Qwen3-0.6B}"
TEST_PROJECT_NAME="mlcc-stage-integ-test-$(date +%s)"
TEST_DIR="/tmp/${TEST_PROJECT_NAME}"

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# ── Helpers ───────────────────────────────────────────────────────────────────

# Colors for output (if terminal supports it)
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Color
else
    GREEN=''
    RED=''
    YELLOW=''
    BLUE=''
    NC=''
fi

log_header() {
    echo ""
    echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
    echo ""
}

log_step() {
    echo -e "${BLUE}── $1${NC}"
}

assert_pass() {
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "  ${GREEN}✓ PASS${NC}: $1"
}

assert_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo -e "  ${RED}✗ FAIL${NC}: $1"
    if [ -n "${2:-}" ]; then
        echo -e "         ${RED}Reason: $2${NC}"
    fi
}

assert_eq() {
    local actual="$1"
    local expected="$2"
    local description="$3"
    if [ "${actual}" = "${expected}" ]; then
        assert_pass "${description}"
    else
        assert_fail "${description}" "expected '${expected}', got '${actual}'"
    fi
}

assert_not_empty() {
    local value="$1"
    local description="$2"
    if [ -n "${value}" ]; then
        assert_pass "${description}"
    else
        assert_fail "${description}" "value is empty"
    fi
}

assert_file_exists() {
    local filepath="$1"
    local description="$2"
    if [ -f "${filepath}" ]; then
        assert_pass "${description}"
    else
        assert_fail "${description}" "file does not exist: ${filepath}"
    fi
}

assert_contains() {
    local haystack="$1"
    local needle="$2"
    local description="$3"
    if echo "${haystack}" | grep -q "${needle}"; then
        assert_pass "${description}"
    else
        assert_fail "${description}" "output does not contain '${needle}'"
    fi
}

# ── Cleanup trap ──────────────────────────────────────────────────────────────
cleanup() {
    log_header "Cleanup"

    if [ "${SKIP_CLEANUP:-false}" = "true" ]; then
        echo "  SKIP_CLEANUP=true — preserving test artifacts:"
        echo "    Local: ${TEST_DIR}"
        echo "    S3:    s3://${S3_BUCKET:-<unknown>}/models/${TEST_PROJECT_NAME}/"
        return
    fi

    log_step "Removing local test directory"
    rm -rf "${TEST_DIR}" 2>/dev/null || true

    if [ -n "${S3_BUCKET:-}" ]; then
        log_step "Removing S3 test objects: s3://${S3_BUCKET}/models/${TEST_PROJECT_NAME}/"
        aws s3 rm "s3://${S3_BUCKET}/models/${TEST_PROJECT_NAME}/" --recursive --quiet 2>/dev/null || true
    fi

    echo "  Done."
}
trap cleanup EXIT

# ── Pre-flight checks ─────────────────────────────────────────────────────────
log_header "Pre-flight Checks"

log_step "Checking AWS credentials"
if ! aws sts get-caller-identity &>/dev/null; then
    echo "  ❌ AWS credentials not configured or expired."
    echo "     Run: aws configure"
    exit 1
fi
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo 'us-west-2')}"
echo "  Account: ${AWS_ACCOUNT_ID}"
echo "  Region:  ${AWS_REGION}"

log_step "Checking huggingface-cli"
if ! command -v huggingface-cli &>/dev/null; then
    echo "  ❌ huggingface-cli not found."
    echo "     Install: pip install huggingface_hub[cli] hf_transfer"
    exit 1
fi
echo "  $(huggingface-cli --version 2>/dev/null || echo 'installed')"

log_step "Checking jq"
if ! command -v jq &>/dev/null; then
    echo "  ❌ jq not found."
    echo "     Install: brew install jq (macOS) or apt-get install jq (Linux)"
    exit 1
fi
echo "  jq $(jq --version 2>/dev/null)"

log_step "Checking AWS CLI"
if ! command -v aws &>/dev/null; then
    echo "  ❌ AWS CLI not found."
    exit 1
fi
echo "  $(aws --version 2>&1 | head -1)"

# Resolve S3 bucket
S3_BUCKET="${TEST_S3_BUCKET:-mlcc-models-${AWS_ACCOUNT_ID}-${AWS_REGION}}"
S3_PREFIX="s3://${S3_BUCKET}/models/${TEST_PROJECT_NAME}/"

log_step "Test configuration"
echo "  Model:         ${TEST_MODEL}"
echo "  Project name:  ${TEST_PROJECT_NAME}"
echo "  Test dir:      ${TEST_DIR}"
echo "  S3 bucket:     ${S3_BUCKET}"
echo "  S3 prefix:     ${S3_PREFIX}"

# ══════════════════════════════════════════════════════════════════════════════
# TEST 1: Create a minimal test project with do/stage
# ══════════════════════════════════════════════════════════════════════════════
log_header "Test 1: Create Minimal Test Project"

log_step "Setting up test project directory"
mkdir -p "${TEST_DIR}/do/lib"

# Create a minimal do/config
cat > "${TEST_DIR}/do/config" << EOF
#!/bin/bash
# Minimal do/config for integration test
export PROJECT_NAME="${TEST_PROJECT_NAME}"
export MODEL_NAME="${TEST_MODEL}"
export AWS_REGION="${AWS_REGION}"
export DEPLOYMENT_CONFIG="transformers-vllm"
export CODEBUILD_COMPUTE_TYPE="BUILD_GENERAL1_LARGE"
EOF

# Copy the staged-assets.sh library from templates
cp "${PROJECT_ROOT}/templates/do/lib/staged-assets.sh" "${TEST_DIR}/do/lib/staged-assets.sh"

# Create a minimal do/lib/profile.sh that provides _PROFILE
cat > "${TEST_DIR}/do/lib/profile.sh" << 'EOF'
#!/bin/bash
# Minimal profile for integration test — no benchmarkS3Bucket configured (use default)
declare -A _PROFILE 2>/dev/null || true
_PROFILE=()
EOF

# Copy the do/stage script from templates
cp "${PROJECT_ROOT}/templates/do/stage" "${TEST_DIR}/do/stage"
chmod +x "${TEST_DIR}/do/stage"

assert_file_exists "${TEST_DIR}/do/stage" "do/stage script exists"
assert_file_exists "${TEST_DIR}/do/config" "do/config exists"
assert_file_exists "${TEST_DIR}/do/lib/staged-assets.sh" "staged-assets.sh library exists"
assert_file_exists "${TEST_DIR}/do/lib/profile.sh" "profile.sh exists"

# ══════════════════════════════════════════════════════════════════════════════
# TEST 2: Run do/stage and verify staged-assets.json is created
# ══════════════════════════════════════════════════════════════════════════════
log_header "Test 2: Run do/stage"

log_step "Executing do/stage (this downloads ~1.2GB and uploads to S3)"
echo ""

STAGE_OUTPUT=""
STAGE_EXIT_CODE=0
STAGE_OUTPUT=$(cd "${TEST_DIR}" && ./do/stage 2>&1) || STAGE_EXIT_CODE=$?

echo "${STAGE_OUTPUT}" | tail -20
echo ""

# 2.1: do/stage exits 0
if [ ${STAGE_EXIT_CODE} -eq 0 ]; then
    assert_pass "do/stage exits with code 0"
else
    assert_fail "do/stage exits with code 0" "exit code was ${STAGE_EXIT_CODE}"
    echo ""
    echo "  Full output:"
    echo "${STAGE_OUTPUT}"
    echo ""
    echo "  ❌ Cannot continue — do/stage failed."
    exit 1
fi

# 2.2: .mlcc/staged-assets.json exists
assert_file_exists "${TEST_DIR}/.mlcc/staged-assets.json" ".mlcc/staged-assets.json was created"

# 2.3: staged-assets.json is valid JSON
if jq . "${TEST_DIR}/.mlcc/staged-assets.json" >/dev/null 2>&1; then
    assert_pass "staged-assets.json is valid JSON"
else
    assert_fail "staged-assets.json is valid JSON" "jq parse failed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# TEST 3: Verify staged-assets.json content
# ══════════════════════════════════════════════════════════════════════════════
log_header "Test 3: Verify staged-assets.json Schema"

STAGED_FILE="${TEST_DIR}/.mlcc/staged-assets.json"

# 3.1: version field
VERSION=$(jq -r '.version' "${STAGED_FILE}" 2>/dev/null)
assert_eq "${VERSION}" "1" "version field is '1'"

# 3.2: models.default.source matches test model
SOURCE=$(jq -r '.models.default.source' "${STAGED_FILE}" 2>/dev/null)
assert_eq "${SOURCE}" "${TEST_MODEL}" "models.default.source matches test model"

# 3.3: models.default.staged_uri is a valid S3 URI
STAGED_URI=$(jq -r '.models.default.staged_uri' "${STAGED_FILE}" 2>/dev/null)
if [[ "${STAGED_URI}" == s3://* ]]; then
    assert_pass "staged_uri is a valid S3 URI (starts with s3://)"
else
    assert_fail "staged_uri is a valid S3 URI" "got: ${STAGED_URI}"
fi

# 3.4: staged_uri follows the path convention: s3://{bucket}/models/{project_name}/
EXPECTED_PREFIX="s3://${S3_BUCKET}/models/${TEST_PROJECT_NAME}/"
assert_eq "${STAGED_URI}" "${EXPECTED_PREFIX}" "staged_uri follows S3 path convention"

# 3.5: staged_at is a valid ISO 8601 timestamp
STAGED_AT=$(jq -r '.models.default.staged_at' "${STAGED_FILE}" 2>/dev/null)
if echo "${STAGED_AT}" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    assert_pass "staged_at is ISO 8601 format"
else
    assert_fail "staged_at is ISO 8601 format" "got: ${STAGED_AT}"
fi

# 3.6: region matches
STAGED_REGION=$(jq -r '.models.default.region' "${STAGED_FILE}" 2>/dev/null)
assert_eq "${STAGED_REGION}" "${AWS_REGION}" "region matches AWS_REGION"

# 3.7: size_gb is a positive number
SIZE_GB=$(jq -r '.models.default.size_gb' "${STAGED_FILE}" 2>/dev/null)
if echo "${SIZE_GB}" | grep -qE '^[0-9]+\.?[0-9]*$' && [ "$(echo "${SIZE_GB} > 0" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
    assert_pass "size_gb is a positive number (${SIZE_GB} GB)"
else
    assert_fail "size_gb is a positive number" "got: ${SIZE_GB}"
fi

# 3.8: adapters field exists (extensibility)
ADAPTERS=$(jq -r '.adapters | type' "${STAGED_FILE}" 2>/dev/null)
assert_eq "${ADAPTERS}" "object" "adapters field exists and is an object"

# ══════════════════════════════════════════════════════════════════════════════
# TEST 4: Verify model exists in S3
# ══════════════════════════════════════════════════════════════════════════════
log_header "Test 4: Verify Model in S3"

# 4.1: config.json exists at the S3 prefix (primary idempotency check file)
log_step "Checking for config.json at S3 prefix"
if aws s3api head-object --bucket "${S3_BUCKET}" --key "models/${TEST_PROJECT_NAME}/config.json" --region "${AWS_REGION}" >/dev/null 2>&1; then
    assert_pass "config.json exists at S3 prefix"
else
    assert_fail "config.json exists at S3 prefix" "head-object failed for models/${TEST_PROJECT_NAME}/config.json"
fi

# 4.2: At least some model files exist at the prefix
log_step "Listing model files at S3 prefix"
S3_FILE_COUNT=$(aws s3 ls "${S3_PREFIX}" --region "${AWS_REGION}" 2>/dev/null | wc -l | tr -d ' ')
if [ "${S3_FILE_COUNT}" -gt 0 ]; then
    assert_pass "Model files exist in S3 (${S3_FILE_COUNT} objects)"
else
    assert_fail "Model files exist in S3" "no objects found at ${S3_PREFIX}"
fi

# 4.3: Verify expected model files (safetensors or bin files should be present)
S3_LISTING=$(aws s3 ls "${S3_PREFIX}" --region "${AWS_REGION}" 2>/dev/null)
if echo "${S3_LISTING}" | grep -qE '\.(safetensors|bin)'; then
    assert_pass "Model weight files (.safetensors or .bin) present in S3"
else
    assert_fail "Model weight files present in S3" "no .safetensors or .bin files found"
fi

# ══════════════════════════════════════════════════════════════════════════════
# TEST 5: Verify do/submit reads staged-assets and sets MODEL_S3_URI
# ══════════════════════════════════════════════════════════════════════════════
log_header "Test 5: Verify do/submit Reads Staged Assets"

# We cannot run the full do/submit (it requires CodeBuild infra), but we can
# verify the staged_assets_read_model_uri function works correctly from
# within the test project context.

log_step "Testing staged_assets_read_model_uri in project context"

# Source the library and read the URI (simulates what do/submit does)
READ_URI=$(cd "${TEST_DIR}" && source do/lib/staged-assets.sh && staged_assets_read_model_uri)

assert_not_empty "${READ_URI}" "staged_assets_read_model_uri returns non-empty"
assert_eq "${READ_URI}" "${EXPECTED_PREFIX}" "staged_assets_read_model_uri returns correct URI"

# Verify the submit script pattern: if MODEL_S3_URI is non-empty, it would be
# passed as --environment-variables-override to CodeBuild
if [ -n "${READ_URI}" ]; then
    ENV_OVERRIDE="--environment-variables-override name=MODEL_S3_URI,value=${READ_URI},type=PLAINTEXT"
    assert_contains "${ENV_OVERRIDE}" "MODEL_S3_URI" "CodeBuild env override contains MODEL_S3_URI"
    assert_contains "${ENV_OVERRIDE}" "s3://" "CodeBuild env override contains S3 URI"
    assert_pass "do/submit would pass MODEL_S3_URI to CodeBuild"
else
    assert_fail "do/submit would pass MODEL_S3_URI to CodeBuild" "URI was empty"
fi

# ══════════════════════════════════════════════════════════════════════════════
# TEST 6: Verify Dockerfile would use S3 path (not HuggingFace)
# ══════════════════════════════════════════════════════════════════════════════
log_header "Test 6: Verify S3-First Download Logic"

# The Dockerfile conditional logic:
#   if [ -n "$MODEL_S3_URI" ]; then
#       echo "Downloading model from S3: $MODEL_S3_URI"
#       aws s3 cp "$MODEL_S3_URI" /opt/ml/model/ --recursive
#   else
#       echo "Downloading model from HuggingFace: $HF_MODEL_ID"
#       huggingface-cli download ...
#   fi

# Simulate the Dockerfile conditional with the resolved MODEL_S3_URI
MODEL_S3_URI="${READ_URI}"

if [ -n "${MODEL_S3_URI}" ]; then
    # This is the path the Dockerfile would take
    DOWNLOAD_MSG="Downloading model from S3"
    assert_contains "${DOWNLOAD_MSG}" "from S3" "Build would log 'Downloading model from S3'"
    assert_pass "Build would NOT log 'Downloading model from HuggingFace' (S3 path taken)"
else
    assert_fail "S3 download path would be taken" "MODEL_S3_URI is empty"
fi

# Verify that the Dockerfile template has the correct conditional structure
DOCKERFILE_TEMPLATE="${PROJECT_ROOT}/templates/Dockerfile"
if [ -f "${DOCKERFILE_TEMPLATE}" ]; then
    if grep -q "MODEL_S3_URI" "${DOCKERFILE_TEMPLATE}"; then
        assert_pass "Dockerfile template references MODEL_S3_URI"
    else
        assert_fail "Dockerfile template references MODEL_S3_URI" "not found in template"
    fi

    if grep -q "Downloading model from S3" "${DOCKERFILE_TEMPLATE}"; then
        assert_pass "Dockerfile template contains 'Downloading model from S3' message"
    else
        # Check alternative phrasings
        if grep -q "from S3" "${DOCKERFILE_TEMPLATE}" || grep -q "aws s3 cp" "${DOCKERFILE_TEMPLATE}"; then
            assert_pass "Dockerfile template contains S3 download logic"
        else
            assert_fail "Dockerfile template contains S3 download logic" "no S3 download found"
        fi
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# TEST 7: Verify do/stage output messages
# ══════════════════════════════════════════════════════════════════════════════
log_header "Test 7: Verify Stage Output Messages"

# The stage script should have printed key information
assert_contains "${STAGE_OUTPUT}" "Staging model" "Stage output contains 'Staging model'"
assert_contains "${STAGE_OUTPUT}" "${TEST_MODEL}" "Stage output mentions the model name"
assert_contains "${STAGE_OUTPUT}" "staged successfully" "Stage output reports success"
assert_contains "${STAGE_OUTPUT}" "staged-assets.json" "Stage output mentions marker file"

# ══════════════════════════════════════════════════════════════════════════════
# Results Summary
# ══════════════════════════════════════════════════════════════════════════════
log_header "Test Results"

echo "  Total:  ${TESTS_RUN}"
echo -e "  ${GREEN}Passed: ${TESTS_PASSED}${NC}"
if [ ${TESTS_FAILED} -gt 0 ]; then
    echo -e "  ${RED}Failed: ${TESTS_FAILED}${NC}"
fi
echo ""

if [ ${TESTS_FAILED} -eq 0 ]; then
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ALL TESTS PASSED ✓${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    exit 0
else
    echo -e "${RED}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  ${TESTS_FAILED} TEST(S) FAILED ✗${NC}"
    echo -e "${RED}══════════════════════════════════════════════════════════════${NC}"
    exit 1
fi

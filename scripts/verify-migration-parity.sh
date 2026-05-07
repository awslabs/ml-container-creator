#!/bin/bash

# Migration Parity Verification Script
# Verifies that the new CLI correctly generates projects for all 15 deployment configs.
# Since the old Yeoman CLI has been removed, this validates the new CLI output
# against expected file structures and content for each architecture type.
#
# Usage: ./scripts/verify-migration-parity.sh [--config=CONFIG_NAME] [--verbose]
#
# Exit codes:
#   0 - All configs pass
#   1 - One or more configs fail

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_PATH="$PROJECT_ROOT/bin/cli.js"
TEMP_BASE="${TMPDIR:-/tmp}/mlcc-parity-$$"
SINGLE_CONFIG=""
VERBOSE="false"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Counters
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILED_CONFIGS=()

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --config=*)
            SINGLE_CONFIG="${1#*=}"
            shift
            ;;
        --verbose)
            VERBOSE="true"
            shift
            ;;
        --help)
            echo "Usage: $0 [--config=CONFIG_NAME] [--verbose]"
            echo ""
            echo "Options:"
            echo "  --config=NAME   Test only the specified deployment config"
            echo "  --verbose       Show detailed output"
            echo "  --help          Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Helper functions
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_pass() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_fail() {
    echo -e "${RED}❌ $1${NC}"
}

log_warn() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_verbose() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "   ${BLUE}$1${NC}"
    fi
}

cleanup() {
    if [[ -d "$TEMP_BASE" ]]; then
        rm -rf "$TEMP_BASE"
    fi
}

trap cleanup EXIT

# Create temp directory
mkdir -p "$TEMP_BASE"

# Generate a project for a given deployment config
generate_project() {
    local config_name="$1"
    local output_dir="$TEMP_BASE/$config_name"

    mkdir -p "$output_dir"

    log_verbose "Generating project: $config_name -> $output_dir"

    local stdout_file="$TEMP_BASE/${config_name}.stdout"
    local stderr_file="$TEMP_BASE/${config_name}.stderr"

    # Build extra args based on architecture requirements
    local extra_args=()
    case "$config_name" in
        diffusors-*)
            # Diffusors architecture requires a model name
            extra_args+=("--model-name=stabilityai/stable-diffusion-xl-base-1.0")
            ;;
    esac

    if VALIDATE_ENV_VARS=false node "$CLI_PATH" \
        --deployment-config="$config_name" \
        --skip-prompts \
        --project-dir="$output_dir" \
        "${extra_args[@]}" \
        > "$stdout_file" 2> "$stderr_file"; then
        # Verify that files were actually generated (CLI may exit 0 but skip generation)
        if [[ ! -f "$output_dir/deploy/build_and_push.sh" && ! -f "$output_dir/Dockerfile" ]]; then
            log_verbose "CLI exited 0 but no files generated"
            if [[ "$VERBOSE" == "true" ]]; then
                echo "  stdout: $(cat "$stdout_file")"
            fi
            return 1
        fi
        return 0
    else
        local exit_code=$?
        log_verbose "CLI exited with code $exit_code"
        if [[ "$VERBOSE" == "true" ]]; then
            echo "  stdout: $(head -5 "$stdout_file")"
            echo "  stderr: $(head -5 "$stderr_file")"
        fi
        return 1
    fi
}

# Check that a file exists in the project
assert_file_exists() {
    local project_dir="$1"
    local file_path="$2"

    if [[ -f "$project_dir/$file_path" ]]; then
        log_verbose "  ✓ File exists: $file_path"
        return 0
    else
        log_verbose "  ✗ Missing file: $file_path"
        return 1
    fi
}

# Check that a directory exists in the project
assert_dir_exists() {
    local project_dir="$1"
    local dir_path="$2"

    if [[ -d "$project_dir/$dir_path" ]]; then
        log_verbose "  ✓ Dir exists: $dir_path"
        return 0
    else
        log_verbose "  ✗ Missing dir: $dir_path"
        return 1
    fi
}

# Check that a file contains expected content
assert_file_contains() {
    local project_dir="$1"
    local file_path="$2"
    local expected="$3"

    if [[ ! -f "$project_dir/$file_path" ]]; then
        log_verbose "  ✗ File not found for content check: $file_path"
        return 1
    fi

    if grep -q "$expected" "$project_dir/$file_path"; then
        log_verbose "  ✓ Content found in $file_path: $expected"
        return 0
    else
        log_verbose "  ✗ Content NOT found in $file_path: $expected"
        return 1
    fi
}

# Validate common files present in all architectures
validate_common_files() {
    local project_dir="$1"
    local errors=0

    # All projects should have deploy scripts
    assert_file_exists "$project_dir" "deploy/build_and_push.sh" || ((errors++))
    assert_file_exists "$project_dir" "deploy/deploy.sh" || ((errors++))

    # All projects should have do/ scripts directory
    assert_dir_exists "$project_dir" "do" || ((errors++))

    # All projects should have a README
    assert_file_exists "$project_dir" "README.md" || ((errors++))

    return $errors
}

# Validate HTTP architecture projects (http-flask, http-fastapi)
validate_http() {
    local project_dir="$1"
    local backend="$2"
    local errors=0

    log_verbose "Validating HTTP architecture (backend=$backend)"

    # HTTP-specific files
    assert_file_exists "$project_dir" "Dockerfile" || ((errors++))
    assert_file_exists "$project_dir" "requirements.txt" || ((errors++))
    assert_file_exists "$project_dir" "code/model_handler.py" || ((errors++))
    assert_file_exists "$project_dir" "code/serve.py" || ((errors++))

    # Content checks
    if [[ "$backend" == "flask" ]]; then
        assert_file_contains "$project_dir" "code/serve.py" "flask\|Flask" || ((errors++))
    elif [[ "$backend" == "fastapi" ]]; then
        assert_file_contains "$project_dir" "code/serve.py" "fastapi\|FastAPI" || ((errors++))
    fi

    # Should NOT have transformers-specific files
    if [[ -f "$project_dir/code/serve" ]]; then
        log_verbose "  ✗ Unexpected file: code/serve (transformers entrypoint)"
        ((errors++))
    fi

    validate_common_files "$project_dir"
    errors=$((errors + $?))

    return $errors
}

# Validate Transformers architecture projects
validate_transformers() {
    local project_dir="$1"
    local backend="$2"
    local errors=0

    log_verbose "Validating Transformers architecture (backend=$backend)"

    # Transformers-specific files
    assert_file_exists "$project_dir" "Dockerfile" || ((errors++))
    assert_file_exists "$project_dir" "code/serve" || ((errors++))
    assert_file_exists "$project_dir" "deploy/upload_to_s3.sh" || ((errors++))

    # Content checks - Dockerfile should reference the backend
    assert_file_contains "$project_dir" "Dockerfile" "$backend\|vllm\|sglang\|tensorrt\|lmi\|djl" || ((errors++))

    # Should NOT have HTTP-specific files
    if [[ -f "$project_dir/code/model_handler.py" ]]; then
        log_verbose "  ✗ Unexpected file: code/model_handler.py (HTTP-specific)"
        ((errors++))
    fi
    if [[ -f "$project_dir/code/serve.py" ]]; then
        log_verbose "  ✗ Unexpected file: code/serve.py (HTTP-specific)"
        ((errors++))
    fi

    validate_common_files "$project_dir"
    errors=$((errors + $?))

    return $errors
}

# Validate Triton architecture projects
validate_triton() {
    local project_dir="$1"
    local backend="$2"
    local errors=0

    log_verbose "Validating Triton architecture (backend=$backend)"

    # Triton-specific files
    assert_file_exists "$project_dir" "Dockerfile" || ((errors++))

    # Should NOT have HTTP-specific files
    if [[ -f "$project_dir/code/model_handler.py" ]]; then
        log_verbose "  ✗ Unexpected file: code/model_handler.py (HTTP-specific)"
        ((errors++))
    fi
    if [[ -f "$project_dir/code/serve.py" ]]; then
        log_verbose "  ✗ Unexpected file: code/serve.py (HTTP-specific)"
        ((errors++))
    fi

    validate_common_files "$project_dir"
    errors=$((errors + $?))

    return $errors
}

# Validate Diffusors architecture projects
validate_diffusors() {
    local project_dir="$1"
    local backend="$2"
    local errors=0

    log_verbose "Validating Diffusors architecture (backend=$backend)"

    # Diffusors-specific files
    assert_file_exists "$project_dir" "Dockerfile" || ((errors++))
    assert_file_exists "$project_dir" "code/serve" || ((errors++))
    assert_file_exists "$project_dir" "code/start_server.sh" || ((errors++))
    assert_file_exists "$project_dir" "code/patch_image_api.py" || ((errors++))

    # Should NOT have HTTP-specific files
    if [[ -f "$project_dir/code/model_handler.py" ]]; then
        log_verbose "  ✗ Unexpected file: code/model_handler.py (HTTP-specific)"
        ((errors++))
    fi
    if [[ -f "$project_dir/code/serve.py" ]]; then
        log_verbose "  ✗ Unexpected file: code/serve.py (HTTP-specific)"
        ((errors++))
    fi

    validate_common_files "$project_dir"
    errors=$((errors + $?))

    return $errors
}

# Run validation for a single deployment config
validate_config() {
    local config_name="$1"
    local project_dir="$TEMP_BASE/$config_name"

    echo -n "  Testing $config_name... "

    # Generate the project
    if ! generate_project "$config_name"; then
        log_fail "FAIL (generation failed)"
        FAILED_CONFIGS+=("$config_name (generation failed)")
        ((FAIL_COUNT++))
        return 1
    fi

    # Determine architecture from config name
    local architecture=""
    local backend=""

    case "$config_name" in
        http-*)
            architecture="http"
            backend="${config_name#http-}"
            ;;
        transformers-*)
            architecture="transformers"
            backend="${config_name#transformers-}"
            ;;
        triton-*)
            architecture="triton"
            backend="${config_name#triton-}"
            ;;
        diffusors-*)
            architecture="diffusors"
            backend="${config_name#diffusors-}"
            ;;
        *)
            log_warn "SKIP (unknown architecture for $config_name)"
            ((SKIP_COUNT++))
            return 0
            ;;
    esac

    # Run architecture-specific validation
    local errors=0
    case "$architecture" in
        http)
            validate_http "$project_dir" "$backend"
            errors=$?
            ;;
        transformers)
            validate_transformers "$project_dir" "$backend"
            errors=$?
            ;;
        triton)
            validate_triton "$project_dir" "$backend"
            errors=$?
            ;;
        diffusors)
            validate_diffusors "$project_dir" "$backend"
            errors=$?
            ;;
    esac

    if [[ $errors -eq 0 ]]; then
        log_pass "PASS"
        ((PASS_COUNT++))
        return 0
    else
        log_fail "FAIL ($errors errors)"
        FAILED_CONFIGS+=("$config_name ($errors errors)")
        ((FAIL_COUNT++))
        return 1
    fi
}

# All 15 canonical deployment configs
ALL_CONFIGS=(
    "http-flask"
    "http-fastapi"
    "transformers-vllm"
    "transformers-sglang"
    "transformers-tensorrt-llm"
    "transformers-lmi"
    "transformers-djl"
    "triton-fil"
    "triton-onnxruntime"
    "triton-tensorflow"
    "triton-pytorch"
    "triton-vllm"
    "triton-tensorrtllm"
    "triton-python"
    "diffusors-vllm-omni"
)

# Main execution
echo ""
echo "🔍 ML Container Creator - Migration Parity Verification"
echo "========================================================"
echo ""
log_info "CLI: $CLI_PATH"
log_info "Temp dir: $TEMP_BASE"
echo ""

if [[ -n "$SINGLE_CONFIG" ]]; then
    echo "Testing single config: $SINGLE_CONFIG"
    echo ""
    validate_config "$SINGLE_CONFIG"
else
    echo "Testing all 15 canonical deployment configs:"
    echo ""

    # Group by architecture for readability
    echo "  HTTP Architecture:"
    validate_config "http-flask" || true
    validate_config "http-fastapi" || true
    echo ""

    echo "  Transformers Architecture:"
    validate_config "transformers-vllm" || true
    validate_config "transformers-sglang" || true
    validate_config "transformers-tensorrt-llm" || true
    validate_config "transformers-lmi" || true
    validate_config "transformers-djl" || true
    echo ""

    echo "  Triton Architecture:"
    validate_config "triton-fil" || true
    validate_config "triton-onnxruntime" || true
    validate_config "triton-tensorflow" || true
    validate_config "triton-pytorch" || true
    validate_config "triton-vllm" || true
    validate_config "triton-tensorrtllm" || true
    validate_config "triton-python" || true
    echo ""

    echo "  Diffusors Architecture:"
    validate_config "diffusors-vllm-omni" || true
    echo ""
fi

# Summary
echo ""
echo "========================================================"
echo "📊 Results Summary"
echo "========================================================"
echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
if [[ $SKIP_COUNT -gt 0 ]]; then
    echo -e "  ${YELLOW}Skipped: $SKIP_COUNT${NC}"
fi
echo "  Total:  $((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))"
echo ""

if [[ $FAIL_COUNT -gt 0 ]]; then
    echo "Failed configs:"
    for failed in "${FAILED_CONFIGS[@]}"; do
        echo -e "  ${RED}• $failed${NC}"
    done
    echo ""
    log_fail "Parity verification FAILED"
    exit 1
else
    log_pass "All deployment configs passed parity verification!"
    exit 0
fi

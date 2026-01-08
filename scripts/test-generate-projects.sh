#!/bin/bash

# PR Testing Script for ML Container Creator
# Comprehensive validation of all configuration features and methods
# This script serves as a foundation for future testing harness development

set -e  # Exit on any error

echo "🚀 ML Container Creator - Comprehensive PR Testing Script"
echo "========================================================="
echo

# Configuration
PROJECT_ROOT="$(pwd)"
TEST_OUTPUT_DIR="${TEST_OUTPUT_DIR:-./test-output-$(date +%Y%m%d-%H%M%S)}"
KEEP_TEST_OUTPUT="${KEEP_TEST_OUTPUT:-false}"
VERBOSE="${VERBOSE:-false}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Helper functions
print_step() {
    echo -e "${BLUE}📋 Step $1: $2${NC}"
}

print_substep() {
    echo -e "${CYAN}  └─ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${PURPLE}ℹ️  $1${NC}"
}

verbose_log() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "${CYAN}🔍 $1${NC}"
    fi
}

# Test result tracking
TESTS_PASSED=0
TESTS_FAILED=0
FAILED_TESTS=()

record_test_result() {
    local test_name="$1"
    local result="$2"
    
    if [[ "$result" == "PASS" ]]; then
        ((TESTS_PASSED++))
        verbose_log "Test passed: $test_name"
    else
        ((TESTS_FAILED++))
        FAILED_TESTS+=("$test_name")
        print_error "Test failed: $test_name"
    fi
}

# Setup test environment
setup_test_environment() {
    print_info "Setting up test environment..."
    print_info "Test output directory: $TEST_OUTPUT_DIR"
    
    # Create test output directory
    mkdir -p "$TEST_OUTPUT_DIR"
    cd "$TEST_OUTPUT_DIR"
    
    # Ensure Yeoman is available
    if ! command -v yo &> /dev/null; then
        print_info "Installing Yeoman globally..."
        npm install -g yo > /dev/null 2>&1 || true
    fi
    
    # Ensure generator is linked
    npm link > /dev/null 2>&1 || true
    
    print_success "Test environment ready"
}

# Cleanup function
cleanup() {
    echo
    print_info "Cleaning up test environment..."
    
    # Clean up environment variables
    unset AWS_REGION ML_INSTANCE_TYPE AWS_ROLE ML_CONTAINER_CREATOR_CONFIG 2>/dev/null || true
    
    # Return to original directory
    cd "$PROJECT_ROOT" > /dev/null 2>&1 || true
    
    if [[ "$KEEP_TEST_OUTPUT" == "true" ]]; then
        print_info "Test output preserved in: $TEST_OUTPUT_DIR"
    else
        print_info "Removing test output directory: $TEST_OUTPUT_DIR"
        rm -rf "$TEST_OUTPUT_DIR" 2>/dev/null || true
    fi
    
    print_success "Cleanup complete"
}

# Set trap for cleanup on exit
trap cleanup EXIT

# Validation functions
validate_project_structure() {
    local project_dir="$1"
    local expected_files=("$@")
    local project_name=$(basename "$project_dir")
    
    if [[ ! -d "$project_dir" ]]; then
        print_error "Project directory not found: $project_dir"
        return 1
    fi
    
    local missing_files=()
    for file in "${expected_files[@]:1}"; do  # Skip first element (project_dir)
        if [[ ! -f "$project_dir/$file" ]]; then
            missing_files+=("$file")
        fi
    done
    
    if [[ ${#missing_files[@]} -gt 0 ]]; then
        print_error "Missing files in $project_name: ${missing_files[*]}"
        return 1
    fi
    
    verbose_log "All expected files found in $project_name"
    return 0
}

validate_file_content() {
    local file_path="$1"
    local expected_content="$2"
    local description="$3"
    
    if [[ ! -f "$file_path" ]]; then
        print_error "File not found for content validation: $file_path"
        return 1
    fi
    
    if grep -q "$expected_content" "$file_path"; then
        verbose_log "Content validation passed: $description"
        return 0
    else
        print_error "Content validation failed: $description"
        print_error "Expected '$expected_content' in $file_path"
        return 1
    fi
}

# Configuration test data
create_test_configs() {
    print_substep "Creating test configuration files..."
    
    # Basic sklearn config
    cat > sklearn-config.json << 'EOF'
{
  "projectName": "sklearn-from-config",
  "framework": "sklearn",
  "modelServer": "flask",
  "modelFormat": "pkl",
  "includeSampleModel": true,
  "includeTesting": true,
  "instanceType": "cpu-optimized",
  "awsRegion": "us-east-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/SageMakerRole"
}
EOF

    # XGBoost with FastAPI config
    cat > xgboost-config.json << 'EOF'
{
  "projectName": "xgboost-from-config",
  "framework": "xgboost",
  "modelServer": "fastapi",
  "modelFormat": "json",
  "includeSampleModel": false,
  "includeTesting": true,
  "instanceType": "gpu-enabled",
  "awsRegion": "us-west-2",
  "awsRoleArn": "arn:aws:iam::123456789012:role/XGBoostRole"
}
EOF

    # TensorFlow config
    cat > tensorflow-config.json << 'EOF'
{
  "projectName": "tensorflow-from-config",
  "framework": "tensorflow",
  "modelServer": "fastapi",
  "modelFormat": "SavedModel",
  "includeSampleModel": true,
  "includeTesting": true,
  "instanceType": "gpu-enabled",
  "awsRegion": "eu-west-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/TensorFlowRole"
}
EOF

    # Transformers config
    cat > transformers-config.json << 'EOF'
{
  "projectName": "transformers-from-config",
  "framework": "transformers",
  "modelServer": "vllm",
  "includeSampleModel": false,
  "includeTesting": true,
  "instanceType": "gpu-enabled",
  "awsRegion": "ap-southeast-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/TransformersRole"
}
EOF

    # Production config with minimal settings
    cat > production-config.json << 'EOF'
{
  "framework": "sklearn",
  "modelServer": "fastapi",
  "modelFormat": "joblib",
  "includeSampleModel": false,
  "includeTesting": true,
  "instanceType": "cpu-optimized",
  "awsRegion": "us-east-1"
}
EOF

    # Development config with all options
    cat > development-config.json << 'EOF'
{
  "projectName": "dev-ml-project",
  "framework": "tensorflow",
  "modelServer": "flask",
  "modelFormat": "keras",
  "includeSampleModel": true,
  "includeTesting": true,
  "testTypes": ["local-model-cli", "local-model-server", "hosted-model-endpoint"],
  "deployTarget": "sagemaker",
  "instanceType": "cpu-optimized",
  "awsRegion": "us-east-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/DevRole"
}
EOF

    # Package.json with ml-container-creator section
    cat > package.json << 'EOF'
{
  "name": "test-ml-project",
  "version": "1.0.0",
  "ml-container-creator": {
    "awsRegion": "eu-central-1",
    "awsRoleArn": "arn:aws:iam::123456789012:role/PackageJsonRole",
    "projectName": "package-json-project",
    "includeTesting": true
  }
}
EOF

    print_success "Test configuration files created"
}

# Environment variable configurations
setup_env_configs() {
    print_substep "Setting up environment variable configurations..."
    
    # Store original values
    ORIGINAL_AWS_REGION="${AWS_REGION:-}"
    ORIGINAL_ML_INSTANCE_TYPE="${ML_INSTANCE_TYPE:-}"
    ORIGINAL_AWS_ROLE="${AWS_ROLE:-}"
    ORIGINAL_ML_CONTAINER_CREATOR_CONFIG="${ML_CONTAINER_CREATOR_CONFIG:-}"
    
    verbose_log "Original environment variables stored"
}

restore_env_configs() {
    print_substep "Restoring original environment variables..."
    
    # Restore original values
    if [[ -n "$ORIGINAL_AWS_REGION" ]]; then
        export AWS_REGION="$ORIGINAL_AWS_REGION"
    else
        unset AWS_REGION 2>/dev/null || true
    fi
    
    if [[ -n "$ORIGINAL_ML_INSTANCE_TYPE" ]]; then
        export ML_INSTANCE_TYPE="$ORIGINAL_ML_INSTANCE_TYPE"
    else
        unset ML_INSTANCE_TYPE 2>/dev/null || true
    fi
    
    if [[ -n "$ORIGINAL_AWS_ROLE" ]]; then
        export AWS_ROLE="$ORIGINAL_AWS_ROLE"
    else
        unset AWS_ROLE 2>/dev/null || true
    fi
    
    if [[ -n "$ORIGINAL_ML_CONTAINER_CREATOR_CONFIG" ]]; then
        export ML_CONTAINER_CREATOR_CONFIG="$ORIGINAL_ML_CONTAINER_CREATOR_CONFIG"
    else
        unset ML_CONTAINER_CREATOR_CONFIG 2>/dev/null || true
    fi
    
    verbose_log "Original environment variables restored"
}

# Test execution functions
run_test_suite() {
    print_substep "Running complete test suite..."
    
    if npm run validate > test-suite.log 2>&1; then
        print_success "Complete test suite passed"
        record_test_result "Complete Test Suite" "PASS"
        return 0
    else
        print_error "Complete test suite failed"
        record_test_result "Complete Test Suite" "FAIL"
        if [[ "$VERBOSE" == "true" ]]; then
            echo "Test suite output:"
            cat test-suite.log
        fi
        return 1
    fi
}

test_cli_options() {
    local framework="$1"
    local server="$2"
    local format="$3"
    local project_name="cli-${framework}-${server}"
    
    print_substep "Testing CLI options: $framework + $server + $format"
    
    # Create a subdirectory for this test to avoid conflicts
    mkdir -p "$project_name"
    cd "$project_name"
    
    local cmd_args=(
        "yo" "ml-container-creator"
        "--framework=$framework"
        "--model-server=$server"
        "--skip-prompts"
    )
    
    # Add format for non-transformers frameworks
    if [[ "$framework" != "transformers" ]]; then
        cmd_args+=("--model-format=$format")
    fi
    
    # Add instance type for transformers
    if [[ "$framework" == "transformers" ]]; then
        cmd_args+=("--instance-type=gpu-enabled")
    fi
    
    verbose_log "Running: ${cmd_args[*]}"
    
    if "${cmd_args[@]}" > "../${project_name}.log" 2>&1; then
        local expected_files=("Dockerfile")
        
        # Add requirements.txt for non-transformers frameworks
        if [[ "$framework" != "transformers" ]]; then
            expected_files+=("requirements.txt")
        fi
        
        # Add expected files based on framework
        if [[ "$framework" == "transformers" ]]; then
            expected_files+=("code/serve")
        else
            expected_files+=("code/model_handler.py" "code/serve.py")
        fi
        
        expected_files+=("deploy/build_and_push.sh" "deploy/deploy.sh")
        
        # Check files in current directory (where generator creates them)
        local missing_files=()
        for file in "${expected_files[@]}"; do
            if [[ ! -f "$file" ]]; then
                missing_files+=("$file")
            fi
        done
        
        cd ..  # Return to parent directory
        
        if [[ ${#missing_files[@]} -eq 0 ]]; then
            verbose_log "All expected files found for $framework + $server"
            print_success "CLI options test passed: $framework + $server"
            record_test_result "CLI Options: $framework + $server" "PASS"
            return 0
        else
            print_error "Missing files in $project_name: ${missing_files[*]}"
            record_test_result "CLI Options: $framework + $server" "FAIL"
            return 1
        fi
    else
        cd ..  # Return to parent directory
        print_error "CLI options test failed: $framework + $server"
        record_test_result "CLI Options: $framework + $server" "FAIL"
        if [[ "$VERBOSE" == "true" ]]; then
            echo "Command output:"
            cat "${project_name}.log"
        fi
        return 1
    fi
}

test_env_variables() {
    local test_name="$1"
    local aws_region="$2"
    local instance_type="$3"
    local aws_role="$4"
    
    print_substep "Testing environment variables: $test_name"
    
    # Set environment variables
    export AWS_REGION="$aws_region"
    export ML_INSTANCE_TYPE="$instance_type"
    export AWS_ROLE="$aws_role"
    
    local project_name="env-$test_name"
    
    verbose_log "Environment: AWS_REGION=$aws_region, ML_INSTANCE_TYPE=$instance_type, AWS_ROLE=$aws_role"
    
    # Create a subdirectory for this test
    mkdir -p "$project_name"
    cd "$project_name"
    
    if yo ml-container-creator \
        --framework=sklearn \
        --model-server=flask \
        --model-format=pkl \
        --skip-prompts > "../${project_name}.log" 2>&1; then
        
        # Validate environment variables were used
        local validation_passed=true
        
        if ! validate_file_content "deploy/deploy.sh" "$aws_region" "AWS region in deploy script"; then
            validation_passed=false
        fi
        
        # Map instance type to actual AWS instance type for validation
        local expected_instance_type
        if [[ "$instance_type" == "gpu-enabled" && "$framework" == "transformers" ]]; then
            expected_instance_type="ml.g6.12xlarge"
        elif [[ "$instance_type" == "gpu-enabled" ]]; then
            expected_instance_type="ml.g5.xlarge"
        elif [[ "$instance_type" == "cpu-optimized" ]]; then
            expected_instance_type="ml.m6g.large"
        else
            expected_instance_type="$instance_type"
        fi
        
        if ! validate_file_content "deploy/deploy.sh" "$expected_instance_type" "Instance type in deploy script"; then
            validation_passed=false
        fi
        
        if [[ -n "$aws_role" ]] && ! validate_file_content "deploy/deploy.sh" "$aws_role" "AWS role in deploy script"; then
            validation_passed=false
        fi
        
        cd ..  # Return to parent directory
        
        if [[ "$validation_passed" == "true" ]]; then
            print_success "Environment variables test passed: $test_name"
            record_test_result "Environment Variables: $test_name" "PASS"
            return 0
        else
            record_test_result "Environment Variables: $test_name" "FAIL"
            return 1
        fi
    else
        cd ..  # Return to parent directory
        print_error "Environment variables test failed: $test_name"
        record_test_result "Environment Variables: $test_name" "FAIL"
        return 1
    fi
}

test_config_file() {
    local config_file="$1"
    local expected_project_name="$2"
    local expected_framework="$3"
    local expected_server="$4"
    
    print_substep "Testing config file: $config_file"
    
    verbose_log "Using config file: $config_file"
    
    # Create a subdirectory for this test
    mkdir -p "config-test-$(basename "$config_file" .json)"
    cd "config-test-$(basename "$config_file" .json)"
    
    if yo ml-container-creator --config="../$config_file" --skip-prompts > "../${config_file%.json}.log" 2>&1; then
        
        # Validate framework-specific files
        local validation_passed=true
        
        if [[ "$expected_framework" == "transformers" ]]; then
            if [[ ! -f "code/serve" ]]; then
                print_error "Missing transformers serve script"
                validation_passed=false
            fi
        else
            if [[ ! -f "code/model_handler.py" ]]; then
                print_error "Missing model_handler.py"
                validation_passed=false
            fi
        fi
        
        # Validate server-specific content
        if [[ "$expected_server" == "fastapi" ]]; then
            if [[ "$expected_framework" != "transformers" ]] && ! validate_file_content "code/serve.py" "fastapi\|FastAPI" "FastAPI imports"; then
                validation_passed=false
            fi
        fi
        
        cd ..  # Return to parent directory
        
        if [[ "$validation_passed" == "true" ]]; then
            print_success "Config file test passed: $config_file"
            record_test_result "Config File: $config_file" "PASS"
            return 0
        else
            record_test_result "Config File: $config_file" "FAIL"
            return 1
        fi
    else
        cd ..  # Return to parent directory
        print_error "Config file test failed: $config_file"
        record_test_result "Config File: $config_file" "FAIL"
        return 1
    fi
}

test_precedence() {
    print_substep "Testing configuration precedence"
    
    # Set environment variable
    export AWS_REGION=us-east-1
    
    # CLI option should override environment variable
    local project_name="precedence-test"
    
    # Create a subdirectory for this test
    mkdir -p "$project_name"
    cd "$project_name"
    
    if yo ml-container-creator \
        --framework=sklearn \
        --model-server=flask \
        --model-format=pkl \
        --region=eu-west-1 \
        --skip-prompts > "../${project_name}.log" 2>&1; then
        
        # CLI option (eu-west-1) should win over environment variable (us-east-1)
        if validate_file_content "deploy/deploy.sh" "eu-west-1" "CLI option precedence over environment variable"; then
            cd ..  # Return to parent directory
            print_success "Configuration precedence test passed"
            record_test_result "Configuration Precedence" "PASS"
            return 0
        else
            cd ..  # Return to parent directory
            record_test_result "Configuration Precedence" "FAIL"
            return 1
        fi
    else
        cd ..  # Return to parent directory
        print_error "Configuration precedence test failed"
        record_test_result "Configuration Precedence" "FAIL"
        return 1
    fi
}

test_error_handling() {
    print_substep "Testing error handling"
    
    local error_tests_passed=0
    local total_error_tests=3
    
    # Test 1: Invalid framework - should show warning but not fail
    mkdir -p "error-test-invalid-framework"
    cd "error-test-invalid-framework"
    
    if yo ml-container-creator --framework=invalid --skip-prompts > ../invalid-framework.log 2>&1; then
        if grep -q "Unsupported framework\|not implemented\|invalid" ../invalid-framework.log; then
            verbose_log "Invalid framework error handling works"
            ((error_tests_passed++))
        else
            print_warning "Invalid framework should show warning message"
        fi
    else
        print_warning "Generator should not fail completely for invalid framework"
    fi
    
    cd ..
    
    # Test 2: Missing required parameters - should use defaults and succeed
    mkdir -p "error-test-missing-params"
    cd "error-test-missing-params"
    
    if yo ml-container-creator --skip-prompts > ../missing-params.log 2>&1; then
        # When no framework is specified, generator should use defaults (sklearn)
        if [[ -f "Dockerfile" && -f "requirements.txt" ]]; then
            verbose_log "Missing parameter handling works (uses defaults)"
            ((error_tests_passed++))
        else
            print_warning "Missing parameters should use defaults and generate files"
        fi
    else
        print_warning "Generator should not fail completely for missing parameters"
    fi
    
    cd ..
    
    # Test 3: Invalid combination - should show warning but not fail
    mkdir -p "error-test-invalid-combo"
    cd "error-test-invalid-combo"
    
    if yo ml-container-creator --framework=sklearn --model-server=vllm --skip-prompts > ../invalid-combo.log 2>&1; then
        if grep -q "invalid\|incompatible\|not supported\|Unsupported" ../invalid-combo.log; then
            verbose_log "Invalid combination error handling works"
            ((error_tests_passed++))
        else
            print_warning "Invalid combination should show warning message"
        fi
    else
        print_warning "Generator should not fail completely for invalid combinations"
    fi
    
    cd ..
    
    if [[ $error_tests_passed -eq $total_error_tests ]]; then
        print_success "Error handling tests passed ($error_tests_passed/$total_error_tests)"
        record_test_result "Error Handling" "PASS"
        return 0
    else
        print_warning "Error handling tests partially passed ($error_tests_passed/$total_error_tests)"
        record_test_result "Error Handling" "PARTIAL"
        return 1
    fi
}

test_cli_commands() {
    print_substep "Testing CLI commands"
    
    local cli_tests_passed=0
    local total_cli_tests=2
    
    # Test help command
    mkdir -p "cli-test-help"
    cd "cli-test-help"
    
    if yo ml-container-creator help > ../help-output.log 2>&1; then
        if grep -q "CLI OPTIONS\|USAGE\|EXAMPLES" ../help-output.log; then
            verbose_log "Help command works correctly"
            ((cli_tests_passed++))
        fi
    fi
    
    cd ..
    
    # Test generate-empty-config command
    mkdir -p "cli-test-config"
    cd "cli-test-config"
    
    if echo "1" | yo ml-container-creator generate-empty-config > ../empty-config.log 2>&1; then
        if [[ -f "ml-container.config.json" ]]; then
            verbose_log "Generate empty config works correctly"
            ((cli_tests_passed++))
        fi
    fi
    
    cd ..
    
    if [[ $cli_tests_passed -eq $total_cli_tests ]]; then
        print_success "CLI commands tests passed ($cli_tests_passed/$total_cli_tests)"
        record_test_result "CLI Commands" "PASS"
        return 0
    else
        print_warning "CLI commands tests partially passed ($cli_tests_passed/$total_cli_tests)"
        record_test_result "CLI Commands" "PARTIAL"
        return 1
    fi
}

# Main test execution
main() {
    echo "Starting comprehensive PR testing..."
    echo "Test configuration:"
    echo "  - Output directory: $TEST_OUTPUT_DIR"
    echo "  - Keep output: $KEEP_TEST_OUTPUT"
    echo "  - Verbose: $VERBOSE"
    echo
    
    setup_test_environment
    
    # Step 1: Validate Test Suite
    print_step "1" "Validating Complete Test Suite"
    run_test_suite
    echo
    
    # Step 2: Create test configurations
    print_step "2" "Setting Up Test Configurations"
    create_test_configs
    setup_env_configs
    echo
    
    # Step 3: Test CLI Options (Highest Precedence)
    print_step "3" "Testing CLI Options (Highest Precedence)"
    test_cli_options "sklearn" "flask" "pkl"
    test_cli_options "xgboost" "fastapi" "json"
    test_cli_options "tensorflow" "flask" "keras"
    test_cli_options "transformers" "vllm" ""
    echo
    
    # Step 4: Test Environment Variables
    print_step "4" "Testing Environment Variables (3rd Precedence)"
    test_env_variables "basic" "eu-west-1" "gpu-enabled" "arn:aws:iam::123456789012:role/TestRole"
    test_env_variables "minimal" "us-west-2" "cpu-optimized" ""
    test_env_variables "complete" "ap-southeast-1" "gpu-enabled" "arn:aws:iam::123456789012:role/CompleteRole"
    restore_env_configs
    echo
    
    # Step 5: Test Configuration Files
    print_step "5" "Testing Configuration Files (4th-5th Precedence)"
    test_config_file "sklearn-config.json" "sklearn-from-config" "sklearn" "flask"
    test_config_file "xgboost-config.json" "xgboost-from-config" "xgboost" "fastapi"
    test_config_file "tensorflow-config.json" "tensorflow-from-config" "tensorflow" "fastapi"
    test_config_file "transformers-config.json" "transformers-from-config" "transformers" "vllm"
    test_config_file "production-config.json" "ml-container-creator" "sklearn" "fastapi"
    test_config_file "development-config.json" "dev-ml-project" "tensorflow" "flask"
    echo
    
    # Step 6: Test Package.json Configuration
    print_step "6" "Testing Package.json Configuration (6th Precedence)"
    
    # The package.json should be in the current directory for the generator to find it
    if yo ml-container-creator --framework=sklearn --model-server=flask --model-format=pkl --skip-prompts > package-json-test.log 2>&1; then
        if validate_file_content "deploy/deploy.sh" "eu-central-1" "Package.json AWS region"; then
            print_success "Package.json configuration test passed"
            record_test_result "Package.json Configuration" "PASS"
        else
            record_test_result "Package.json Configuration" "FAIL"
        fi
    else
        record_test_result "Package.json Configuration" "FAIL"
    fi
    echo
    
    # Step 7: Test Configuration Precedence
    print_step "7" "Testing Configuration Precedence"
    test_precedence
    echo
    
    # Step 8: Test CLI Commands
    print_step "8" "Testing CLI Commands"
    test_cli_commands
    echo
    
    # Step 9: Test Error Handling
    print_step "9" "Testing Error Handling"
    test_error_handling
    echo
    
    # Step 10: Test Property-Based Tests
    print_step "10" "Testing Property-Based Tests"
    
    # Property tests need to run from project root, not from test output directory
    original_dir=$(pwd)
    cd "$PROJECT_ROOT"
    
    if npm run test:property > "$original_dir/property-tests.log" 2>&1; then
        print_success "All property-based tests passed"
        record_test_result "Property-Based Tests" "PASS"
    else
        print_error "Property-based tests failed"
        record_test_result "Property-Based Tests" "FAIL"
    fi
    
    # Return to test output directory
    cd "$original_dir"
    echo
    
    # Step 11: Performance Testing
    print_step "11" "Testing Performance"
    
    # Performance test needs to run from project root
    original_dir=$(pwd)
    cd "$PROJECT_ROOT"
    
    start_time=$(date +%s)
    npm run validate > "$original_dir/performance-test.log" 2>&1
    end_time=$(date +%s)
    duration=$((end_time - start_time))
    
    if [[ $duration -lt 20 ]]; then
        print_success "Performance test passed: ${duration} seconds (target: <20s)"
        record_test_result "Performance Test" "PASS"
    else
        print_warning "Performance test: ${duration} seconds (slower than expected)"
        record_test_result "Performance Test" "PARTIAL"
    fi
    
    # Return to test output directory for final results
    cd "$original_dir"
    echo
    
    # Final Results
    print_step "12" "Final Results Summary"
    echo
    echo "🎉 Comprehensive PR Testing Complete!"
    echo "====================================="
    
    local total_tests=$((TESTS_PASSED + TESTS_FAILED))
    print_info "Test Results: $TESTS_PASSED passed, $TESTS_FAILED failed (Total: $total_tests)"
    
    if [[ $TESTS_FAILED -eq 0 ]]; then
        print_success "All tests passed successfully! 🚀"
        echo
        echo "📊 Summary:"
        echo "  ✅ Complete test suite validated"
        echo "  ✅ All configuration methods working"
        echo "  ✅ CLI options, environment variables, config files tested"
        echo "  ✅ Configuration precedence validated"
        echo "  ✅ Error handling working correctly"
        echo "  ✅ Property-based tests passing"
        echo "  ✅ Performance within acceptable range"
        echo
        print_success "This PR is ready for merge!"
        return 0
    else
        print_error "Some tests failed:"
        for failed_test in "${FAILED_TESTS[@]}"; do
            echo "  ❌ $failed_test"
        done
        echo
        print_error "Please review and fix failing tests before merge."
        return 1
    fi
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --output-dir)
            TEST_OUTPUT_DIR="$2"
            shift 2
            ;;
        --keep-output)
            KEEP_TEST_OUTPUT="true"
            shift
            ;;
        --verbose)
            VERBOSE="true"
            shift
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo
            echo "Options:"
            echo "  --output-dir DIR    Set test output directory (default: ./test-output-TIMESTAMP)"
            echo "  --keep-output       Keep test output after completion"
            echo "  --verbose           Enable verbose logging"
            echo "  --help              Show this help message"
            echo
            echo "Environment variables:"
            echo "  TEST_OUTPUT_DIR     Set test output directory"
            echo "  KEEP_TEST_OUTPUT    Keep test output (true/false)"
            echo "  VERBOSE             Enable verbose logging (true/false)"
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Run main function
main
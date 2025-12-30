#!/bin/bash

# Test Configuration Generator for ML Container Creator
# Generates comprehensive test configurations for all supported combinations
# This script serves as a foundation for future testing harness development

set -e

echo "🔧 ML Container Creator - Test Configuration Generator"
echo "====================================================="
echo

# Configuration
OUTPUT_DIR="${1:-./test-configs}"
VERBOSE="${VERBOSE:-false}"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_step() {
    echo -e "${CYAN}📋 $1${NC}"
}

verbose_log() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "${CYAN}🔍 $1${NC}"
    fi
}

# Framework configurations
declare -A FRAMEWORKS=(
    ["sklearn"]="pkl,joblib"
    ["xgboost"]="json,model,ubj"
    ["tensorflow"]="keras,h5,SavedModel"
    ["transformers"]=""
)

declare -A SERVERS=(
    ["sklearn"]="flask,fastapi"
    ["xgboost"]="flask,fastapi"
    ["tensorflow"]="flask,fastapi"
    ["transformers"]="vllm,sglang"
)

declare -A INSTANCE_TYPES=(
    ["sklearn"]="cpu-optimized,gpu-enabled"
    ["xgboost"]="cpu-optimized,gpu-enabled"
    ["tensorflow"]="cpu-optimized,gpu-enabled"
    ["transformers"]="gpu-enabled"
)

# AWS regions for testing
AWS_REGIONS=("us-east-1" "us-west-2" "eu-west-1" "eu-central-1" "ap-southeast-1")

# Sample AWS role ARNs for testing
AWS_ROLES=(
    "arn:aws:iam::123456789012:role/SageMakerRole"
    "arn:aws:iam::123456789012:role/MLRole"
    "arn:aws:iam::123456789012:role/TestRole"
    "arn:aws:iam::123456789012:role/DevRole"
    "arn:aws:iam::123456789012:role/ProdRole"
)

# Create output directory
mkdir -p "$OUTPUT_DIR"
cd "$OUTPUT_DIR"

print_info "Generating test configurations in: $(pwd)"
echo

# Generate basic framework configurations
print_step "Generating basic framework configurations..."

config_count=0

for framework in "${!FRAMEWORKS[@]}"; do
    formats="${FRAMEWORKS[$framework]}"
    servers="${SERVERS[$framework]}"
    instance_types="${INSTANCE_TYPES[$framework]}"
    
    verbose_log "Processing framework: $framework"
    
    # Split servers into array
    IFS=',' read -ra server_array <<< "$servers"
    IFS=',' read -ra instance_array <<< "$instance_types"
    
    for server in "${server_array[@]}"; do
        for instance_type in "${instance_array[@]}"; do
            if [[ "$framework" == "transformers" ]]; then
                # Transformers don't have model formats
                config_file="basic-${framework}-${server}-${instance_type}.json"
                cat > "$config_file" << EOF
{
  "projectName": "${framework}-${server}-${instance_type}",
  "framework": "$framework",
  "modelServer": "$server",
  "includeSampleModel": false,
  "includeTesting": true,
  "instanceType": "$instance_type",
  "awsRegion": "${AWS_REGIONS[0]}",
  "awsRoleArn": "${AWS_ROLES[0]}"
}
EOF
                ((config_count++))
                verbose_log "Created: $config_file"
            else
                # Traditional ML frameworks with formats
                IFS=',' read -ra format_array <<< "$formats"
                for format in "${format_array[@]}"; do
                    config_file="basic-${framework}-${server}-${format}-${instance_type}.json"
                    cat > "$config_file" << EOF
{
  "projectName": "${framework}-${server}-${format}-${instance_type}",
  "framework": "$framework",
  "modelServer": "$server",
  "modelFormat": "$format",
  "includeSampleModel": true,
  "includeTesting": true,
  "instanceType": "$instance_type",
  "awsRegion": "${AWS_REGIONS[0]}",
  "awsRoleArn": "${AWS_ROLES[0]}"
}
EOF
                    ((config_count++))
                    verbose_log "Created: $config_file"
                done
            fi
        done
    done
done

print_success "Generated $config_count basic framework configurations"
echo

# Generate environment variable test configurations
print_step "Generating environment variable test configurations..."

env_config_count=0

# Environment variable combinations
declare -a ENV_CONFIGS=(
    "us-east-1,cpu-optimized,arn:aws:iam::123456789012:role/SageMakerRole"
    "us-west-2,gpu-enabled,arn:aws:iam::123456789012:role/MLRole"
    "eu-west-1,cpu-optimized,"
    "eu-central-1,gpu-enabled,arn:aws:iam::123456789012:role/TestRole"
    "ap-southeast-1,cpu-optimized,arn:aws:iam::123456789012:role/DevRole"
)

for i in "${!ENV_CONFIGS[@]}"; do
    IFS=',' read -ra env_config <<< "${ENV_CONFIGS[$i]}"
    region="${env_config[0]}"
    instance_type="${env_config[1]}"
    role_arn="${env_config[2]}"
    
    config_file="env-config-$((i+1)).json"
    cat > "$config_file" << EOF
{
  "_description": "Environment variable test configuration $((i+1))",
  "_env_vars": {
    "AWS_REGION": "$region",
    "ML_INSTANCE_TYPE": "$instance_type"$(if [[ -n "$role_arn" ]]; then echo ","; echo "    \"AWS_ROLE\": \"$role_arn\""; fi)
  },
  "_cli_options": {
    "framework": "sklearn",
    "modelServer": "flask",
    "modelFormat": "pkl"
  },
  "_expected_values": {
    "awsRegion": "$region",
    "instanceType": "$instance_type"$(if [[ -n "$role_arn" ]]; then echo ","; echo "    \"awsRoleArn\": \"$role_arn\""; fi)
  }
}
EOF
    ((env_config_count++))
    verbose_log "Created: $config_file"
done

print_success "Generated $env_config_count environment variable test configurations"
echo

# Generate precedence test configurations
print_step "Generating precedence test configurations..."

precedence_config_count=0

# Precedence test scenarios
declare -a PRECEDENCE_TESTS=(
    "cli-over-env:us-west-2,us-east-1"
    "cli-over-config:eu-west-1,us-west-2"
    "env-over-config:ap-southeast-1,eu-central-1"
)

for test_scenario in "${PRECEDENCE_TESTS[@]}"; do
    IFS=':' read -ra scenario <<< "$test_scenario"
    test_name="${scenario[0]}"
    IFS=',' read -ra regions <<< "${scenario[1]}"
    higher_precedence="${regions[0]}"
    lower_precedence="${regions[1]}"
    
    config_file="precedence-${test_name}.json"
    cat > "$config_file" << EOF
{
  "_description": "Precedence test: $test_name",
  "_test_scenario": "$test_name",
  "_higher_precedence": "$higher_precedence",
  "_lower_precedence": "$lower_precedence",
  "_expected_result": "$higher_precedence",
  "framework": "sklearn",
  "modelServer": "flask",
  "modelFormat": "pkl",
  "instanceType": "cpu-optimized"
}
EOF
    ((precedence_config_count++))
    verbose_log "Created: $config_file"
done

print_success "Generated $precedence_config_count precedence test configurations"
echo

# Generate edge case configurations
print_step "Generating edge case configurations..."

edge_case_count=0

# Minimal configuration
cat > "edge-minimal.json" << 'EOF'
{
  "_description": "Minimal configuration with only required parameters",
  "framework": "sklearn",
  "modelServer": "flask",
  "modelFormat": "pkl"
}
EOF
((edge_case_count++))

# Maximal configuration
cat > "edge-maximal.json" << 'EOF'
{
  "_description": "Maximal configuration with all possible parameters",
  "projectName": "maximal-test-project",
  "framework": "tensorflow",
  "modelServer": "fastapi",
  "modelFormat": "SavedModel",
  "includeSampleModel": true,
  "includeTesting": true,
  "testTypes": ["local-model-cli", "local-model-server", "hosted-model-endpoint"],
  "deployTarget": "sagemaker",
  "instanceType": "gpu-enabled",
  "awsRegion": "us-west-2",
  "awsRoleArn": "arn:aws:iam::123456789012:role/MaximalRole"
}
EOF
((edge_case_count++))

# Production-like configuration
cat > "edge-production.json" << 'EOF'
{
  "_description": "Production-like configuration",
  "projectName": "production-ml-service",
  "framework": "sklearn",
  "modelServer": "fastapi",
  "modelFormat": "joblib",
  "includeSampleModel": false,
  "includeTesting": true,
  "testTypes": ["local-model-server", "hosted-model-endpoint"],
  "instanceType": "cpu-optimized",
  "awsRegion": "us-east-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/ProdSageMakerRole"
}
EOF
((edge_case_count++))

# Development configuration
cat > "edge-development.json" << 'EOF'
{
  "_description": "Development configuration with all debugging features",
  "projectName": "dev-ml-project",
  "framework": "tensorflow",
  "modelServer": "flask",
  "modelFormat": "keras",
  "includeSampleModel": true,
  "includeTesting": true,
  "testTypes": ["local-model-cli", "local-model-server", "hosted-model-endpoint"],
  "instanceType": "cpu-optimized",
  "awsRegion": "us-east-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/DevRole"
}
EOF
((edge_case_count++))

print_success "Generated $edge_case_count edge case configurations"
echo

# Generate invalid configurations for error testing
print_step "Generating invalid configurations for error testing..."

error_config_count=0

# Invalid framework
cat > "error-invalid-framework.json" << 'EOF'
{
  "_description": "Invalid framework for error testing",
  "_expected_error": "framework not implemented",
  "framework": "invalid-framework",
  "modelServer": "flask",
  "modelFormat": "pkl"
}
EOF
((error_config_count++))

# Invalid combination: sklearn with vLLM
cat > "error-invalid-combination.json" << 'EOF'
{
  "_description": "Invalid framework/server combination",
  "_expected_error": "incompatible combination",
  "framework": "sklearn",
  "modelServer": "vllm",
  "modelFormat": "pkl"
}
EOF
((error_config_count++))

# Missing required parameters
cat > "error-missing-required.json" << 'EOF'
{
  "_description": "Missing required parameters",
  "_expected_error": "missing required parameter",
  "projectName": "incomplete-project"
}
EOF
((error_config_count++))

# Invalid model format for framework
cat > "error-invalid-format.json" << 'EOF'
{
  "_description": "Invalid model format for framework",
  "_expected_error": "invalid model format",
  "framework": "sklearn",
  "modelServer": "flask",
  "modelFormat": "json"
}
EOF
((error_config_count++))

print_success "Generated $error_config_count error test configurations"
echo

# Generate package.json configurations
print_step "Generating package.json configurations..."

package_json_count=0

# Basic package.json with ml-container-creator section
cat > "package-basic.json" << 'EOF'
{
  "name": "test-ml-project",
  "version": "1.0.0",
  "description": "Test ML project with package.json configuration",
  "ml-container-creator": {
    "awsRegion": "us-west-2",
    "awsRoleArn": "arn:aws:iam::123456789012:role/PackageJsonRole",
    "projectName": "package-json-project",
    "includeTesting": true
  }
}
EOF
((package_json_count++))

# Package.json with unsupported parameters (should be filtered)
cat > "package-filtered.json" << 'EOF'
{
  "name": "test-filtered-project",
  "version": "1.0.0",
  "ml-container-creator": {
    "_description": "This config contains unsupported parameters that should be filtered",
    "framework": "sklearn",
    "modelServer": "flask",
    "modelFormat": "pkl",
    "awsRegion": "eu-west-1",
    "awsRoleArn": "arn:aws:iam::123456789012:role/FilteredRole",
    "projectName": "filtered-project"
  }
}
EOF
((package_json_count++))

print_success "Generated $package_json_count package.json configurations"
echo

# Generate test execution script
print_step "Generating test execution script..."

cat > "run-config-tests.sh" << 'EOF'
#!/bin/bash

# Test Configuration Runner
# Executes tests using the generated configurations

set -e

echo "🧪 Running Configuration Tests"
echo "=============================="
echo

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# Test basic configurations
print_info "Testing basic framework configurations..."
for config in basic-*.json; do
    if [[ -f "$config" ]]; then
        echo "Testing: $config"
        if yo ml-container-creator --config="$config" --skip-prompts > "${config%.json}.log" 2>&1; then
            print_success "Config test passed: $config"
            ((TESTS_PASSED++))
        else
            print_error "Config test failed: $config"
            ((TESTS_FAILED++))
        fi
    fi
done

# Test edge cases
print_info "Testing edge case configurations..."
for config in edge-*.json; do
    if [[ -f "$config" ]]; then
        echo "Testing: $config"
        if yo ml-container-creator --config="$config" --skip-prompts > "${config%.json}.log" 2>&1; then
            print_success "Edge case test passed: $config"
            ((TESTS_PASSED++))
        else
            print_error "Edge case test failed: $config"
            ((TESTS_FAILED++))
        fi
    fi
done

# Test error cases (these should fail)
print_info "Testing error configurations (should fail)..."
for config in error-*.json; do
    if [[ -f "$config" ]]; then
        echo "Testing: $config (expecting failure)"
        if yo ml-container-creator --config="$config" --skip-prompts > "${config%.json}.log" 2>&1; then
            print_error "Error test unexpectedly passed: $config"
            ((TESTS_FAILED++))
        else
            print_success "Error test correctly failed: $config"
            ((TESTS_PASSED++))
        fi
    fi
done

echo
echo "📊 Test Results:"
echo "  Passed: $TESTS_PASSED"
echo "  Failed: $TESTS_FAILED"
echo "  Total:  $((TESTS_PASSED + TESTS_FAILED))"

if [[ $TESTS_FAILED -eq 0 ]]; then
    print_success "All configuration tests passed!"
    exit 0
else
    print_error "Some configuration tests failed"
    exit 1
fi
EOF

chmod +x "run-config-tests.sh"
print_success "Generated test execution script: run-config-tests.sh"
echo

# Generate summary
total_configs=$((config_count + env_config_count + precedence_config_count + edge_case_count + error_config_count + package_json_count))

echo "🎉 Test Configuration Generation Complete!"
echo "=========================================="
print_success "Generated $total_configs test configurations:"
echo "  📋 Basic framework configs: $config_count"
echo "  🌍 Environment variable configs: $env_config_count"
echo "  🔄 Precedence test configs: $precedence_config_count"
echo "  ⚡ Edge case configs: $edge_case_count"
echo "  ❌ Error test configs: $error_config_count"
echo "  📦 Package.json configs: $package_json_count"
echo
print_info "All configurations saved in: $(pwd)"
print_info "Run tests with: ./run-config-tests.sh"
echo
print_success "Test configuration generation complete!"
EOF

chmod +x scripts/generate-test-configs.sh
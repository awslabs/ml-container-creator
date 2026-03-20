# ML Container Creator Testing Scripts

This directory contains comprehensive testing scripts for ML Container Creator, designed to validate all configuration methods and serve as a foundation for future testing harness development.

## Scripts Overview

### 🚀 **[test-generate-projects.sh](test-generate-projects.sh)** - Comprehensive Project Generation Testing
The main testing script that validates all configuration features and methods by generating complete projects.

**Features:**
- **Comprehensive test coverage** of all configuration methods (CLI, env vars, config files, package.json)
- **All framework combinations** - sklearn, xgboost, tensorflow, transformers with their respective servers
- **Configuration precedence testing** - Validates CLI > Env > Config > Package.json > Defaults
- **Error handling validation** - Tests invalid configurations and error messages
- **Performance testing** - Validates execution time and resource usage
- **Detailed logging** with colored output and progress tracking
- **Test result tracking** with pass/fail statistics
- **Environment variable preservation** and restoration
- **Cleanup management** with optional output preservation

**Usage:**
```bash
# Basic usage (creates timestamped output directory)
./scripts/test-generate-projects.sh

# Custom output directory
./scripts/test-generate-projects.sh --output-dir ./my-test-output

# Keep test output for inspection
./scripts/test-generate-projects.sh --keep-output

# Verbose logging
./scripts/test-generate-projects.sh --verbose

# All options combined
./scripts/test-generate-projects.sh --output-dir ./test-results --keep-output --verbose
```

**Environment Variables:**
```bash
export TEST_OUTPUT_DIR="./custom-test-dir"    # Set output directory
export KEEP_TEST_OUTPUT="true"                # Keep output after completion
export VERBOSE="true"                         # Enable verbose logging
```

### 🔧 **[test-generate-configs.sh](test-generate-configs.sh)** - Test Configuration Generator
Generates comprehensive test configurations for all supported framework combinations.

**Features:**
- **Framework combinations** - All supported frameworks with all format/server combinations
- **Environment variable configs** - Test configurations for environment variable scenarios
- **Precedence test configs** - Configurations to test precedence rules
- **Edge case configs** - Minimal, maximal, production, and development configurations
- **Error test configs** - Invalid configurations for error handling testing
- **Package.json configs** - Package.json section configurations

**Usage:**
```bash
# Generate configs in default directory (./test-configs)
./scripts/test-generate-configs.sh

# Generate configs in custom directory
./scripts/test-generate-configs.sh ./my-test-configs

# With verbose output
VERBOSE=true ./scripts/test-generate-configs.sh
```

### 📊 **[test-generation-parameters.sh](test-generation-parameters.sh)** - Flexible Test Runner
Provides different levels of test output verbosity for development and debugging.

**Usage:**
```bash
./scripts/test-generation-parameters.sh quick      # Fast test with minimal output
./scripts/test-generation-parameters.sh verbose    # Detailed test output
./scripts/test-generation-parameters.sh debug      # Full debug output with stack traces
./scripts/test-generation-parameters.sh watch      # Watch mode for development
./scripts/test-generation-parameters.sh single 'pattern'  # Run specific test
./scripts/test-generation-parameters.sh framework sklearn # Run framework-specific tests
./scripts/test-generation-parameters.sh all        # Run all tests (default)
```

### 📚 **[docs.sh](docs.sh)** - Documentation Generator
Generates and serves project documentation.

## Generated Projects and Test Coverage

### test-generate-projects.sh Creates These Projects:

**CLI Options Testing:**
- `cli-sklearn-flask/` - sklearn + Flask + pkl format
- `cli-xgboost-fastapi/` - XGBoost + FastAPI + json format  
- `cli-tensorflow-flask/` - TensorFlow + Flask + keras format
- `cli-transformers-vllm/` - Transformers + vLLM (GPU-enabled)

**Environment Variables Testing:**
- `env-basic/` - GPU-enabled instance with AWS role
- `env-minimal/` - CPU-optimized instance, minimal config
- `env-complete/` - Full environment variable configuration

**Configuration Files Testing:**
- `sklearn-from-config/` - sklearn + Flask from JSON config
- `xgboost-from-config/` - XGBoost + FastAPI from JSON config
- `tensorflow-from-config/` - TensorFlow + FastAPI from JSON config
- `transformers-from-config/` - Transformers + vLLM from JSON config
- `production-config/` - Production-ready sklearn + FastAPI
- `development-config/` - Development tensorflow + Flask with all features

**Other Testing:**
- `package-json-project/` - Configuration from package.json
- `precedence-test/` - CLI options overriding environment variables

## Test Output Structure

### test-generate-projects.sh Output Directory Structure
```
test-output-YYYYMMDD-HHMMSS/
├── cli-sklearn-flask/          # CLI option test projects
├── cli-xgboost-fastapi/
├── cli-tensorflow-flask/
├── cli-transformers-vllm/
├── env-basic/                  # Environment variable test projects
├── env-minimal/
├── env-complete/
├── config-test-sklearn-config/ # Config file test projects
├── config-test-xgboost-config/
├── config-test-tensorflow-config/
├── config-test-transformers-config/
├── config-test-production-config/
├── config-test-development-config/
├── package-json-test/          # Package.json test project
├── precedence-test/            # Precedence test project
├── sklearn-config.json         # Test configuration files
├── xgboost-config.json
├── tensorflow-config.json
├── transformers-config.json
├── production-config.json
├── development-config.json
├── package.json
├── *.log                       # Test execution logs
└── test-suite.log             # Complete test suite log
```

### test-generate-configs.sh Output Structure
```
test-configs/ (or custom directory)
├── basic-sklearn-flask-pkl-cpu-optimized.json
├── basic-sklearn-flask-pkl-gpu-enabled.json
├── basic-sklearn-flask-joblib-cpu-optimized.json
├── basic-sklearn-fastapi-pkl-cpu-optimized.json
├── basic-xgboost-flask-json-cpu-optimized.json
├── basic-xgboost-fastapi-model-gpu-enabled.json
├── basic-tensorflow-flask-keras-cpu-optimized.json
├── basic-tensorflow-fastapi-SavedModel-gpu-enabled.json
├── basic-transformers-vllm-gpu-enabled.json
├── basic-transformers-sglang-gpu-enabled.json
├── env-config-1.json          # Environment variable test configs
├── env-config-2.json
├── precedence-cli-over-env.json # Precedence test configs
├── precedence-cli-over-config.json
├── edge-minimal.json          # Edge case configs
├── edge-maximal.json
├── edge-production.json
├── edge-development.json
├── error-invalid-framework.json # Error test configs
├── error-invalid-combination.json
├── package-basic.json         # Package.json configs
└── package-filtered.json
```

## What You Can Do With Generated Projects

### Complete, Runnable Projects
Each generated project contains everything needed for ML model deployment:

**Core Files:**
- `Dockerfile` - Container definition optimized for the chosen framework
- `requirements.txt` - Python dependencies (traditional ML frameworks)
- `code/model_handler.py` - Model loading and inference logic (traditional ML)
- `code/serve.py` - Flask/FastAPI server implementation (traditional ML)
- `code/serve` - vLLM/SGLang serving script (transformers)
- `deploy/build_and_push.sh` - Build and push to ECR
- `deploy/deploy.sh` - Deploy to SageMaker
- `test/test_endpoint.sh` - Test deployed endpoint

**Framework-Specific Features:**
- **sklearn/xgboost/tensorflow**: Traditional ML serving with Flask/FastAPI
- **transformers**: LLM serving with vLLM or SGLang
- **GPU vs CPU**: Appropriate instance types and configurations
- **Testing**: Local and hosted endpoint testing

### Testing Generated Projects

**Local Testing:**
```bash
# Navigate to any generated project
cd test-output-*/cli-sklearn-flask/

# Build and test locally
docker build -t my-model .
docker run -p 8080:8080 my-model

# Test endpoints
curl http://localhost:8080/ping
curl -X POST http://localhost:8080/invocations -H "Content-Type: application/json" -d '{"instances": [[1,2,3]]}'
```

**AWS Deployment Testing:**
```bash
# Deploy to AWS (requires AWS credentials)
./deploy/build_and_push.sh
./deploy/deploy.sh arn:aws:iam::123456789012:role/SageMakerRole

# Test deployed endpoint
./test/test_endpoint.sh my-endpoint-name
```

### Comparing Configurations
Use the generated projects to understand differences between:
- **Frameworks**: Compare sklearn vs tensorflow vs transformers projects
- **Servers**: Compare Flask vs FastAPI implementations  
- **Instance Types**: See CPU vs GPU configurations
- **Configuration Methods**: Compare CLI vs config file vs environment variable results

## Configuration Test Coverage
| Framework | Model Formats | Model Servers | Instance Types |
|-----------|---------------|---------------|----------------|
| **sklearn** | pkl, joblib | Flask, FastAPI | CPU, GPU |
| **xgboost** | json, model, ubj | Flask, FastAPI | CPU, GPU |
| **tensorflow** | keras, h5, SavedModel | Flask, FastAPI | CPU, GPU |
| **transformers** | N/A | vLLM, SGLang | GPU |

### Configuration Methods Tested
1. **CLI Options** - All supported CLI flags with validation
2. **Environment Variables** - AWS_REGION, ML_INSTANCE_TYPE, AWS_ROLE, ML_CONTAINER_CREATOR_CONFIG
3. **Configuration Files** - Custom JSON files with all parameter combinations
4. **Package.json** - Package.json sections with supported parameters
5. **Precedence Rules** - CLI > Env > Config > Package.json > Defaults
6. **Error Handling** - Invalid frameworks, missing parameters, incompatible combinations

### Test Scenarios Covered
- **Basic Generation** - All framework/server/format combinations
- **Environment Variables** - Multiple environment variable scenarios
- **Configuration Precedence** - Higher precedence overriding lower precedence
- **Edge Cases** - Minimal, maximal, production, and development configurations
- **Error Handling** - Invalid configurations and error message validation
- **Performance** - Test execution time and resource usage
- **File Generation** - Correct files generated for each configuration
- **Content Validation** - Generated file content matches configuration

## Future Testing Harness Development

These scripts provide a solid foundation for future testing harness development:

### Extensibility Features
- **Modular test functions** - Easy to add new test types
- **Configuration-driven testing** - JSON configurations define test scenarios
- **Parameterized test generation** - Automatic generation of test combinations
- **Result tracking** - Comprehensive pass/fail statistics
- **Logging infrastructure** - Detailed logging with multiple verbosity levels

### Integration Points
- **CI/CD Integration** - Scripts return proper exit codes for automation
- **Test Result Reporting** - Structured output for test result processing
- **Configuration Management** - Centralized configuration for test scenarios
- **Environment Management** - Proper setup and cleanup of test environments

### Expansion Opportunities
1. **Performance Testing** - Add benchmarking and performance regression testing
2. **Integration Testing** - Add Docker build and deployment testing
3. **Security Testing** - Add security scanning and vulnerability testing
4. **Load Testing** - Add concurrent generation and stress testing
5. **Regression Testing** - Add automated regression test suite
6. **Cross-Platform Testing** - Add Windows and macOS testing support

### Running the Comprehensive Test Suite

**Quick Start:**
```bash
# Run all tests and generate projects
./scripts/test-generate-projects.sh

# Keep output for inspection
./scripts/test-generate-projects.sh --keep-output

# Generate configuration files for manual testing
./scripts/test-generate-configs.sh ./my-configs

# Run unit tests with different verbosity
./scripts/test-generation-parameters.sh verbose
```

**For PR Validation:**
```bash
# Complete validation before submitting PRs
npm run validate

# Or run comprehensive project generation testing
./scripts/test-generate-projects.sh --verbose --keep-output
```
## Best Practices

### Running Tests
2. **Keep test output** when debugging failures (`--keep-output`)
3. **Use verbose mode** for detailed debugging (`--verbose`)
4. **Run complete validation** before submitting PRs (`npm run validate`)

### Adding New Tests
1. **Follow existing patterns** for consistency
2. **Add both success and failure cases** for comprehensive coverage
3. **Include configuration validation** to ensure expected behavior
4. **Add logging** for debugging and progress tracking
5. **Update documentation** when adding new test types

### Debugging Test Failures
1. **Check test logs** in the output directory
2. **Use verbose mode** to see detailed execution
3. **Inspect generated projects** to validate file content
4. **Run individual test components** to isolate issues
5. **Check environment variables** and configuration precedence

## For Contributors: Adding New Tests

### Adding Integration Tests

When adding new features that require end-to-end testing, consider adding to the comprehensive test scripts:

#### 1. Adding New Framework Support

**Update `test-generate-projects.sh`:**
```bash
# Add your framework to the CLI options tests (around line 697)
test_cli_options "sklearn" "flask" "pkl"
test_cli_options "xgboost" "fastapi" "json"
test_cli_options "tensorflow" "flask" "keras"
test_cli_options "transformers" "vllm" ""
test_cli_options "yourframework" "flask" "custom"  # Add this line

# Add configuration file test (around line 713)
test_config_file "yourframework-config.json" "yourframework-from-config" "yourframework" "flask"
```

**Create configuration template in `create_test_configs()` function:**
```bash
# Add around line 200 in test-generate-projects.sh
cat > yourframework-config.json << 'EOF'
{
  "projectName": "yourframework-from-config",
  "framework": "yourframework",
  "modelServer": "flask",
  "modelFormat": "custom",
  "includeSampleModel": true,
  "includeTesting": true,
  "instanceType": "cpu-optimized",
  "awsRegion": "us-east-1",
  "awsRoleArn": "arn:aws:iam::123456789012:role/YourFrameworkRole"
}
EOF
```

#### 2. Adding New Configuration Options

**Update validation functions:**
```bash
# In test_cli_options function, add validation for your new files
if [[ "$framework" == "yourframework" ]]; then
    expected_files+=("code/your_handler.py")
else
    expected_files+=("code/model_handler.py" "code/serve.py")
fi
```

**Add environment variable tests:**
```bash
# In test_env_variables function, add validation for your new options
if ! validate_file_content "deploy/deploy.sh" "$your_new_option" "Your new option in deploy script"; then
    validation_passed=false
fi
```

#### 3. Adding New Test Scenarios

**Create new test functions:**
```bash
test_your_new_feature() {
    local test_name="$1"
    local your_param="$2"
    
    print_substep "Testing your new feature: $test_name"
    
    mkdir -p "your-feature-test-$test_name"
    cd "your-feature-test-$test_name"
    
    if yo @aws/ml-container-creator \
        --framework=sklearn \
        --your-new-option="$your_param" \
        --skip-prompts > "../your-feature-$test_name.log" 2>&1; then
        
        # Validate your feature works
        if validate_file_content "some-file.txt" "$your_param" "Your feature validation"; then
            cd ..
            print_success "Your feature test passed: $test_name"
            record_test_result "Your Feature: $test_name" "PASS"
            return 0
        else
            cd ..
            record_test_result "Your Feature: $test_name" "FAIL"
            return 1
        fi
    else
        cd ..
        print_error "Your feature test failed: $test_name"
        record_test_result "Your Feature: $test_name" "FAIL"
        return 1
    fi
}

# Add to main() function
print_step "N" "Testing Your New Feature"
test_your_new_feature "basic" "test-value"
test_your_new_feature "advanced" "advanced-value"
echo
```

### Adding Configuration Generation Tests

**Update `test-generate-configs.sh`:**

#### 1. Add New Framework Configurations
```bash
# Add to FRAMEWORKS array (around line 30)
declare -A FRAMEWORKS=(
    ["sklearn"]="pkl,joblib"
    ["xgboost"]="json,model,ubj"
    ["tensorflow"]="keras,h5,SavedModel"
    ["transformers"]=""
    ["yourframework"]="custom,other"  # Add this line
)

# Add to SERVERS array
declare -A SERVERS=(
    ["sklearn"]="flask,fastapi"
    ["xgboost"]="flask,fastapi"
    ["tensorflow"]="flask,fastapi"
    ["transformers"]="vllm,sglang"
    ["yourframework"]="flask,fastapi"  # Add this line
)
```

#### 2. Add New Configuration Templates
```bash
# Add new configuration generation function
generate_yourframework_configs() {
    local output_dir="$1"
    
    print_step "Generating YourFramework configurations"
    
    for format in custom other; do
        for server in flask fastapi; do
            for instance in cpu-optimized gpu-enabled; do
                local filename="basic-yourframework-${server}-${format}-${instance}.json"
                
                cat > "$output_dir/$filename" << EOF
{
  "projectName": "yourframework-${server}-${format}",
  "framework": "yourframework",
  "modelServer": "$server",
  "modelFormat": "$format",
  "instanceType": "$instance",
  "includeSampleModel": true,
  "includeTesting": true,
  "awsRegion": "us-east-1"
}
EOF
                verbose_log "Created: $filename"
            done
        done
    done
}

# Add to main generation function
generate_yourframework_configs "$OUTPUT_DIR"
```

### Testing Best Practices for Contributors

#### 1. Test Isolation
```bash
# ✅ Good: Each test runs in its own directory
mkdir -p "test-$framework-$server"
cd "test-$framework-$server"
# ... run test
cd ..

# ❌ Avoid: Tests interfering with each other
yo @aws/ml-container-creator --framework=sklearn  # Files created in current dir
yo @aws/ml-container-creator --framework=xgboost  # Overwrites previous files
```

#### 2. Comprehensive Validation
```bash
# ✅ Good: Validate both file existence and content
if [[ -f "Dockerfile" ]]; then
    if validate_file_content "Dockerfile" "FROM python:" "Python base image"; then
        print_success "Dockerfile validation passed"
    else
        print_error "Dockerfile content validation failed"
        return 1
    fi
else
    print_error "Dockerfile not found"
    return 1
fi

# ❌ Avoid: Only checking file existence
if [[ -f "Dockerfile" ]]; then
    print_success "Test passed"
fi
```

#### 3. Error Handling
```bash
# ✅ Good: Proper error handling and cleanup
test_your_feature() {
    local test_dir="test-your-feature"
    
    mkdir -p "$test_dir"
    cd "$test_dir"
    
    if yo @aws/ml-container-creator --your-option --skip-prompts > ../test.log 2>&1; then
        # Validate success case
        validate_files ["expected-file.txt"] "your feature test"
        cd ..
        record_test_result "Your Feature" "PASS"
        return 0
    else
        cd ..  # Always return to parent directory
        record_test_result "Your Feature" "FAIL"
        if [[ "$VERBOSE" == "true" ]]; then
            echo "Test output:"
            cat test.log
        fi
        return 1
    fi
}

# ❌ Avoid: No cleanup on failure
test_your_feature() {
    mkdir -p "test-dir"
    cd "test-dir"
    yo @aws/ml-container-creator --your-option --skip-prompts
    # If this fails, we're stuck in test-dir
    validate_files ["expected-file.txt"] "test"
}
```

#### 4. Meaningful Test Output
```bash
# ✅ Good: Clear, informative output
print_substep "Testing sklearn + Flask + pkl format"
verbose_log "Running: yo @aws/ml-container-creator --framework=sklearn --model-server=flask --model-format=pkl --skip-prompts"
if validate_files ["Dockerfile", "requirements.txt"] "sklearn Flask generation"; then
    print_success "sklearn + Flask test passed"
else
    print_error "sklearn + Flask test failed - missing expected files"
fi

# ❌ Avoid: Unclear or missing output
yo @aws/ml-container-creator --framework=sklearn --model-server=flask --skip-prompts > /dev/null
if [[ -f "Dockerfile" ]]; then
    echo "OK"
fi
```

### Integration with Unit Tests

The integration tests in `scripts/` should complement, not duplicate, the unit tests in `test/`:

#### Division of Responsibilities

**Unit Tests (`test/`):**
- Parameter parsing and validation
- Configuration precedence rules
- Error handling and edge cases
- Template processing logic
- Fast, focused testing

**Integration Tests (`scripts/`):**
- End-to-end project generation
- Complete file structure validation
- Multi-configuration scenarios
- Real-world usage patterns
- Comprehensive validation

#### Coordination
```bash
# Integration tests should validate that unit test scenarios work end-to-end
# Example: Unit tests verify CLI parsing, integration tests verify CLI generates correct projects

# Unit test (in test/cli-options.test.js):
it('should parse --framework=sklearn correctly', () => {
    const config = parseCliOptions(['--framework=sklearn']);
    assert.equal(config.framework, 'sklearn');
});

# Integration test (in scripts/test-generate-projects.sh):
test_cli_options "sklearn" "flask" "pkl"  # Verifies sklearn CLI option generates working project
```

### Performance Considerations

#### Test Execution Time
```bash
# ✅ Good: Reasonable test scope
test_cli_options "sklearn" "flask" "pkl"      # Test one representative combination
test_cli_options "transformers" "vllm" ""     # Test different pattern

# ❌ Avoid: Exhaustive combinations in integration tests
# Don't test every possible combination - that's what property tests are for
for framework in sklearn xgboost tensorflow transformers; do
    for server in flask fastapi vllm sglang; do
        for format in pkl json keras; do
            test_cli_options "$framework" "$server" "$format"  # Too many combinations
        done
    done
done
```

#### Resource Management
```bash
# ✅ Good: Clean up test artifacts
cleanup() {
    if [[ "$KEEP_TEST_OUTPUT" != "true" ]]; then
        rm -rf "$TEST_OUTPUT_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ❌ Avoid: Leaving test artifacts
# No cleanup - fills up disk space over time
```

For detailed unit testing guidelines, see [`test/README.md`](../test/README.md).
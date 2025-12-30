# ML Container Creator Testing Scripts

This directory contains comprehensive testing scripts for ML Container Creator, designed to validate all configuration methods and serve as a foundation for future testing harness development.

## Scripts Overview

### 🧪 **[test-pr.sh](test-pr.sh)** - Comprehensive PR Testing
The main testing script that validates all configuration features and methods.

**Features:**
- **Configurable output directory** with timestamp-based naming
- **Comprehensive test coverage** of all configuration methods
- **Detailed logging** with colored output and progress tracking
- **Test result tracking** with pass/fail statistics
- **Environment variable preservation** and restoration
- **Cleanup management** with optional output preservation

**Usage:**
```bash
# Basic usage (creates timestamped output directory)
./scripts/test-pr.sh

# Custom output directory
./scripts/test-pr.sh --output-dir ./my-test-output

# Keep test output for inspection
./scripts/test-pr.sh --keep-output

# Verbose logging
./scripts/test-pr.sh --verbose

# All options combined
./scripts/test-pr.sh --output-dir ./test-results --keep-output --verbose
```

**Environment Variables:**
```bash
export TEST_OUTPUT_DIR="./custom-test-dir"    # Set output directory
export KEEP_TEST_OUTPUT="true"                # Keep output after completion
export VERBOSE="true"                         # Enable verbose logging
```

### 🔧 **[generate-test-configs.sh](generate-test-configs.sh)** - Test Configuration Generator
Generates comprehensive test configurations for all supported framework combinations.

**Features:**
- **Framework combinations** - All supported frameworks with all format/server combinations
- **Environment variable configs** - Test configurations for environment variable scenarios
- **Precedence test configs** - Configurations to test precedence rules
- **Edge case configs** - Minimal, maximal, production, and development configurations
- **Error test configs** - Invalid configurations for error handling testing
- **Package.json configs** - Package.json section configurations
- **Test execution script** - Automated runner for all generated configurations

**Usage:**
```bash
# Generate configs in default directory (./test-configs)
./scripts/generate-test-configs.sh

# Generate configs in custom directory
./scripts/generate-test-configs.sh ./my-test-configs

# Run generated tests
cd ./test-configs
./run-config-tests.sh
```

### 📊 **[test.sh](test.sh)** - Flexible Test Runner
Provides different levels of test output verbosity for development.

**Usage:**
```bash
./scripts/test.sh quick      # Fast test with minimal output
./scripts/test.sh verbose    # Detailed test output
./scripts/test.sh debug      # Full debug output with stack traces
./scripts/test.sh watch      # Watch mode for development
./scripts/test.sh single 'pattern'  # Run specific test
./scripts/test.sh framework sklearn # Run framework-specific tests
./scripts/test.sh all        # Run all tests (default)
```

## Test Output Structure

### test-pr.sh Output Directory Structure
```
test-output-YYYYMMDD-HHMMSS/
├── cli-sklearn-flask/          # CLI option test projects
├── cli-xgboost-fastapi/
├── cli-tensorflow-flask/
├── cli-transformers-vllm/
├── env-basic/                  # Environment variable test projects
├── env-minimal/
├── env-complete/
├── sklearn-from-config/        # Config file test projects
├── xgboost-from-config/
├── tensorflow-from-config/
├── transformers-from-config/
├── production-config/
├── development-config/
├── package-json-project/       # Package.json test project
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

### generate-test-configs.sh Output Structure
```
test-configs/
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
├── package-filtered.json
└── run-config-tests.sh        # Test execution script
```

## Configuration Test Coverage

### Framework Combinations Tested
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

## Best Practices

### Running Tests
1. **Use timestamped directories** to avoid conflicts between test runs
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

This testing infrastructure ensures comprehensive validation of ML Container Creator's configuration system while providing a robust foundation for future testing enhancements.
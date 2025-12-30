# Testing Guide

ML Container Creator has a comprehensive test suite that ensures reliability and correctness across all supported configurations. This guide explains our testing philosophy, architecture, and how to run and contribute to the tests.

## Testing Philosophy

Our testing approach combines multiple complementary strategies to ensure comprehensive coverage and reliability:

### 🎯 **Focused Unit Tests**
Each test module focuses on a specific capability (CLI options, environment variables, configuration files, etc.), making it easy to understand what's being tested and debug failures when they occur.

### 🔬 **Property-Based Testing**
Using [fast-check](https://github.com/dubzzz/fast-check), we test universal correctness properties across thousands of parameter combinations, ensuring the system behaves correctly for all valid inputs, not just the examples we think of.

### 🔒 **Security & Quality Assurance**
Automated security auditing and code quality checks ensure the generated containers and deployment scripts follow best practices and don't introduce vulnerabilities.

### 📊 **Comprehensive Coverage**
- **87 unit tests** covering specific functionality
- **10 property tests** validating universal behavior
- **1000+ test iterations** across all parameter combinations
- **Multi-Node.js version testing** ensuring compatibility

### ⚡ **Fast Feedback**
Tests complete in ~6 seconds, providing rapid feedback during development while maintaining comprehensive coverage.

## Test Architecture

### Unit Tests (87 tests)

Our unit tests are organized into focused modules by capability:

#### 📋 **CLI Options Testing** (`cli-options.test.js`)
Tests command-line option parsing and validation:
- Framework-specific CLI options (`--framework=sklearn`)
- Boolean options (`--include-testing=false`)
- String array options (`--test-types=cli,endpoint`)
- CLI validation and error handling
- Help and special commands

#### 🌍 **Environment Variables Testing** (`environment-variables.test.js`)
Tests environment variable parsing and precedence:
- String variables (`AWS_REGION=us-east-1`)
- Boolean variables (`ML_INCLUDE_TESTING=true`)
- Invalid value handling and validation
- Environment variable to parameter mapping

#### 📁 **Configuration Files Testing** (`configuration-files.test.js`)
Tests configuration file parsing and validation:
- Custom config files (`ml-container.config.json`)
- Package.json sections (`"ml-container-creator": {...}`)
- CLI config files (`--config=prod.json`)
- Malformed file handling and error reporting

#### 🔄 **Configuration Precedence Testing** (`configuration-precedence.test.js`)
Tests the complete configuration precedence system:
- CLI options vs environment variables
- Environment variables vs config files
- Config file precedence order
- Complex multi-source scenarios
- Partial configuration merging

#### 📄 **File Generation Testing** (`file-generation.test.js`)
Tests correct file generation and template processing:
- Framework-specific files (sklearn vs transformers)
- Optional module inclusion (sample models, tests)
- Server-specific files (Flask vs FastAPI vs vLLM)
- File content validation
- Conditional file exclusion logic

#### ⚠️ **Error Handling Testing** (`error-handling.test.js`)
Tests validation and error scenarios:
- Invalid framework combinations
- Missing required parameters
- Malformed configuration files
- Network and file system errors

### Property-Based Tests (10 universal properties)

Property-based tests validate universal correctness properties using automated test generation:

#### **Property 1: Parameter Source Enforcement**
For any parameter and configuration source combination, if the parameter matrix marks that source as unsupported, then the ConfigManager should ignore values from that source.

```javascript
// Example: Framework parameter should be ignored from environment variables
process.env.ML_FRAMEWORK = 'sklearn';  // Should be ignored
// Only CLI options and config files should be used for framework
```

#### **Property 2: Environment Variable Mapping**
For any supported environment variable, when set with a valid value, the ConfigManager should correctly map it to the corresponding internal parameter name.

```javascript
// Example: AWS_REGION should map to awsRegion parameter
process.env.AWS_REGION = 'us-west-2';
// Should result in config.awsRegion = 'us-west-2'
```

#### **Property 3: CLI Option Name Consistency**
For any CLI option defined in the parameter matrix, the generator should accept that exact option name and map it to the correct internal parameter.

```javascript
// Example: --model-server should map to modelServer parameter
// --region should map to awsRegion parameter
```

#### **Property 4: Package.json Filtering**
For any parameter not supported in package.json according to the matrix, when specified in the package.json ml-container-creator section, the ConfigManager should ignore it.

```javascript
// Example: framework in package.json should be ignored
{
  "ml-container-creator": {
    "framework": "sklearn",  // Should be ignored
    "awsRegion": "us-east-1" // Should be used
  }
}
```

#### **Property 5: Default Value Application**
For any parameter with a defined default value, when no value is provided from any source, the ConfigManager should apply the correct default value.

#### **Property 6: .yo-rc.json Isolation**
For any configuration present in .yo-rc.json files, the ConfigManager should completely ignore it and produce the same result as if the file didn't exist.

#### **Property 7: Non-Promptable Parameter Handling**
For any parameter marked as non-promptable in the matrix, when the parameter is missing from all sources, the ConfigManager should either use a default value or generate one without prompting.

#### **Property 8: Required Parameter Validation**
For any parameter marked as required in the matrix, when the parameter is missing from all sources and cannot be prompted, the ConfigManager should produce a validation error.

#### **Property 9: Config File Path Resolution**
For any valid file path provided via ML_CONTAINER_CREATOR_CONFIG environment variable, the ConfigManager should correctly resolve and load the configuration file.

#### **Property 10: Parameter Precedence Order**
For any parameter supported by multiple sources, when the same parameter is provided through different sources, the ConfigManager should use the value from the highest precedence source.

## Running Tests

### Complete Test Suite

```bash
# Run all tests (unit + property + security audit)
npm run validate

# Run all tests without security audit
npm run test:all

# Run unit tests only
npm test

# Run property-based tests only
npm run test:property
```

### Development Workflows

```bash
# Watch mode for unit tests (development)
npm run test:watch

# Watch mode for property tests
npm run test:property:watch

# Run with coverage report
npm run test:coverage
```

### Targeted Testing

```bash
# Run specific test categories
npm test -- --grep "CLI Options"        # CLI option tests
npm test -- --grep "Environment"        # Environment variable tests
npm test -- --grep "precedence"         # Configuration precedence tests
npm test -- --grep "sklearn"            # Framework-specific tests

# Run specific property tests
npm run test:property -- --grep "Property 1"  # Parameter source enforcement
npm run test:property -- --grep "Property 10" # Parameter precedence order

# Run tests for specific functionality
npm test -- --grep "file generation"    # File generation tests
npm test -- --grep "error handling"     # Error handling tests
```

## Test Output and Debugging

### Detailed Progress Reporting

Our tests provide excellent visibility into what's being tested:

```
🧪 Test #1: should parse sklearn CLI options correctly
📍 Test Suite: CLI Options Parsing
🔍 Checking 6 expected files for sklearn CLI parsing...
✅ Found: Dockerfile
✅ Found: requirements.txt
✅ Found: code/model_handler.py
✅ Found: code/serve.py
✅ Found: deploy/build_and_push.sh
✅ Found: deploy/deploy.sh
📊 Summary: All 6 expected files found
```

### Debug Information

When tests fail, detailed context is provided:

```
🔍 DEBUG: Current state for test #5 failure:
📁 Working directory: /tmp/test-dir
📄 Files in current directory (3 total): [Dockerfile, requirements.txt, ...]
📋 Expected files: [Dockerfile, requirements.txt, code/model_handler.py, ...]
❌ Missing files: [code/model_handler.py]
```

### Property Test Reporting

Property tests show comprehensive coverage:

```
🔬 Property 1: Parameter Source Enforcement
📝 Testing parameter source enforcement across 100 iterations
🔍 Testing unsupported parameter: framework from environment variables
✅ Parameter correctly ignored from unsupported source
📊 Property 1 validated: Parameter source enforcement working correctly
```

## Test Statistics

Current test status:
- ✅ **87 unit tests passing** - All functionality validated
- ✅ **10 property tests passing** - Universal correctness verified
- ✅ **100% success rate** - Zero failing tests
- ✅ **~6 second execution** - Fast feedback cycle
- ✅ **1000+ iterations** - Comprehensive coverage across all parameter combinations

## Continuous Integration

All pull requests are automatically tested with our comprehensive CI pipeline:

### 🔄 **Multi-Node Testing**
Tests run on Node.js 24.x and 22.x to ensure compatibility across supported versions.

### 📋 **Complete Validation Pipeline**

1. **Code Quality** - ESLint checks for code standards and best practices
2. **Security Audit** - npm audit for known vulnerabilities
3. **Unit Tests** - All 87 unit tests across all functionality
4. **Property Tests** - All 10 universal correctness properties
5. **Integration Tests** - End-to-end generator functionality testing
6. **Coverage Analysis** - Test coverage reporting and analysis

### ✅ **PR Requirements**

Before your PR can be merged, it must:
- ✅ Pass all tests on supported Node.js versions
- ✅ Pass ESLint code quality checks
- ✅ Pass security audit (no high/critical vulnerabilities)
- ✅ Maintain or improve test coverage
- ✅ Successfully generate containers with CLI options

## Contributing to Tests

### Adding Tests for New Features

When adding new functionality, include appropriate tests following our patterns:

#### 1. Choose the Right Test Module

- **CLI option changes** → `cli-options.test.js`
- **Environment variable changes** → `environment-variables.test.js`
- **Config file changes** → `configuration-files.test.js`
- **Precedence changes** → `configuration-precedence.test.js`
- **Template/file changes** → `file-generation.test.js`
- **Error handling changes** → `error-handling.test.js`

#### 2. Follow Our Test Patterns

```javascript
import { 
    getGeneratorPath, 
    validateFiles, 
    setupTestHooks 
} from './test-utils.js';

describe('Your Feature Category', () => {
    let helpers;

    before(async () => {
        console.log('\n🚀 Starting Your Feature Tests');
        helpers = await import('yeoman-test');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('Your Feature Category');

    it('should handle your specific functionality', async () => {
        console.log(`\n  🧪 Testing your functionality...`);
        
        await helpers.default.run(getGeneratorPath())
            .withOptions({ /* your test options */ });

        validateFiles(['expected-file.txt'], 'your test context');
        console.log(`    ✅ Functionality working correctly`);
    });
});
```

#### 3. Test Both Success and Failure Cases

```javascript
// Test successful case
it('should generate files for valid configuration', async () => {
    await helpers.default.run(getGeneratorPath())
        .withOptions({ framework: 'sklearn', modelFormat: 'pkl' });
    
    validateFiles(['Dockerfile', 'requirements.txt'], 'sklearn generation');
});

// Test error case
it('should show error for invalid configuration', async () => {
    try {
        await helpers.default.run(getGeneratorPath())
            .withOptions({ framework: 'invalid' });
        assert.fail('Should have thrown an error');
    } catch (error) {
        assert(error.message.includes('not implemented'));
    }
});
```

#### 4. Add Property Tests for Universal Behavior

If your feature affects parameter handling, consider adding property tests:

```javascript
// Add to parameter-matrix-compliance.property.test.js
describe('Property N: Your Universal Property', () => {
    it('should maintain universal correctness for your feature', async function() {
        await fc.assert(fc.asyncProperty(
            generateYourTestData(),
            async (testData) => {
                // Test your universal property
                const result = await testYourFeature(testData);
                return validateUniversalProperty(result);
            }
        ), { numRuns: 100 });
    });
});
```

### Test Quality Standards

- **Descriptive test names** that explain what's being tested
- **Console output** showing test progress and context
- **Proper cleanup** of environment variables and temporary files
- **Error handling** for both expected and unexpected failures
- **Performance considerations** for property tests (reasonable iteration counts)

### Running Tests During Development

```bash
# Run tests continuously during development
npm run test:watch              # Unit tests in watch mode
npm run test:property:watch     # Property tests in watch mode

# Run specific test categories
npm test -- --grep "CLI Options"     # Your specific functionality
npm test -- --grep "sklearn"         # Framework-specific tests

# Quick validation before committing
npm run validate                # Full test suite + linting
```

## Test Infrastructure

### Shared Test Utilities

Our tests use shared utilities for consistency and maintainability:

#### **test-utils.js**
- Test constants (`FRAMEWORKS`, `REQUIRED_FILES`)
- Validation functions (`validateFiles`, `validateFileContent`)
- Helper functions (`createTempConfig`, `debugCurrentState`)
- Test setup hooks (`setupTestHooks`)

#### **property-test-utils.js**
- Parameter matrix definitions
- Configuration generators for property tests
- Validation utilities for universal properties
- Environment variable mappings

#### **config-generators.js**
- Smart configuration generators that understand constraints
- Framework/server/format relationship validation
- AWS ARN and project name generators
- Multi-source scenario generators

### Performance Optimizations

Several optimizations ensure reliable test execution:

1. **Reduced iterations** for complex properties (20-100 iterations based on complexity)
2. **Constrained generators** to avoid invalid combinations
3. **Timeout management** with configurable limits
4. **Efficient validation** with early returns for known invalid states
5. **Minimal logging** during property execution to reduce overhead

## Debugging Test Failures

### Common Issues and Solutions

1. **Tests timing out**
   - Usually indicates the generator is waiting for user input
   - Ensure `--skip-prompts` is used in test configurations
   - Check that all required parameters are provided

2. **File not found errors**
   - Check that expected files match what the generator actually creates
   - Verify template logic and conditional file generation
   - Use debug output to see actual vs expected files

3. **Content validation failures**
   - Use the debug output to see actual vs expected content
   - Check template processing and variable substitution
   - Verify framework-specific logic

4. **Property test failures**
   - Check that generators produce valid parameter combinations
   - Verify that universal properties hold for edge cases
   - Review constraint logic in test generators

### Debug Commands

```bash
# Run with full debug output
npm test -- --grep "your failing test"

# Run specific property test with verbose output
npm run test:property -- --grep "Property 1" --reporter spec

# Run with timeout debugging
DEBUG=* npm test

# Run single test file
npx mocha test/input-parsing-and-generation/cli-options.test.js
```

### Debug Output Features

Our tests provide excellent debugging information:

```bash
# Detailed file system state
🔍 DEBUG: Current state for test failure:
📁 Working directory: /tmp/test-dir
📄 Files in current directory: [list of files]
📋 Expected files: [list of expected files]
❌ Missing files: [list of missing files]

# Configuration state
🔍 Configuration loaded from sources:
   • CLI options: {framework: 'sklearn'}
   • Environment variables: {AWS_REGION: 'us-east-1'}
   • Config files: {}

# Property test progress
🔬 Property test iteration 45/100:
   • Generated config: {framework: 'tensorflow', modelServer: 'flask'}
   • Test result: ✅ Property holds
```

## Best Practices for Testing

### 1. Write Tests First
When adding new features, write tests first to clarify requirements and ensure comprehensive coverage.

### 2. Test Edge Cases
Don't just test the happy path - test edge cases, error conditions, and boundary values.

### 3. Use Property Tests for Universal Behavior
If your feature has universal properties that should hold for all inputs, add property tests.

### 4. Keep Tests Fast
Optimize test performance to maintain fast feedback cycles. Use reasonable iteration counts for property tests.

### 5. Provide Clear Error Messages
When tests fail, they should provide clear information about what went wrong and how to fix it.

### 6. Clean Up After Tests
Ensure tests clean up environment variables, temporary files, and other state to avoid test interference.

This comprehensive testing approach ensures that ML Container Creator remains reliable and correct across all supported configurations and use cases, while providing fast feedback for development and clear guidance for contributors.
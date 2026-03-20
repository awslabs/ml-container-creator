# ML Container Creator Test Suite

This directory contains the comprehensive test suite for ML Container Creator, ensuring reliability and correctness across all supported configurations and use cases.

## Test Architecture Overview

Our testing approach combines multiple complementary strategies for comprehensive coverage:

### 📋 **Unit Tests** (87 tests)
Focused tests for specific functionality organized by capability in `input-parsing-and-generation/`:

- **CLI Options** - Command-line option parsing and validation
- **Environment Variables** - Environment variable handling and precedence
- **Configuration Files** - JSON config files and package.json sections
- **Configuration Precedence** - Multi-source configuration merging
- **File Generation** - Template processing and conditional file creation
- **Error Handling** - Validation errors and edge cases

### 🔬 **Property-Based Tests** (10 universal properties)
Automated testing of universal correctness properties using [fast-check](https://github.com/dubzzz/fast-check):

- **Parameter Source Enforcement** - Unsupported sources are ignored
- **Environment Variable Mapping** - Correct variable-to-parameter mapping
- **CLI Option Consistency** - CLI options accepted and mapped correctly
- **Package.json Filtering** - Only supported parameters loaded from package.json
- **Default Value Application** - Correct defaults applied when values missing
- **Configuration Isolation** - .yo-rc.json files completely ignored
- **Non-Promptable Handling** - Non-interactive parameters handled correctly
- **Required Parameter Validation** - Missing required parameters produce errors
- **Config File Resolution** - Environment variable config paths work correctly
- **Parameter Precedence** - Highest precedence source values used

## Directory Structure

```
test/
├── README.md                           # This file - test suite overview
├── PROPERTY_TESTING_SUMMARY.md         # Property-based testing documentation
├── property-test-config.js             # Property test configuration
└── input-parsing-and-generation/       # Unit tests organized by capability
    ├── README.md                       # Detailed unit test documentation
    ├── cli-options.test.js             # CLI option parsing tests
    ├── environment-variables.test.js   # Environment variable tests
    ├── configuration-files.test.js     # Config file parsing tests
    ├── configuration-precedence.test.js # Multi-source precedence tests
    ├── file-generation.test.js         # Template and file generation tests
    ├── error-handling.test.js          # Validation and error tests
    ├── parameter-matrix-compliance.property.test.js # Property-based tests
    ├── config-generators.js            # Test data generators
    ├── property-test-utils.js          # Property test utilities
    └── test-utils.js                   # Shared test utilities
```

## Running Tests

### Complete Validation (Recommended)
```bash
# Run everything - same as CI pipeline
npm run validate                # ESLint + Security + All Tests

# Individual components
npm run lint                    # ESLint code quality checks
npm run security-audit          # Security vulnerability scan
npm test                        # Unit tests only
npm run test:property          # Property-based tests only
npm run test:all               # Unit + Property tests
```

### Development Workflows
```bash
# Watch modes for active development
npm run test:watch             # Unit tests in watch mode
npm run test:property:watch    # Property tests in watch mode

# Quick feedback during development
npm run test:quick             # Fast execution with minimal output
npm run test:debug             # Full debug output with stack traces
npm run test:coverage          # Tests with coverage report
```

### Targeted Testing
```bash
# Run specific test categories
npm test -- --grep "CLI Options"        # CLI-related tests
npm test -- --grep "Environment"        # Environment variable tests
npm test -- --grep "precedence"         # Configuration precedence tests
npm test -- --grep "sklearn"            # Framework-specific tests
npm test -- --grep "validation"         # Validation and error tests

# Run specific property tests
npm run test:property -- --grep "Property 1"   # Parameter source enforcement
npm run test:property -- --grep "Property 10"  # Parameter precedence order
```

## Test Features

### 🎯 **Comprehensive Coverage**
- **1000+ test iterations** across all parameter combinations
- **All configuration sources** tested (CLI, env vars, config files, package.json)
- **All frameworks** tested (sklearn, xgboost, tensorflow, transformers)
- **All precedence scenarios** validated
- **Error conditions** thoroughly tested

### 📊 **Detailed Reporting**
Tests provide excellent visibility into what's being validated:

```
🧪 Test #1: should parse sklearn CLI options correctly
📍 Test Suite: CLI Options Parsing
🔍 Checking 6 expected files for sklearn CLI parsing...
✅ Found: Dockerfile
✅ Found: requirements.txt
📊 Summary: All 6 expected files found
```

### 🔍 **Debug Information**
When tests fail, detailed context is provided:

```
🔍 DEBUG: Current state for test #5 failure:
📁 Working directory: /tmp/test-dir
📄 Files in current directory (3 total): [Dockerfile, requirements.txt, ...]
📋 Expected files: [Dockerfile, requirements.txt, code/model_handler.py]
❌ Missing files: [code/model_handler.py]
```

### ⚡ **Performance Optimized**
- **Smart test generation** - Only valid parameter combinations tested
- **Configurable timeouts** - Prevent hanging tests
- **Efficient validation** - Early returns for known invalid states
- **Minimal logging** during property execution for speed
- **~6 second execution** - Fast feedback cycle

## Test Results Status

Current test status:
- ✅ **87 unit tests passing** - All functionality validated
- ✅ **10 property tests passing** - Universal correctness verified
- ✅ **100% success rate** - Zero failing tests
- ✅ **~6 second execution** - Fast feedback cycle
- ✅ **1000+ iterations** - Comprehensive coverage

## For Contributors: Adding New Tests

### 1. Choose the Right Test Module

Based on what you're testing, add to the appropriate module:

| Functionality | Test Module | Purpose |
|---------------|-------------|---------|
| CLI option parsing | `cli-options.test.js` | New CLI flags, validation, help commands |
| Environment variables | `environment-variables.test.js` | New env vars, mapping, precedence |
| Config file parsing | `configuration-files.test.js` | JSON configs, package.json sections |
| Configuration precedence | `configuration-precedence.test.js` | Multi-source merging, priority rules |
| File generation | `file-generation.test.js` | Templates, conditional files, content |
| Error handling | `error-handling.test.js` | Validation errors, edge cases |
| Universal properties | `parameter-matrix-compliance.property.test.js` | System-wide correctness |

### 2. Follow Established Patterns

#### Unit Test Template
```javascript
import { 
    getGeneratorPath, 
    validateFiles, 
    validateFileContent,
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
        console.log(`\n  🧪 Test #1: Testing your functionality...`);
        console.log(`  📍 Test Suite: Your Feature Category`);
        
        await helpers.default.run(getGeneratorPath())
            .withOptions({ 
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl',
                skipPrompts: true
            });

        // Validate expected files are created
        validateFiles(['Dockerfile', 'requirements.txt'], 'your feature test');
        
        // Validate file content if needed
        validateFileContent('Dockerfile', 'FROM python:', 'Docker base image');
        
        console.log(`    ✅ Your functionality working correctly`);
    });

    it('should handle error cases for your functionality', async () => {
        console.log(`\n  🧪 Test #2: Testing error handling...`);
        
        try {
            await helpers.default.run(getGeneratorPath())
                .withOptions({ 
                    framework: 'invalid-framework',
                    skipPrompts: true
                });
            assert.fail('Should have thrown an error for invalid framework');
        } catch (error) {
            assert(error.message.includes('not implemented'), 
                   `Expected error message about implementation, got: ${error.message}`);
            console.log(`    ✅ Error handling working correctly`);
        }
    });
});
```

#### Property Test Template
```javascript
// Add to parameter-matrix-compliance.property.test.js
describe('Property N: Your Universal Property', () => {
    it('should maintain universal correctness for your feature', async function() {
        console.log('\n🧪 Test #N: Testing your universal property');
        console.log('📍 Test Suite: Parameter Matrix Compliance Properties');
        console.log('\n  🧪 Property N: Your Universal Property');
        console.log('  📝 Description of what this property validates');

        await fc.assert(fc.asyncProperty(
            generateYourTestData(),
            async (testData) => {
                console.log(`    🔍 Testing with: ${JSON.stringify(testData)}`);
                
                const result = await testYourFeature(testData);
                const isValid = validateUniversalProperty(result);
                
                if (isValid) {
                    console.log(`    ✅ Property validated for test data`);
                } else {
                    console.log(`    ❌ Property failed for test data`);
                }
                
                return isValid;
            }
        ), { 
            numRuns: 100,
            timeout: 30000
        });

        console.log('  ✅ Property N validated: Your property working correctly');
    });
});
```

### 3. Test Quality Standards

#### Required Elements
- **Descriptive test names** that explain what's being tested
- **Console output** showing test progress and numbered tests
- **Proper error handling** for both expected and unexpected failures
- **Cleanup** of environment variables and temporary files (use `setupTestHooks`)
- **Both success and failure cases** for comprehensive coverage

#### Best Practices
```javascript
// ✅ Good: Descriptive test name and clear output
it('should generate Flask server files for sklearn framework', async () => {
    console.log(`\n  🧪 Test #3: Testing sklearn + Flask file generation...`);
    
    await helpers.default.run(getGeneratorPath())
        .withOptions({ framework: 'sklearn', modelServer: 'flask', skipPrompts: true });
    
    validateFiles(['code/serve.py', 'code/flask/wsgi.py'], 'sklearn Flask generation');
    validateFileContent('code/serve.py', 'from flask import', 'Flask imports');
    
    console.log(`    ✅ Flask server files generated correctly`);
});

// ❌ Avoid: Vague test name and no output
it('should work', async () => {
    await helpers.default.run(getGeneratorPath()).withOptions({ framework: 'sklearn' });
    assert.file('Dockerfile');
});
```

### 4. Using Shared Utilities

Take advantage of the shared utilities in `test-utils.js`:

```javascript
import { 
    getGeneratorPath,           // Get correct generator path
    validateFiles,              // Validate expected files exist
    validateFileContent,        // Validate file content contains expected text
    setupTestHooks,            // Set up proper test environment
    debugCurrentState,         // Debug helper for failed tests
    FRAMEWORKS,                // Test constants
    REQUIRED_FILES,            // Expected files by framework
    createTempConfig           // Create temporary config files
} from './test-utils.js';

// Use constants for consistency
const expectedFiles = REQUIRED_FILES.sklearn.concat(['custom-file.txt']);
validateFiles(expectedFiles, 'sklearn with custom file');

// Use debug helper when tests fail
if (testFailed) {
    debugCurrentState('sklearn generation test');
}
```

### 5. Testing New Frameworks

When adding support for a new ML framework:

#### Update Test Constants
```javascript
// In test-utils.js, add your framework
export const FRAMEWORKS = {
    sklearn: { server: 'flask', format: 'pkl' },
    xgboost: { server: 'fastapi', format: 'json' },
    tensorflow: { server: 'flask', format: 'keras' },
    transformers: { server: 'vllm', format: null },
    yourFramework: { server: 'flask', format: 'custom' }  // Add this
};

export const REQUIRED_FILES = {
    sklearn: ['Dockerfile', 'requirements.txt', 'code/model_handler.py'],
    // ... other frameworks
    yourFramework: ['Dockerfile', 'requirements.txt', 'code/your_handler.py']  // Add this
};
```

#### Add Framework-Specific Tests
```javascript
// In appropriate test files, add framework-specific tests
describe('Your Framework Support', () => {
    it('should generate files for your framework', async () => {
        console.log(`\n  🧪 Testing your framework file generation...`);
        
        await helpers.default.run(getGeneratorPath())
            .withOptions({ 
                framework: 'yourFramework',
                modelServer: 'flask',
                modelFormat: 'custom',
                skipPrompts: true
            });

        validateFiles(REQUIRED_FILES.yourFramework, 'your framework generation');
        console.log(`    ✅ Your framework files generated correctly`);
    });
});
```

#### Update Property Tests
```javascript
// In config-generators.js, add your framework to generators
export const generateFramework = () => fc.constantFrom(
    'sklearn', 'xgboost', 'tensorflow', 'transformers', 'yourFramework'
);

export const generateModelFormat = (framework) => {
    switch (framework) {
        case 'sklearn': return fc.constantFrom('pkl', 'joblib');
        case 'xgboost': return fc.constantFrom('json', 'model', 'ubj');
        case 'tensorflow': return fc.constantFrom('keras', 'h5', 'SavedModel');
        case 'transformers': return fc.constant(null);
        case 'yourFramework': return fc.constantFrom('custom', 'other');  // Add this
        default: return fc.constant('pkl');
    }
};
```

### 6. Debugging Failed Tests

Our tests provide excellent debugging information:

#### Enable Debug Output
```bash
# Run with full debug information
npm run test:debug

# Run specific failing test with debug
npm test -- --grep "your failing test" --reporter spec --full-trace
```

#### Use Debug Utilities
```javascript
// In your test, add debug information
import { debugCurrentState } from './test-utils.js';

it('should do something', async () => {
    try {
        await helpers.default.run(getGeneratorPath())
            .withOptions({ /* your options */ });
        
        validateFiles(['expected-file.txt'], 'your test');
    } catch (error) {
        // Debug the current state when test fails
        debugCurrentState('your test context');
        throw error;  // Re-throw to fail the test
    }
});
```

#### Common Debug Information
The debug output shows:
- **Working directory** where the generator ran
- **Files in directory** (actual files created)
- **Expected vs actual** file lists
- **File content** for content validation failures
- **Environment variables** that were set during the test

### 7. Performance Considerations

#### Property Test Performance
```javascript
// ✅ Good: Reasonable iteration count
await fc.assert(fc.asyncProperty(
    generateTestData(),
    async (data) => { /* test logic */ }
), { 
    numRuns: 100,        // Reasonable for comprehensive coverage
    timeout: 30000       // Prevent hanging tests
});

// ❌ Avoid: Too many iterations
await fc.assert(fc.asyncProperty(
    generateTestData(),
    async (data) => { /* test logic */ }
), { 
    numRuns: 10000       // Too slow for development workflow
});
```

#### Test Isolation
```javascript
// ✅ Good: Use setupTestHooks for proper cleanup
describe('Your Tests', () => {
    setupTestHooks('Your Test Category');  // Handles cleanup automatically
    
    it('should test something', async () => {
        // Test logic - environment will be cleaned up automatically
    });
});

// ❌ Avoid: Manual cleanup that might be forgotten
describe('Your Tests', () => {
    afterEach(() => {
        // Manual cleanup - easy to forget or do incorrectly
        delete process.env.SOME_VAR;
    });
});
```

## Integration with CI/CD

### Automated Testing
All pull requests automatically run:
- **ESLint** code quality checks
- **Security audit** (npm audit) for vulnerabilities
- **Complete test suite** (unit + property tests)
- **Multi-Node.js version** compatibility testing

### Local Validation
Before submitting a PR, run the same checks locally:

```bash
# Run the complete validation suite (same as CI)
npm run validate

# Test generator functionality manually
npm link
yo @aws/ml-container-creator test-project --framework=sklearn --model-server=flask --model-format=pkl --skip-prompts

# Verify generated project works
cd test-project
docker build -t test-model .
```

## Test Philosophy

Our testing approach ensures reliability through multiple complementary strategies:

### 🎯 **Focused Unit Tests**
Each test module focuses on a specific capability, making it easy to understand what's being tested and debug failures.

### 🔬 **Property-Based Testing**
Using [fast-check](https://github.com/dubzzz/fast-check), we test universal correctness properties across thousands of parameter combinations, ensuring the system behaves correctly for all valid inputs.

### 🔒 **Security & Quality**
Automated security auditing and code quality checks ensure the generated containers and deployment scripts follow best practices.

### 📊 **Comprehensive Coverage**
- **87 unit tests** covering specific functionality
- **10 property tests** validating universal behavior
- **1000+ test iterations** across all parameter combinations
- **Multi-Node.js version testing** ensuring compatibility

### ⚡ **Fast Feedback**
Tests complete in ~6 seconds, providing rapid feedback during development while maintaining comprehensive coverage.

This testing infrastructure ensures comprehensive validation of ML Container Creator's functionality while providing a robust foundation for contributors to add new features with confidence.
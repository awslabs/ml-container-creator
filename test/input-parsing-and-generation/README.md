# Input Parsing and Generation Tests

This directory contains modular test files that focus on specific aspects of the ML Container Creator generator's input parsing and file generation capabilities.

## Test Structure

Each test file is self-contained and focuses on a specific testing capability:

### 📋 [cli-options.test.js](./cli-options.test.js)
Tests CLI option parsing and validation:
- Framework-specific CLI options (`--framework=sklearn`)
- Boolean options (`--include-testing=false`)
- String array options (`--test-types=cli,endpoint`)
- CLI validation and error handling
- Help and special commands

**Run with:** `npm run test:cli`

### 🌍 [environment-variables.test.js](./environment-variables.test.js)
Tests environment variable parsing:
- String variables (`ML_FRAMEWORK=sklearn`)
- Boolean variables (`ML_INCLUDE_TESTING=true`)
- Array variables (`ML_TEST_TYPES=cli,endpoint`)
- Invalid value handling
- Case sensitivity

**Run with:** `npm run test:env`

### 📁 [configuration-files.test.js](./configuration-files.test.js)
Tests configuration file parsing:
- Custom config files (`ml-container.config.json`)
- Package.json sections (`"ml-container-creator": {...}`)
- CLI config files (`--config=prod.json`)
- Malformed file handling

**Run with:** `npm run test:config`

### 🔄 [configuration-precedence.test.js](./configuration-precedence.test.js)
Tests configuration source precedence:
- CLI options vs environment variables
- Environment variables vs config files
- Config file precedence order
- Complex multi-source scenarios
- Partial configuration merging

**Run with:** `npm run test:precedence`

### 📄 [file-generation.test.js](./file-generation.test.js)
Tests correct file generation:
- Framework-specific files (sklearn vs transformers)
- Optional module inclusion (sample models, tests)
- Server-specific files (Flask vs FastAPI vs vLLM)
- File content validation
- Conditional file exclusion

**Run with:** `npm run test:generation`

## Shared Utilities

### 🛠️ [test-utils.js](./test-utils.js)
Provides shared utilities for all test files:
- Test constants (`FRAMEWORKS`, `REQUIRED_FILES`)
- Validation functions (`validateFiles`, `validateFileContent`)
- Helper functions (`createTempConfig`, `debugCurrentState`)
- Test setup hooks (`setupTestHooks`)

## Running Tests

### Run All Tests
```bash
npm test                    # All tests including security audit
npm run test:quick          # Fast execution with minimal output
npm run test:debug          # Full debug output with stack traces
```

### Run Specific Test Categories
```bash
npm run test:cli            # CLI options parsing tests
npm run test:env            # Environment variables tests
npm run test:config         # Configuration files tests
npm run test:precedence     # Configuration precedence tests
npm run test:generation     # File generation tests
```

### Run Tests with Grep Filters
```bash
npm test -- --grep "sklearn"           # All sklearn-related tests
npm test -- --grep "CLI Options"       # All CLI option tests
npm test -- --grep "precedence"        # All precedence tests
npm test -- --grep "validation"        # All validation tests
```

## Test Output Features

The modular tests provide excellent visibility into what's being tested:

### ✅ Test Numbering
Each test is numbered sequentially within its suite:
```
🧪 Test #1: should parse sklearn CLI options correctly
📍 Test Suite: CLI Options Parsing
```

### 📊 Detailed Validation
Shows exactly what files and content are being validated:
```
🔍 Checking 6 expected files for sklearn CLI parsing...
✅ Found: Dockerfile
✅ Found: requirements.txt
📊 Summary: All 6 expected files found
```

### 🔍 Debug Information
Provides context when tests fail:
```
🔍 DEBUG: Current state for test #5 failure:
📁 Working directory: /tmp/test-dir
📄 Files in current directory (3 total): [Dockerfile, requirements.txt, ...]
```

### 📈 Progress Tracking
Shows completion status for each test suite:
```
📊 CLI Options Parsing suite completed: 8 tests run
```

## Adding New Tests

### For Contributors

When adding new tests, choose the appropriate module based on what you're testing:

1. **CLI option parsing** → `cli-options.test.js`
2. **Environment variable handling** → `environment-variables.test.js`
3. **Config file parsing** → `configuration-files.test.js`
4. **Precedence behavior** → `configuration-precedence.test.js`
5. **File generation** → `file-generation.test.js`

### Test Structure Template

```javascript
import { 
    getGeneratorPath, 
    validateFiles, 
    setupTestHooks 
} from './test-utils.js';

describe('Your Test Category', () => {
    let helpers;

    before(async () => {
        console.log('\n🚀 Starting Your Test Category Tests');
        helpers = await import('yeoman-test');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('Your Test Category');

    it('should do something specific', async () => {
        console.log(`\n  🧪 Testing specific functionality...`);
        
        await helpers.default.run(getGeneratorPath())
            .withOptions({ /* your options */ });

        validateFiles(['expected-file.txt'], 'your test context');
        console.log(`    ✅ Functionality working correctly`);
    });
});
```

### Best Practices

1. **Use descriptive test names** that explain what's being tested
2. **Add console.log statements** to show test progress
3. **Use the shared utilities** from `test-utils.js`
4. **Include context** in validation functions
5. **Test both success and failure cases**
6. **Clean up environment variables** between tests (handled by `setupTestHooks`)

## Troubleshooting

### Common Issues

1. **Tests timing out**: Usually indicates the generator is waiting for user input. Ensure `--skip-prompts` is used.
2. **File not found errors**: Check that the expected files match what the generator actually creates.
3. **Content validation failures**: Use the debug output to see actual vs expected content.

### Debug Tips

1. **Run individual tests**: Use the specific npm scripts to isolate issues
2. **Check debug output**: Failed tests show working directory and file contents
3. **Use grep filters**: Target specific functionality with `--grep`
4. **Enable full traces**: Use `npm run test:debug` for complete stack traces

## Architecture Benefits

This modular approach provides several advantages:

### 🎯 **Focused Testing**
Each file tests a specific capability, making it easier to understand and maintain.

### 🔍 **Easy Debugging**
When a test fails, you know exactly which functionality is broken.

### 🚀 **Faster Development**
Contributors can run only the tests relevant to their changes.

### 📈 **Scalable Structure**
New test categories can be added without affecting existing tests.

### 🛠️ **Maintainable Code**
Shared utilities prevent code duplication and ensure consistency.
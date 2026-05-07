# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.


## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment


## Contributing via Pull Requests
Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.
4. **You have Node.js v24+** - Required for running tests. Use `nvm use node` to switch to the latest version.
5. **All tests pass** - Run `npm run validate` to ensure your changes don't break existing functionality.
6. **New functionality includes tests** - Add appropriate unit tests and property tests for new features.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. **Ensure you're using Node.js v24+** by running `nvm use node`.
4. **Ensure all tests pass** by running `npm run validate`.
5. **Add tests for new functionality** following our testing patterns.
6. Commit to your fork using clear commit messages.
7. Send us a pull request, answering any default questions in the pull request interface.
8. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

## Testing Requirements

### Prerequisites

**Node.js v24+ is required** for running the test suite. The tests use modern JavaScript features that are not available in older Node versions.

```bash
# Check your Node version
node --version

# If using nvm, switch to the latest version
nvm use node

# Verify you're on v24+
node --version  # Should show v24.x.x or higher
```

**Important**: Running tests with Node.js < v24 will cause errors like `Unexpected token 'with'`. Always run `nvm use node` before testing.

### Before Submitting a PR

All pull requests must pass our comprehensive test suite:

```bash
# ALWAYS run this first to ensure correct Node version
nvm use node

# Run the full validation suite (required before PR submission)
npm run validate

# This runs:
# 1. ESLint code quality checks
# 2. Security audit (npm audit)
# 3. Unit tests (238 tests)
# 4. Property-based tests (10 universal correctness properties)
```

### Test Organization

Our test suite is organized into two complementary layers:

#### 📋 **Unit Tests** (`test/` directory)
Focused tests for specific functionality organized by capability. See **[`test/README.md`](./test/README.md)** for detailed documentation.

- **CLI Options** (`cli-options.test.js`) - CLI option parsing and validation
- **Environment Variables** (`environment-variables.test.js`) - Environment variable handling  
- **Configuration Files** (`configuration-files.test.js`) - Config file parsing
- **Configuration Precedence** (`configuration-precedence.test.js`) - Multi-source precedence
- **File Generation** (`file-generation.test.js`) - Template processing and file creation
- **Error Handling** (`error-handling.test.js`) - Validation and error scenarios
- **Property-Based Tests** - 10 universal correctness properties with 1000+ test iterations

#### 🚀 **Integration Tests** (`scripts/` directory)
End-to-end project generation and validation scripts. See **[`scripts/README.md`](./scripts/README.md)** for detailed documentation.

- **`test-generate-projects.sh`** - Comprehensive project generation testing across all configurations
- **`test-generate-configs.sh`** - Configuration file generation for manual testing
- **`test-generation-parameters.sh`** - Flexible test runner with different verbosity levels

### Quick Reference: Which Tests to Add Where

| What You're Adding | Where to Add Tests | Documentation |
|-------------------|-------------------|---------------|
| **New CLI option** | `test/input-parsing-and-generation/cli-options.test.js` | [`test/README.md`](./test/README.md) |
| **New environment variable** | `test/input-parsing-and-generation/environment-variables.test.js` | [`test/README.md`](./test/README.md) |
| **New configuration option** | `test/input-parsing-and-generation/configuration-files.test.js` | [`test/README.md`](./test/README.md) |
| **New framework support** | Both unit tests + `scripts/test-generate-projects.sh` | Both README files |
| **New template/file generation** | `test/input-parsing-and-generation/file-generation.test.js` | [`test/README.md`](./test/README.md) |
| **New validation/error handling** | `test/input-parsing-and-generation/error-handling.test.js` | [`test/README.md`](./test/README.md) |
| **End-to-end scenarios** | `scripts/test-generate-projects.sh` | [`scripts/README.md`](./scripts/README.md) |
| **Universal correctness properties** | `test/input-parsing-and-generation/parameter-matrix-compliance.property.test.js` | [`test/README.md`](./test/README.md) |

### Writing Tests for New Features

When adding new functionality, include appropriate tests. **See [`test/README.md`](./test/README.md) and [`scripts/README.md`](./scripts/README.md) for comprehensive testing guidelines.**

#### 1. Choose the Right Test Location

**Unit Tests** (fast, focused testing):
- **CLI option changes** → `test/input-parsing-and-generation/cli-options.test.js`
- **Environment variable changes** → `test/input-parsing-and-generation/environment-variables.test.js`
- **Config file changes** → `test/input-parsing-and-generation/configuration-files.test.js`
- **Precedence changes** → `test/input-parsing-and-generation/configuration-precedence.test.js`
- **Template/file changes** → `test/input-parsing-and-generation/file-generation.test.js`

**Integration Tests** (end-to-end validation):
- **New framework support** → `scripts/test-generate-projects.sh`
- **New configuration scenarios** → `scripts/test-generate-projects.sh`
- **Configuration file generation** → `scripts/test-generate-configs.sh`

#### 2. Follow Our Test Patterns

**Unit Test Example:**
```javascript
import { 
    runGenerator,
    validateFiles, 
    setupTestHooks 
} from './test-utils.js';

describe('Your Feature Category', () => {
    setupTestHooks('Your Feature Category');

    it('should handle your specific functionality', async () => {
        console.log(`\n  🧪 Test #1: Testing your functionality...`);
        console.log(`  📍 Test Suite: Your Feature Category`);
        
        const result = await runGenerator({
            framework: 'sklearn',
            yourNewOption: 'test-value',
            skipPrompts: true
        });

        validateFiles(['expected-file.txt'], 'your feature test');
        console.log(`    ✅ Your functionality working correctly`);
    });
});
```

**Integration Test Example:**
```bash
# Add to scripts/test-generate-projects.sh
test_your_new_feature() {
    local test_name="$1"
    
    print_substep "Testing your new feature: $test_name"
    
    mkdir -p "your-feature-test"
    cd "your-feature-test"
    
    if ml-container-creator --your-new-option --skip-prompts > ../test.log 2>&1; then
        validate_files ["expected-file.txt"] "your feature test"
        cd ..
        record_test_result "Your Feature" "PASS"
    else
        cd ..
        record_test_result "Your Feature" "FAIL"
    fi
}
```

#### 3. Test Both Success and Failure Cases

Always include both positive and negative test cases:

```javascript
// Test successful case
it('should generate files for valid configuration', async () => {
    await runGenerator({
        framework: 'sklearn',
        modelFormat: 'pkl',
        skipPrompts: true
    });
    
    validateFiles(['Dockerfile', 'requirements.txt'], 'sklearn generation');
});

// Test error case
it('should show error for invalid configuration', async () => {
    try {
        await runGenerator({
            framework: 'invalid',
            skipPrompts: true
        });
        assert.fail('Should have thrown an error');
    } catch (error) {
        assert(error.message.includes('not implemented'));
    }
});
```

#### 4. Add Property Tests for Universal Behavior

If your feature affects parameter handling, consider adding property tests. See [`test/README.md`](./test/README.md) for detailed property testing guidelines.

### Running Tests During Development

```bash
# Run tests continuously during development
npm run test:watch              # Unit tests in watch mode
npm run test:property:watch     # Property tests in watch mode

# Run specific test categories
npm test -- --grep "CLI Options"     # Your specific functionality
npm test -- --grep "sklearn"         # Framework-specific tests

# Run integration tests
./scripts/test-generate-projects.sh --verbose --keep-output

# Quick validation before committing
npm run validate                # Full test suite + linting
```

### Test Quality Standards

- **Descriptive test names** that explain what's being tested
- **Console output** showing test progress and context
- **Proper cleanup** of environment variables and temporary files
- **Error handling** for both expected and unexpected failures
- **Performance considerations** for property tests (reasonable iteration counts)

### Debugging Failed Tests

Our tests provide excellent debugging information. See the respective README files for detailed debugging guidance:
- **Unit test debugging**: [`test/README.md`](./test/README.md#debugging-failed-tests)
- **Integration test debugging**: [`scripts/README.md`](./scripts/README.md#troubleshooting)

### CI/CD Integration

All pull requests automatically run:
- ESLint code quality checks
- Security audit (npm audit)
- Complete test suite (unit + property tests)
- Node.js compatibility testing

Tests must pass on all supported Node.js versions before merge.


## Finding contributions to work on
Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.


## Code of Conduct
This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.


## Security issue notifications
If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.


## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.

Thank you for your interest in contributing to the ml-container-creator project! This document provides guidelines and information about contributing to this project.

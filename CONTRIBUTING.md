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
4. **All tests pass** - Run `npm run validate` to ensure your changes don't break existing functionality.
5. **New functionality includes tests** - Add appropriate unit tests and property tests for new features.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. **Ensure all tests pass** by running `npm run validate`.
4. **Add tests for new functionality** following our testing patterns.
5. Commit to your fork using clear commit messages.
6. Send us a pull request, answering any default questions in the pull request interface.
7. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

## Testing Requirements

### Before Submitting a PR

All pull requests must pass our comprehensive test suite:

```bash
# Run the full validation suite (required before PR submission)
npm run validate

# This runs:
# 1. ESLint code quality checks
# 2. Security audit (npm audit)
# 3. Unit tests (87 tests)
# 4. Property-based tests (10 universal correctness properties)
```

### Test Organization

Our test suite is organized into focused modules for easy contribution:

#### 📋 Unit Tests (`test/input-parsing-and-generation/`)

- **CLI Options** (`cli-options.test.js`) - CLI option parsing and validation
- **Environment Variables** (`environment-variables.test.js`) - Environment variable handling  
- **Configuration Files** (`configuration-files.test.js`) - Config file parsing
- **Configuration Precedence** (`configuration-precedence.test.js`) - Multi-source precedence
- **File Generation** (`file-generation.test.js`) - Template processing and file creation
- **Error Handling** (`error-handling.test.js`) - Validation and error scenarios

#### 🔬 Property-Based Tests

- **Parameter Matrix Compliance** - 10 universal correctness properties
- **Comprehensive Coverage** - 1000+ test iterations across all parameter combinations
- **Automated Validation** - Tests all configuration sources and precedence rules

### Writing Tests for New Features

When adding new functionality, include appropriate tests:

#### 1. Choose the Right Test Module

- **CLI option changes** → `cli-options.test.js`
- **Environment variable changes** → `environment-variables.test.js`
- **Config file changes** → `configuration-files.test.js`
- **Precedence changes** → `configuration-precedence.test.js`
- **Template/file changes** → `file-generation.test.js`

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

### Test Quality Standards

- **Descriptive test names** that explain what's being tested
- **Console output** showing test progress and context
- **Proper cleanup** of environment variables and temporary files
- **Error handling** for both expected and unexpected failures
- **Performance considerations** for property tests (reasonable iteration counts)

### Debugging Failed Tests

Our tests provide excellent debugging information:

```bash
# Run with full debug output
npm test -- --grep "your failing test"

# Check the detailed output:
# 🔍 DEBUG: Current state for test failure:
# 📁 Working directory: /tmp/test-dir
# 📄 Files in current directory: [list of files]
# 📊 Expected vs actual file content
```

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

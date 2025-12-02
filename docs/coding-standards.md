# Coding Standards & Best Practices

## JavaScript/Node.js Standards

### Code Style
- **Indentation**: 4 spaces (as per existing code)
- **Quotes**: Single quotes for strings
- **Semicolons**: Not required (existing code doesn't use them)
- **Line length**: Keep reasonable, no hard limit
- **Naming conventions**:
  - camelCase for variables and functions
  - PascalCase for classes
  - UPPER_SNAKE_CASE for constants
  - Prefix private methods with underscore: `_validateAnswers()`

### Modern JavaScript
```javascript
// ✅ Good - Use const by default
const answers = await this.prompt([...]);

// ✅ Good - Use arrow functions
const choices = (answers) => {
    return answers.framework === 'sklearn' ? ['pkl', 'joblib'] : ['json'];
};

// ✅ Good - Use template literals
const message = `⚠️  ${framework} not implemented yet.`;

// ✅ Good - Use destructuring
const { framework, modelServer, deployTarget } = this.answers;

// ✅ Good - Use async/await
async prompting() {
    const answers = await this.prompt([...]);
}

// ❌ Avoid - var keyword
var x = 5;

// ❌ Avoid - string concatenation
const message = '⚠️  ' + framework + ' not implemented yet.';
```

### Yeoman Generator Patterns

#### Prompt Organization
Group related prompts into phases with clear console output:
```javascript
console.log('\n📋 Project Configuration');
const projectAnswers = await this.prompt([...]);

console.log('\n🔧 Core Configuration');
const coreAnswers = await this.prompt([...]);
```

#### Conditional Prompts
Use `when` function for conditional prompts:
```javascript
{
    type: 'list',
    name: 'modelFormat',
    message: 'Model format?',
    choices: (answers) => {
        if (answers.framework === 'sklearn') {
            return ['pkl', 'joblib'];
        }
        return ['json'];
    },
    when: answers => answers.framework !== 'transformers'
}
```

#### Answer Merging
Combine phase answers using spread operator:
```javascript
this.answers = {
    ...projectAnswers,
    ...coreAnswers,
    ...moduleAnswers,
    buildTimestamp
};
```

## Template Best Practices

### EJS Syntax
```ejs
<%# Comments - not rendered %>

<%= variable %>  <%# Escaped output %>
<%- variable %>  <%# Unescaped output %>

<% if (condition) { %>
    Content
<% } %>

<% if (framework === 'sklearn') { %>
    sklearn-specific content
<% } else if (framework === 'xgboost') { %>
    xgboost-specific content
<% } %>
```

### Shell Script Templates
```bash
#!/bin/bash

# Use template variables for configuration
PROJECT_NAME="<%= projectName %>"
REGION="<%= awsRegion %>"

# Include error handling
set -e

# Add helpful output
echo "Building <%= projectName %>..."
```

### Python Templates
```python
# Use proper imports
import os
import json
from typing import Optional, Dict, Any

# Use type hints
def load_model(model_path: str) -> Any:
    """Load model from path."""
    pass

# Use f-strings for formatting
print(f"Loading model from {model_path}")
```

## Error Handling

### Generator Errors
```javascript
// Use env.error for validation failures
if (!this.SUPPORTED_OPTIONS.frameworks.includes(framework)) {
    this.env.error(`⚠️  ${framework} not implemented yet.`);
}

// Provide helpful error messages
if (!modelPath) {
    this.env.error('Model path is required. Please provide a valid path.');
}
```

### Template Errors
```python
# In Python templates, use proper exception handling
try:
    model = load_model(model_path)
except FileNotFoundError:
    raise ValueError(f"Model not found at {model_path}")
except Exception as e:
    raise RuntimeError(f"Failed to load model: {str(e)}")
```

## Testing Standards

### Generator Tests
```javascript
const helpers = require('yeoman-test');
const assert = require('yeoman-assert');

describe('generator-ml-container-creator:app', () => {
    it('creates expected files', async () => {
        await helpers.run(path.join(__dirname, '../generators/app'))
            .withPrompts({
                projectName: 'test-project',
                framework: 'sklearn',
                modelFormat: 'pkl'
            });
        
        assert.file(['Dockerfile', 'requirements.txt']);
    });
});
```

### Test Organization
- One test file per generator
- Group related tests with `describe` blocks
- Use descriptive test names
- Test both success and failure cases

## Documentation Standards

### Code Comments
```javascript
// Use comments to explain WHY, not WHAT
// Phase 1: Project Configuration
// Collect basic project info before framework-specific questions

// Document complex logic
// Transformers don't need traditional model handlers
// because they use vLLM/SGLang's built-in serving
if (this.answers.framework === 'transformers') {
    ignorePatterns.push('**/code/model_handler.py');
}
```

### JSDoc for Public Methods
```javascript
/**
 * Validates user answers against supported options.
 * Throws error if unsupported configuration is detected.
 * @private
 */
_validateAnswers() {
    // implementation
}
```

### README Updates
- Keep README in sync with features
- Include examples for new configurations
- Update troubleshooting section for common issues
- Document breaking changes

## Git Commit Messages

Follow conventional commits format:
```
feat: add FastAPI support for sklearn models
fix: correct model path in transformer templates
docs: update README with new framework options
test: add tests for xgboost model formats
refactor: simplify prompt logic in core configuration
chore: update dependencies to latest versions
```

## Security Best Practices

### Dependency Management
- Run `npm audit` regularly
- Use `overrides` in package.json for security patches
- Keep Node.js and npm updated
- Review dependency changes in PRs

### Template Security
```javascript
// ❌ Don't include secrets in templates
const API_KEY = "hardcoded-key";

// ✅ Use environment variables
const API_KEY = process.env.API_KEY;

// ❌ Don't commit AWS credentials
AWS_ACCESS_KEY_ID=AKIA...

// ✅ Use IAM roles and AWS CLI profiles
```

### Input Validation
```javascript
// Validate user input
if (!projectName.match(/^[a-z0-9-]+$/)) {
    this.env.error('Project name must contain only lowercase letters, numbers, and hyphens');
}
```

## Performance Considerations

### Template Processing
- Keep templates simple and focused
- Avoid complex logic in templates
- Use generator logic for complex decisions
- Cache computed values in `this.answers`

### File Operations
```javascript
// ✅ Good - Single copyTpl call with ignore patterns
this.fs.copyTpl(
    this.templatePath('**/*'),
    this.destinationPath(),
    this.answers,
    {},
    { globOptions: { ignore: ignorePatterns } }
);

// ❌ Avoid - Multiple copyTpl calls
this.fs.copyTpl(this.templatePath('Dockerfile'), ...);
this.fs.copyTpl(this.templatePath('code/**'), ...);
```

## Maintenance Guidelines

### Adding New Features
1. Check if it fits existing patterns
2. Update SUPPORTED_OPTIONS constant
3. Add prompts in logical phase
4. Create/modify templates
5. Update validation
6. Add tests
7. Update documentation

### Deprecating Features
1. Add deprecation warning in prompts
2. Update documentation
3. Keep backward compatibility for one major version
4. Remove in next major version

### Code Review Checklist
- [ ] Follows existing code style
- [ ] Includes tests
- [ ] Updates documentation
- [ ] Passes ESLint
- [ ] Passes security audit
- [ ] Works with all supported configurations
- [ ] Includes helpful error messages

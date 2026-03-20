# Contributing Guide

Welcome! This guide will get you up and running with the ml-container-creator codebase in minutes.

## 🎯 Quick Setup

### Prerequisites
- Node.js 24.11.1+
- Git

### Get Started (5 minutes)

```bash
# 1. Clone and install
git clone https://github.com/awslabs/ml-container-creator
cd ml-container-creator
npm install
npm link

# 2. Run tests to verify setup
npm test

# 3. Try the generator
yo @aws/ml-container-creator
```

That's it! You're ready to contribute.

## 📁 Project Structure

Understanding the codebase structure:

```
ml-container-creator/
├── generators/app/           # Main generator code
│   ├── index.js             # Generator entry point (orchestration)
│   ├── lib/                 # Modular components
│   │   ├── prompts.js       # Prompt definitions
│   │   ├── prompt-runner.js # Prompt orchestration
│   │   └── template-manager.js # Template logic
│   └── templates/           # EJS templates for generated projects
│       ├── code/            # Model serving code
│       ├── do/              # do-framework scripts (build, push, deploy, etc.)
│       ├── deploy/          # Legacy wrapper scripts (deprecated)
│       ├── sample_model/    # Sample training code
│       └── test/            # Test templates
├── test/                    # Generator tests
│   ├── generator.test.js    # Integration tests
│   └── template-manager.test.js # Unit tests
└── docs/                    # Documentation
```

## 🔍 Understanding the Code

### How the Generator Works

The generator follows a simple flow:

```
1. Prompting Phase (prompt-runner.js)
   ↓
   Collects user configuration through interactive prompts
   - Single deployment configuration prompt (framework-server combination)
   - Derives framework and modelServer from selection
   
2. Validation Phase (template-manager.js)
   ↓
   Validates configuration is supported
   
3. Writing Phase (index.js)
   ↓
   Generates complete project structure
   - All template files are generated (no conditional exclusion)
   - do-framework scripts handle runtime branching
   - Centralized configuration in do/config
```

### Key Architecture Principles

**Simplified Generator**: The generator has been simplified by moving conditional logic from template generation to runtime script execution. This means:

- **No template exclusion patterns**: All template files are generated for every project
- **Runtime branching**: The `do/` scripts contain conditional logic based on `do/config` variables
- **Single deployment config prompt**: Framework and model server are selected together (e.g., `sklearn-flask`, `transformers-vllm`)
- **Centralized configuration**: All settings in `do/config` for easy customization

**do-framework Integration**: All generated projects follow the [do-framework](https://github.com/iankoulski/do-framework) conventions:

- Standardized scripts in `do/` directory: `build`, `push`, `deploy`, `run`, `test`, `clean`
- Configuration in `do/config` file
- Consistent interface across all projects
- Framework-specific logic handled at runtime, not generation time

### Key Files to Know

**`generators/app/index.js`** - Main generator class
- Orchestrates the generation process
- Delegates to specialized modules
- Sets executable permissions on do/ scripts
- ~50 lines (was 300+ before refactoring!)

**`generators/app/lib/prompts.js`** - Prompt definitions
- All user prompts organized by phase
- Single deployment configuration prompt (flattened framework + model server)
- Easy to add new prompts
- Clear separation of concerns

**`generators/app/lib/template-manager.js`** - Template logic
- Validates user configuration
- No longer handles template exclusion (simplified!)
- Centralizes validation logic

**`generators/app/lib/prompt-runner.js`** - Prompt orchestration
- Runs prompts in organized phases
- Derives framework and modelServer from deploymentConfig
- Provides user feedback
- Combines answers from all phases

**`generators/app/templates/do/`** - do-framework scripts
- Standardized container lifecycle scripts
- Contains runtime conditional logic
- Framework-specific branching handled here, not in generator

## 🛠️ Common Tasks

### Adding a New Deployment Configuration

The generator now uses a single flattened deployment configuration prompt instead of separate framework and model server prompts.

1. Add the new configuration to `generators/app/lib/prompts.js`:

```javascript
// In the deployment configuration choices
{
    name: 'My Framework with My Server',
    value: 'myframework-myserver',
    short: 'myframework-myserver'
}
```

2. Update `template-manager.js` validation:

```javascript
// In validate() method
const validConfigs = [
    'sklearn-flask', 'sklearn-fastapi',
    // ... existing configs
    'myframework-myserver'  // Add new config
];
```

3. Add framework-specific logic to `do/` script templates:

```bash
# In generators/app/templates/do/build
case "$DEPLOYMENT_CONFIG" in
    myframework-myserver)
        # Framework-specific build logic
        ;;
esac
```

4. Add test in `test/generator.test.js`:

```javascript
it('handles new deployment config correctly', async () => {
    await helpers.run(path.join(__dirname, '../generators/app'))
        .withPrompts({ 
            deploymentConfig: 'myframework-myserver',
            /* ... */ 
        });
    
    assert.file(['do/build', 'do/push', 'do/deploy']);
});
```

### Adding a New Prompt

1. Add prompt definition to `generators/app/lib/prompts.js`:

```javascript
// In the appropriate phase array
{
    type: 'list',
    name: 'myNewOption',
    message: 'Choose your option?',
    choices: ['option1', 'option2'],
    default: 'option1'
}
```

2. Add to `do/config` template if it's a configuration variable:

```bash
# In generators/app/templates/do/config
export MY_NEW_OPTION="<%= myNewOption %>"
```

3. Use in do/ scripts if needed:

```bash
# In generators/app/templates/do/build (or other scripts)
if [ "$MY_NEW_OPTION" = "option1" ]; then
    # Option-specific logic
fi
```

4. Add test in `test/generator.test.js`:

```javascript
it('handles new option correctly', async () => {
    await helpers.run(path.join(__dirname, '../generators/app'))
        .withPrompts({ myNewOption: 'option1', /* ... */ });
    
    assert.fileContent('do/config', 'MY_NEW_OPTION="option1"');
});
```

### Adding a New Template

1. Create template file in `generators/app/templates/`:

```bash
# Example: Add a new do-framework script
touch generators/app/templates/do/my-script
```

2. Use EJS syntax for variables:

```bash
#!/bin/bash
set -e

# Source configuration
source "$(dirname "$0")/config"

PROJECT_NAME="<%= projectName %>"
REGION="<%= awsRegion %>"

# Add your script logic here
```

3. Make it executable in generator's writing phase (if it's a script):

```javascript
// In generators/app/index.js writing() method
// Executable permissions are set automatically for do/* scripts
```

4. Add conditional logic based on configuration (if needed):

```bash
# In the script itself, not in the generator
case "$DEPLOYMENT_CONFIG" in
    sklearn-*)
        # sklearn-specific logic
        ;;
    transformers-*)
        # transformers-specific logic
        ;;
esac
```

**Important**: The generator now generates all template files unconditionally. Conditional logic should be in the runtime scripts (do/ directory), not in the generator's template exclusion logic.

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npx mocha test/generator.test.js

# Run with verbose output
npx mocha test/generator.test.js --reporter spec
```

### Testing Your Changes Locally

```bash
# 1. Make your changes

# 2. Re-link the generator
npm link

# 3. Test in a temporary directory
cd /tmp
yo @aws/ml-container-creator

# 4. Verify generated project structure
cd your-generated-project
ls -la do/  # Check do-framework scripts are present
cat do/config  # Verify configuration

# 5. Test the do-framework scripts
./do/build  # Should build successfully
docker images | grep your-project  # Verify image was created

# 6. Test local deployment
./do/run &
./do/test  # Should pass health and inference tests
```

## 🐛 Debugging Tips

### Enable Debug Output

```bash
# See detailed Yeoman output
DEBUG=yeoman:* yo @aws/ml-container-creator

# See generator-specific output
DEBUG=@aws/generator-ml-container-creator:* yo @aws/ml-container-creator
```

### Common Issues

**"Generator not found"**
```bash
# Re-link the generator
cd ml-container-creator
npm link
```

**"Tests failing after changes"**
```bash
# Clear npm cache
npm cache clean --force
npm install
```

**"do/ scripts not executable"**
- Check that `writing()` phase sets permissions: `chmod +x`
- Verify with: `ls -la do/` in generated project

**"Configuration variable not set in do/config"**
- Check EJS template syntax in `generators/app/templates/do/config`
- Verify variable is in `this.answers` object
- Test with: `cat do/config` in generated project

## 📝 Code Style

We follow these conventions:

```javascript
// ✅ Good
const answers = await this.prompt([...]);
const { framework, modelServer } = this.answers;

// ❌ Avoid
var x = 5;
let y = this.answers.framework;
```

Key points:
- Use `const` by default, `let` when needed, never `var`
- Use arrow functions for callbacks
- Use template literals for strings
- Add JSDoc comments for public methods
- Keep functions small and focused

## 🎯 do-framework Conventions

All generated projects follow [do-framework](https://github.com/iankoulski/do-framework) conventions:

### Script Structure

```bash
#!/bin/bash
set -e  # Exit on error
set -u  # Exit on undefined variable
set -o pipefail  # Exit on pipe failure

# Source configuration
source "$(dirname "$0")/config"

# Validate prerequisites
check_docker_installed

# Main logic with conditional branching
case "$DEPLOYMENT_CONFIG" in
    sklearn-*)
        # sklearn-specific logic
        ;;
    transformers-*)
        # transformers-specific logic
        ;;
esac

# Success output
echo "✅ Operation completed successfully"
```

### Configuration Management

- All configuration in `do/config` file
- Use environment variable overrides
- Document all variables with comments
- Support both direct values and env var references

### Output Formatting

Use consistent emoji prefixes:
- 🚀 - Starting an operation
- ✅ - Success
- ❌ - Error
- ⚠️ - Warning
- 🔍 - Checking/validating
- 📦 - Deployment/packaging

### Error Handling

```bash
# Check prerequisites
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed"
    echo "   Install from: https://docs.docker.com/get-docker/"
    exit 2
fi

# Validate configuration
if [ -z "$PROJECT_NAME" ]; then
    echo "❌ PROJECT_NAME not set in do/config"
    exit 3
fi
```

## 🧪 Testing Guidelines

### What to Test

- ✅ File generation for different configurations
- ✅ Template exclusion logic
- ✅ Validation of user inputs
- ✅ Edge cases and error conditions

### Test Structure

```javascript
describe('feature name', () => {
    beforeEach(async () => {
        // Setup test environment
        await helpers.run(path.join(__dirname, '../generators/app'))
            .withPrompts({ /* test configuration */ });
    });

    it('should do something specific', () => {
        // Assert expected behavior
        assert.file(['expected-file.txt']);
    });
});
```

## 🚀 Making Your First Contribution

### Good First Issues

Look for issues labeled:
- `good first issue` - Perfect for newcomers
- `help wanted` - Community contributions welcome
- `documentation` - Improve docs

### Contribution Workflow

1. **Find an issue** or create one describing your change
2. **Fork the repository** and create a branch
3. **Make your changes** following code style
4. **Add tests** for your changes
5. **Run tests** to ensure everything works
6. **Submit a PR** with clear description

### PR Checklist

Before submitting:
- [ ] Tests pass (`npm test`)
- [ ] Code follows style guidelines
- [ ] Documentation updated if needed
- [ ] Commit messages are clear
- [ ] PR description explains the change

## 📚 Additional Resources

- [Adding Features Guide](ADDING_FEATURES.md) - Detailed guide for new features
- [Coding Standards](coding-standards.md) - Complete style guide
- [Template System](template-system.md) - How templates work
- [Architecture](architecture.md) - Complete architecture guide with visual overview

## 💬 Getting Help

Stuck? We're here to help:

1. Check existing [documentation](index.md)
2. Search [issues](https://github.com/awslabs/ml-container-creator/issues)
3. Ask in [discussions](https://github.com/awslabs/ml-container-creator/discussions)
4. Tag maintainers in your PR

## 🎉 You're Ready!

You now know enough to start contributing. Don't worry about making mistakes - that's how we all learn. The maintainers are friendly and will help guide you through your first contribution.

Happy coding! 🚀
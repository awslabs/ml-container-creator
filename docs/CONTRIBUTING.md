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
yo ml-container-creator
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
│       ├── deploy/          # Deployment scripts
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
   
2. Validation Phase (template-manager.js)
   ↓
   Validates configuration is supported
   
3. Writing Phase (index.js)
   ↓
   Copies and processes templates based on configuration
```

### Key Files to Know

**`generators/app/index.js`** - Main generator class
- Orchestrates the generation process
- Delegates to specialized modules
- ~50 lines (was 300+ before refactoring!)

**`generators/app/lib/prompts.js`** - Prompt definitions
- All user prompts organized by phase
- Easy to add new prompts
- Clear separation of concerns

**`generators/app/lib/template-manager.js`** - Template logic
- Determines which templates to include/exclude
- Validates user configuration
- Centralizes conditional logic

**`generators/app/lib/prompt-runner.js`** - Prompt orchestration
- Runs prompts in organized phases
- Provides user feedback
- Combines answers from all phases

## 🛠️ Common Tasks

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

2. Update `template-manager.js` if it affects template selection:

```javascript
// In getIgnorePatterns() or validate()
if (this.answers.myNewOption === 'option1') {
    patterns.push('**/some-template/**');
}
```

3. Add test in `test/generator.test.js`:

```javascript
it('handles new option correctly', async () => {
    await helpers.run(path.join(__dirname, '../generators/app'))
        .withPrompts({ myNewOption: 'option1', /* ... */ });
    
    assert.file(['expected-file.txt']);
});
```

### Adding a New Template

1. Create template file in `generators/app/templates/`:

```bash
# Example: Add a new deployment script
touch generators/app/templates/deploy/my-script.sh
```

2. Use EJS syntax for variables:

```bash
#!/bin/bash
PROJECT_NAME="<%= projectName %>"
REGION="<%= awsRegion %>"
```

3. Add exclusion logic if conditional (in `template-manager.js`):

```javascript
if (this.answers.framework !== 'sklearn') {
    patterns.push('**/deploy/my-script.sh');
}
```

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
yo ml-container-creator

# 4. Verify generated project
cd your-generated-project
docker build -t test .
```

## 🐛 Debugging Tips

### Enable Debug Output

```bash
# See detailed Yeoman output
DEBUG=yeoman:* yo ml-container-creator

# See generator-specific output
DEBUG=generator-ml-container-creator:* yo ml-container-creator
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

**"Template not being copied"**
- Check `template-manager.js` for exclusion patterns
- Verify template path is correct
- Check EJS syntax is valid

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
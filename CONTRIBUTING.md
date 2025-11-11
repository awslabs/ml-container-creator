# Contributing Guidelines

<<<<<<< HEAD
<<<<<<< HEAD
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

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Ensure local tests pass.
4. Commit to your fork using clear commit messages.
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).


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
=======
Thank you for your interest in contributing to the SageMaker BYOC Generator! This document provides guidelines and information about contributing to this project.
=======
Thank you for your interest in contributing to the ml-container-creator project! This document provides guidelines and information about contributing to this project.
>>>>>>> cf470d5 (Incorporated updates consistent with PCSR feedback and open-source release process)

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)
- [Security](#security)

## Code of Conduct

This project adheres to the Amazon Open Source Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to aws-opensource@amazon.com.

## Getting Started

### Prerequisites

- Node.js 16+ and npm
- Python 3.8+
- Docker 20+
- AWS CLI 2+
- Git

### Development Environment

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/your-username/ml-container-creator.git
   cd ml-container-creator
   ```

2. **Install dependencies**
   ```bash
   npm install
   npm link
   ```

3. **Verify installation**
   ```bash
   yo ml-container-creator --help
   ```

## How to Contribute

### Types of Contributions

We welcome the following types of contributions:

- **Bug fixes**: Corrections to existing functionality
- **Feature enhancements**: New capabilities or improvements
- **Documentation**: Updates to README, guides, or code comments
- **Testing**: Additional test cases or testing infrastructure
- **Examples**: Sample projects or use cases

### Before You Start

1. **Check existing issues** to see if your contribution is already being worked on
2. **Open an issue** to discuss significant changes before implementing
3. **Review the roadmap** to understand project direction

## Development Setup

### Project Structure

```
generators/
├── app/
│   ├── index.js              # Main generator logic
│   └── templates/            # Template files
│       ├── code/            # Application code templates
│       ├── sample_model/    # Sample model and training
│       ├── test/            # Testing templates
│       └── deploy/          # Deployment templates
├── package.json             # Generator metadata
└── README.md               # Documentation
```

### Key Files

- **`generators/app/index.js`**: Main generator implementation
- **`generators/app/templates/`**: All template files with EJS templating

### Template Development

Templates use EJS syntax for dynamic content:

```javascript
// In generator
this.answers = { framework: 'sklearn', modelServer: 'flask' };

// In template
<% if (framework === 'sklearn') { %>
import sklearn
<% } %>
```

## Testing

### Local Testing

```bash
# Test generator functionality
yo ml-container-creator

# Test generated project
cd generated-project
python test/test_model_handler.py --input-data '[[1,2,3,4]]'
./test/test_local_image.sh
```

### Automated Testing

🚧 __Under Construction__ 🚧

### Test Requirements

🚧 __Under Construction__ 🚧

### Testing Checklist

🚧 __Under Construction__ 🚧

## Submitting Changes

### Pull Request Process

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Follow existing code style
   - Add tests for new functionality
   - Update documentation

3. **Commit with clear messages**
   ```bash
   git commit -m "feat: add support for PyTorch models
   
   - Add PyTorch model handler template
   - Update requirements.txt templating
   - Add PyTorch to testing matrix"
   ```

4. **Push and create PR**
   ```bash
   git push origin feature/your-feature-name
   ```

### Commit Message Format

Use conventional commits format:

```
type(scope): description

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Adding or updating tests
- `refactor`: Code refactoring
- `chore`: Maintenance tasks

### PR Requirements

- [ ] Clear description of changes
- [ ] Tests pass locally
- [ ] Documentation updated
- [ ] No merge conflicts
- [ ] Follows project coding standards

## Reporting Issues

### Bug Reports

Include the following information:

- **Environment**: OS, Node.js version, Python version
- **Generator version**: `npm list generator-sagemaker-generate-byoc`
- **Configuration**: Framework, model server, format used
- **Steps to reproduce**: Exact commands run
- **Expected vs actual behavior**
- **Error messages**: Full stack traces
- **Generated files**: Relevant template outputs

### Bug Report Template
```markdown
---
name: Bug report
about: Create a report to help us improve
title: '[BUG] '
labels: 'bug'
---

## Bug Description
A clear and concise description of what the bug is.

## Environment
- OS: [e.g. macOS 13.0, Ubuntu 20.04]
- Node.js version: [e.g. 18.17.0]
- Python version: [e.g. 3.9.7]
- Generator version: [e.g. 1.0.0]

## Configuration Used
- Framework: [e.g. sklearn, xgboost, tensorflow]
- Model format: [e.g. pkl, json, keras]
- Model server: [e.g. flask, fastapi]
- Instance type: [e.g. cpu-optimized, gpu-enabled]

## Steps to Reproduce
1. Run `yo sagemaker-generate-byoc`
2. Select options: [list your selections]
3. Execute command: [e.g. `./build_and_push.sh`]
4. See error

## Expected vs Actual Behavior
**Expected:** [What should happen]
**Actual:** [What actually happened]

## Error Messages
```
Paste full error messages here
```

## Additional Context
Add any other context about the problem here.
```


### Feature Requests

- **Use case**: Why is this feature needed?
- **Proposed solution**: How should it work?
- **Alternatives considered**: Other approaches evaluated
- **Implementation notes**: Technical considerations

### Feature Request Template
```markdown
---
name: Feature request
about: Suggest an idea for this project
title: '[FEATURE] '
labels: 'enhancement'
---

## Feature Description
A clear and concise description of what you want to happen.

## Problem Statement
What problem does this feature solve? What use case does it address?

## Proposed Solution
Describe the solution you'd like to see implemented.

## Alternatives Considered
Describe any alternative solutions or features you've considered.

## Implementation Notes
Any technical considerations or constraints to be aware of.

## Additional Context
Add any other context or screenshots about the feature request here.
```

### Issue Templates

Use the provided issue templates for:
- Bug reports
- Feature requests
- Documentation improvements
- Questions

### Pull Request Template
```markdown
---
name: Pull request
about: Contribute changes to the project
title: ''
labels: ''
---

## Description
Brief description of what this PR does.

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Changes Made
- [ ] List specific changes made
- [ ] Include any new files added
- [ ] Note any files modified

## Testing
- [ ] I have tested this change locally
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes

## Configuration Tested
- Framework: [e.g. sklearn, xgboost, tensorflow]
- Model server: [e.g. flask, fastapi]
- Test types: [e.g. local-model-cli, hosted-model-endpoint]

## Checklist
- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings

## Screenshots (if applicable)
Add screenshots to help explain your changes.

## Additional Notes
Any additional information that reviewers should know.
```

## Security

### Security Best Practices

- Never commit AWS credentials or secrets
- Use IAM roles instead of access keys
- Follow least privilege principle
- Keep dependencies updated
- Validate all user inputs

## Development Guidelines

### Code Style

- **JavaScript**: Follow existing patterns in `index.js`
- **Python**: PEP 8 compliance in templates
- **Shell**: Use bash with `set -e` for error handling
- **Documentation**: Clear, concise, and up-to-date

### Template Guidelines

- Use meaningful variable names
- Include comments for complex logic
- Maintain consistent indentation
- Test all conditional branches

### Documentation Standards

- Update README for user-facing changes
- Include inline code comments
- Provide examples for new features

## Community

### Getting Help

- **GitHub Discussions**: General questions and ideas
- **GitHub Issues**: Bug reports and feature requests
- **AWS Forums**: SageMaker-specific questions

### Recognition

Contributors will be recognized in:
- CONTRIBUTORS.md file
- Release notes for significant contributions
- AWS blog posts (with permission)

## License

By contributing to this project, you agree that your contributions will be licensed under the Apache 2.0 License. See [LICENSE](LICENSE) for details.

---

<<<<<<< HEAD
Thank you for contributing to the SageMaker BYOC Generator! Your contributions help make machine learning deployment more accessible to the AWS community.
>>>>>>> ccebf89 (Added the foundational elements for sharing this broadly and for automating generated component testing)
=======
Thank you for contributing to the ml-container-creator project! Your contributions help make machine learning deployment more accessible to the AWS community.
>>>>>>> cf470d5 (Incorporated updates consistent with PCSR feedback and open-source release process)

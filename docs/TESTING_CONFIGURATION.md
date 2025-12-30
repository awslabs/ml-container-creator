# Testing Guide

!!! note "Updated Testing Documentation"
    This guide has been superseded by the comprehensive [Testing Guide](testing.md) which covers our complete testing philosophy, architecture, and practices.

For the most up-to-date testing information, please see:

- **[Testing Guide](testing.md)** - Complete testing philosophy, architecture, and practices
- **[Configuration Guide](configuration.md)** - Comprehensive configuration system documentation
- **[Contributing Guide](CONTRIBUTING.md)** - How to write tests for new features

## Quick Reference

### Running Tests

```bash
# Complete validation (recommended)
npm run validate

# Unit tests only
npm test

# Property-based tests only
npm run test:property

# Watch mode for development
npm run test:watch
```

### Test Organization

Our test suite includes:

- **87 unit tests** organized by capability (CLI options, environment variables, configuration files, etc.)
- **10 property-based tests** validating universal correctness properties
- **1000+ test iterations** across all parameter combinations
- **Multi-Node.js version testing** for compatibility

### For Contributors

When adding new features:

1. **Choose the right test module** based on functionality
2. **Follow existing patterns** for consistency
3. **Test both success and failure cases**
4. **Add property tests** for universal behavior
5. **Run `npm run validate`** before submitting PR

See the [Testing Guide](testing.md) for detailed information on our testing approach, architecture, and how to contribute tests for new features.
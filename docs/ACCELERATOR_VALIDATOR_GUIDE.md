# Accelerator Validator Guide

This guide explains how to create custom accelerator validators for new hardware types in ML Container Creator.

## Overview

The accelerator validator system uses a plugin architecture that allows adding support for new accelerator types (TPU, Intel Gaudi, etc.) without modifying core validation logic.

## Table of Contents

- [Architecture](#architecture)
- [AcceleratorValidator Interface](#acceleratorvalidator-interface)
- [Creating a Custom Validator](#creating-a-custom-validator)
- [Registering Your Validator](#registering-your-validator)
- [Testing Your Validator](#testing-your-validator)
- [Examples](#examples)

## Architecture

### Plugin System

The validation engine uses a plugin architecture:

```
ValidationEngine
    ├── acceleratorValidators (map)
    │   ├── cuda: CudaValidator
    │   ├── neuron: NeuronValidator
    │   ├── cpu: CpuValidator
    │   ├── rocm: RocmValidator
    │   └── [your-type]: YourValidator
    └── registerAcceleratorValidator(type, validator)
```

### Validation Flow

```
User selects instance type
    ↓
Framework requires accelerator type
    ↓
ValidationEngine.validateAcceleratorCompatibility()
    ↓
Check accelerator type match
    ↓
Delegate to accelerator-specific validator
    ↓
Validator checks version compatibility
    ↓
Return validation result
```

## AcceleratorValidator Interface

All accelerator validators must implement the `AcceleratorValidator` interface:

```javascript
class AcceleratorValidator {
  /**
   * Validate framework config against instance config
   * @param {Object} frameworkConfig - Framework accelerator requirements
   * @param {Object} instanceConfig - Instance accelerator capabilities
   * @returns {ValidationResult}
   */
  validate(frameworkConfig, instanceConfig) {
    throw new Error('AcceleratorValidator.validate() must be implemented');
  }
  
  /**
   * Get user-friendly error message for version mismatch
   * @param {string} required - Required version
   * @param {string|Array} provided - Provided version(s)
   * @returns {string}
   */
  getVersionMismatchMessage(required, provided) {
    throw new Error('AcceleratorValidator.getVersionMismatchMessage() must be implemented');
  }
}
```

### ValidationResult Object

```javascript
{
  compatible: boolean,        // Whether configuration is compatible
  error: string | undefined,  // Fatal error message (stops generation)
  warning: string | undefined, // Warning message (allows proceeding)
  info: string | undefined    // Informational message
}
```

## Creating a Custom Validator

### Step 1: Extend AcceleratorValidator

Create a new file in `generators/app/lib/`:

```javascript
// generators/app/lib/tpu-validator.js
const AcceleratorValidator = require('./accelerator-validator');

class TpuValidator extends AcceleratorValidator {
  /**
   * Validate TPU configuration
   */
  validate(frameworkConfig, instanceConfig) {
    const required = frameworkConfig.accelerator;
    const provided = instanceConfig.accelerator;
    
    // Implement your validation logic here
    // Return ValidationResult object
  }
  
  /**
   * Get user-friendly error message
   */
  getVersionMismatchMessage(required, provided) {
    // Return helpful error message
  }
}

module.exports = TpuValidator;
```

### Step 2: Implement Validation Logic

Implement the `validate()` method with your accelerator-specific logic:

```javascript
validate(frameworkConfig, instanceConfig) {
  const required = frameworkConfig.accelerator;
  const provided = instanceConfig.accelerator;
  
  // 1. Parse versions according to your accelerator's versioning scheme
  const requiredVersion = this.parseVersion(required.version);
  const providedVersions = provided.versions.map(v => this.parseVersion(v));
  
  // 2. Check compatibility
  const compatibleVersions = providedVersions.filter(v => 
    this.isCompatible(requiredVersion, v)
  );
  
  // 3. Return result
  if (compatibleVersions.length === 0) {
    return {
      compatible: false,
      error: this.getVersionMismatchMessage(required.version, provided.versions)
    };
  }
  
  return {
    compatible: true,
    info: `Using ${provided.hardware} ${compatibleVersions[0].original} ` +
          `(compatible with required ${required.version})`
  };
}
```

### Step 3: Implement Version Parsing

Implement version parsing appropriate for your accelerator:

```javascript
/**
 * Parse version string into comparable object
 */
parseVersion(versionString) {
  // Example for semantic versioning (e.g., "2.15.0")
  const [major, minor, patch] = versionString.split('.').map(Number);
  return { major, minor, patch, original: versionString };
}

/**
 * Check if provided version is compatible with required version
 */
isCompatible(required, provided) {
  // Example: major must match, minor must be >= required
  return provided.major === required.major && 
         provided.minor >= required.minor;
}
```

### Step 4: Implement Error Messages

Provide clear, actionable error messages:

```javascript
getVersionMismatchMessage(required, provided) {
  return `Framework requires TPU ${required}, but instance only supports ${provided.join(', ')}. ` +
         `Consider using newer TPU instance types or updating your framework version.`;
}
```

## Registering Your Validator

### Option 1: Register in ValidationEngine Constructor

Add your validator to the default validators:

```javascript
// generators/app/lib/validation-engine.js
const TpuValidator = require('./tpu-validator');

class ValidationEngine {
  constructor(options = {}) {
    this.acceleratorValidators = {
      cuda: new CudaValidator(),
      neuron: new NeuronValidator(),
      cpu: new CpuValidator(),
      rocm: new RocmValidator(),
      tpu: new TpuValidator()  // Add your validator
    };
  }
}
```

### Option 2: Register Dynamically

Register your validator at runtime:

```javascript
const validationEngine = new ValidationEngine();
const tpuValidator = new TpuValidator();

validationEngine.registerAcceleratorValidator('tpu', tpuValidator);
```

## Testing Your Validator

### Unit Tests

Create unit tests for your validator:

```javascript
// test/input-parsing-and-generation/tpu-validator.test.js
const assert = require('assert');
const TpuValidator = require('../../generators/app/lib/tpu-validator');

describe('TpuValidator', () => {
  let validator;
  
  beforeEach(() => {
    validator = new TpuValidator();
  });
  
  it('should validate compatible TPU versions', () => {
    const frameworkConfig = {
      accelerator: {
        type: 'tpu',
        version: 'v4'
      }
    };
    
    const instanceConfig = {
      accelerator: {
        type: 'tpu',
        hardware: 'Google TPU',
        versions: ['v4', 'v5']
      }
    };
    
    const result = validator.validate(frameworkConfig, instanceConfig);
    
    assert.strictEqual(result.compatible, true);
    assert.ok(result.info);
  });
  
  it('should reject incompatible TPU versions', () => {
    const frameworkConfig = {
      accelerator: {
        type: 'tpu',
        version: 'v5'
      }
    };
    
    const instanceConfig = {
      accelerator: {
        type: 'tpu',
        hardware: 'Google TPU',
        versions: ['v3', 'v4']
      }
    };
    
    const result = validator.validate(frameworkConfig, instanceConfig);
    
    assert.strictEqual(result.compatible, false);
    assert.ok(result.error);
  });
  
  it('should provide helpful error messages', () => {
    const message = validator.getVersionMismatchMessage('v5', ['v3', 'v4']);
    
    assert.ok(message.includes('v5'));
    assert.ok(message.includes('v3, v4'));
  });
});
```

### Property-Based Tests

Add property-based tests for universal behavior:

```javascript
// test/input-parsing-and-generation/tpu-validator.property.test.js
const fc = require('fast-check');
const TpuValidator = require('../../generators/app/lib/tpu-validator');

describe('TpuValidator Property Tests', () => {
  it('should always return a validation result', () => {
    fc.assert(
      fc.property(
        fc.record({
          requiredVersion: fc.constantFrom('v3', 'v4', 'v5'),
          providedVersions: fc.array(fc.constantFrom('v3', 'v4', 'v5'), { minLength: 1 })
        }),
        (data) => {
          const validator = new TpuValidator();
          
          const result = validator.validate(
            { accelerator: { type: 'tpu', version: data.requiredVersion } },
            { accelerator: { type: 'tpu', versions: data.providedVersions } }
          );
          
          // Must return a result
          assert.ok(result);
          assert.ok(typeof result.compatible === 'boolean');
          
          // If incompatible, must have error
          if (!result.compatible) {
            assert.ok(result.error);
          }
          
          // If compatible, must have info
          if (result.compatible) {
            assert.ok(result.info);
          }
        }
      )
    );
  });
});
```

### Integration Tests

Test your validator in the full validation flow:

```javascript
// test/input-parsing-and-generation/tpu-integration.test.js
const helpers = require('yeoman-test');
const assert = require('yeoman-assert');
const path = require('path');

describe('TPU Integration', () => {
  it('should validate TPU instance types', async () => {
    await helpers.run(path.join(__dirname, '../../generators/app'))
      .withPrompts({
        framework: 'jax-serving',
        version: '0.4.0',
        instanceType: 'ml.tpu.v4-8'
      });
    
    // Should generate successfully
    assert.file(['Dockerfile', 'requirements.txt']);
    
    // Should include TPU configuration
    assert.fileContent('Dockerfile', /TPU/);
  });
  
  it('should reject incompatible TPU versions', async () => {
    try {
      await helpers.run(path.join(__dirname, '../../generators/app'))
        .withPrompts({
          framework: 'jax-serving',  // Requires TPU v5
          version: '0.5.0',
          instanceType: 'ml.tpu.v4-8'  // Only supports v4
        });
      
      assert.fail('Should have thrown error');
    } catch (error) {
      assert.ok(error.message.includes('TPU'));
      assert.ok(error.message.includes('v5'));
    }
  });
});
```

## Examples

### Example 1: TPU Validator (Generation-Based Versioning)

```javascript
// generators/app/lib/tpu-validator.js
const AcceleratorValidator = require('./accelerator-validator');

class TpuValidator extends AcceleratorValidator {
  validate(frameworkConfig, instanceConfig) {
    const required = frameworkConfig.accelerator;
    const provided = instanceConfig.accelerator;
    
    // TPU uses generation-based versioning (v2, v3, v4, v5)
    const requiredGen = parseInt(required.version.replace('v', ''));
    
    // Check if any provided version meets requirement
    const compatibleVersions = provided.versions.filter(v => {
      const providedGen = parseInt(v.replace('v', ''));
      return providedGen >= requiredGen;
    });
    
    if (compatibleVersions.length === 0) {
      return {
        compatible: false,
        error: this.getVersionMismatchMessage(required.version, provided.versions)
      };
    }
    
    return {
      compatible: true,
      info: `Using TPU ${compatibleVersions[0]} (compatible with required ${required.version})`
    };
  }
  
  getVersionMismatchMessage(required, provided) {
    return `Framework requires TPU ${required}, but instance only supports ${provided.join(', ')}. ` +
           `Consider using ml.tpu.${required}-8 or newer instance types.`;
  }
}

module.exports = TpuValidator;
```

### Example 2: Intel Gaudi Validator (Semantic Versioning)

```javascript
// generators/app/lib/gaudi-validator.js
const AcceleratorValidator = require('./accelerator-validator');

class GaudiValidator extends AcceleratorValidator {
  validate(frameworkConfig, instanceConfig) {
    const required = frameworkConfig.accelerator;
    const provided = instanceConfig.accelerator;
    
    // Intel Gaudi uses semantic versioning
    const requiredVersion = this.parseVersion(required.version);
    
    const compatibleVersions = provided.versions.filter(v => {
      const providedVersion = this.parseVersion(v);
      return this.isCompatible(requiredVersion, providedVersion);
    });
    
    if (compatibleVersions.length === 0) {
      return {
        compatible: false,
        error: this.getVersionMismatchMessage(required.version, provided.versions)
      };
    }
    
    return {
      compatible: true,
      info: `Using Intel Gaudi ${compatibleVersions[0]} ` +
            `(compatible with required ${required.version})`
    };
  }
  
  parseVersion(versionString) {
    const [major, minor, patch] = versionString.split('.').map(Number);
    return { major, minor, patch, original: versionString };
  }
  
  isCompatible(required, provided) {
    // Gaudi: major must match, minor must be >= required
    return provided.major === required.major && 
           provided.minor >= required.minor;
  }
  
  getVersionMismatchMessage(required, provided) {
    return `Framework requires Intel Gaudi ${required}, but instance only supports ${provided.join(', ')}. ` +
           `Consider using newer Gaudi instance types or updating your framework version.`;
  }
}

module.exports = GaudiValidator;
```

### Example 3: Custom Validator with Range Support

```javascript
// generators/app/lib/custom-validator.js
const AcceleratorValidator = require('./accelerator-validator');

class CustomValidator extends AcceleratorValidator {
  validate(frameworkConfig, instanceConfig) {
    const required = frameworkConfig.accelerator;
    const provided = instanceConfig.accelerator;
    
    // Support version ranges
    if (required.versionRange) {
      const minVersion = this.parseVersion(required.versionRange.min);
      const maxVersion = this.parseVersion(required.versionRange.max);
      
      const compatibleVersions = provided.versions.filter(v => {
        const providedVersion = this.parseVersion(v);
        return this.isInRange(providedVersion, minVersion, maxVersion);
      });
      
      if (compatibleVersions.length === 0) {
        return {
          compatible: false,
          error: `Framework requires version between ${required.versionRange.min} and ${required.versionRange.max}, ` +
                 `but instance only supports ${provided.versions.join(', ')}`
        };
      }
      
      return {
        compatible: true,
        info: `Using version ${compatibleVersions[0]} (within required range)`
      };
    }
    
    // Exact version match
    if (provided.versions.includes(required.version)) {
      return {
        compatible: true,
        info: `Using exact version ${required.version}`
      };
    }
    
    return {
      compatible: false,
      error: this.getVersionMismatchMessage(required.version, provided.versions)
    };
  }
  
  parseVersion(versionString) {
    const [major, minor, patch] = versionString.split('.').map(Number);
    return { major, minor, patch };
  }
  
  isInRange(version, min, max) {
    if (version.major < min.major || version.major > max.major) return false;
    if (version.major === min.major && version.minor < min.minor) return false;
    if (version.major === max.major && version.minor > max.minor) return false;
    return true;
  }
  
  getVersionMismatchMessage(required, provided) {
    return `Framework requires version ${required}, but instance only supports ${provided.join(', ')}`;
  }
}

module.exports = CustomValidator;
```

## Best Practices

### 1. Clear Error Messages
Provide actionable error messages that tell users:
- What the problem is
- Why it's a problem
- How to fix it (recommended instance types or framework versions)

### 2. Version Parsing
Implement robust version parsing that handles:
- Different versioning schemes (semantic, generation-based, etc.)
- Invalid version strings
- Missing version information

### 3. Compatibility Logic
Make compatibility logic clear and well-documented:
- Document your versioning scheme
- Explain compatibility rules
- Handle edge cases (null versions, missing data)

### 4. Testing
Thoroughly test your validator:
- Unit tests for version parsing
- Unit tests for compatibility logic
- Property-based tests for universal behavior
- Integration tests with the full generator

### 5. Documentation
Document your validator:
- Explain the accelerator type
- Document versioning scheme
- Provide usage examples
- List compatible frameworks

## Versioning Schemes

### Semantic Versioning (Major.Minor.Patch)
Used by: Neuron SDK, ROCm, Intel Gaudi

```javascript
parseVersion(versionString) {
  const [major, minor, patch] = versionString.split('.').map(Number);
  return { major, minor, patch };
}

isCompatible(required, provided) {
  return provided.major === required.major && 
         provided.minor >= required.minor;
}
```

### Major.Minor Versioning
Used by: CUDA

```javascript
parseVersion(versionString) {
  const [major, minor] = versionString.split('.').map(Number);
  return { major, minor };
}

isCompatible(required, provided) {
  return provided.major === required.major && 
         provided.minor >= required.minor;
}
```

### Generation-Based Versioning
Used by: TPU (v2, v3, v4, v5)

```javascript
parseVersion(versionString) {
  const generation = parseInt(versionString.replace('v', ''));
  return { generation };
}

isCompatible(required, provided) {
  return provided.generation >= required.generation;
}
```

### No Versioning
Used by: CPU

```javascript
validate(frameworkConfig, instanceConfig) {
  return {
    compatible: true,
    info: 'CPU-based inference (no accelerator version requirements)'
  };
}
```

## Adding Instance Type Support

After creating your validator, add instance types to the Instance Accelerator Mapping:

```javascript
// generators/app/config/registries/instance-accelerator-mapping.js
{
  "ml.tpu.v4-8": {
    "family": "tpu",
    "accelerator": {
      "type": "tpu",
      "hardware": "Google TPU v4",
      "architecture": "TPU v4",
      "versions": ["v4"],
      "default": "v4"
    },
    "memory": "32 GB",
    "vcpus": 8,
    "notes": "Google TPU v4 for ML inference"
  }
}
```

## Getting Help

- **Questions**: Open a [GitHub Discussion](https://github.com/awslabs/ml-container-creator/discussions)
- **Issues**: Report bugs via [GitHub Issues](https://github.com/awslabs/ml-container-creator/issues)
- **Examples**: See existing validators in `src/lib/`

## Related Documentation

- [Registry Contribution Guide](./REGISTRY_CONTRIBUTION_GUIDE.md) - Contributing configurations
- [Validation Framework](./architecture/validation.md) - How the validation engine composes accelerator validators
- [Testing Guide](./dev/testing.md) - Testing requirements and procedures

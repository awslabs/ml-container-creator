import CudaValidator from './cuda-validator.js';
import NeuronValidator from './neuron-validator.js';
import CpuValidator from './cpu-validator.js';
import RocmValidator from './rocm-validator.js';

/**
 * Validation engine for framework and instance compatibility.
 * Orchestrates accelerator validation using pluggable validators.
 * 
 * Requirements: 4.7, 4.8, 4.10, 4.11, 4.12, 4.13, 4.14, 4.15, 4.16, 4.17, 4.18, 4.20, 4.21
 */
export default class ValidationEngine {
    constructor() {
        // Initialize accelerator validators registry
        this.acceleratorValidators = new Map();
        
        // Register default validators
        this.registerAcceleratorValidator('cuda', new CudaValidator());
        this.registerAcceleratorValidator('neuron', new NeuronValidator());
        this.registerAcceleratorValidator('cpu', new CpuValidator());
        this.registerAcceleratorValidator('rocm', new RocmValidator());
    }
    
    /**
     * Register a custom accelerator validator.
     * Enables extensibility for new accelerator types.
     * 
     * @param {string} acceleratorType - Accelerator type (cuda, neuron, cpu, rocm, etc.)
     * @param {AcceleratorValidator} validator - Validator instance
     * 
     * Requirements: 4.10, 4.21
     */
    registerAcceleratorValidator(acceleratorType, validator) {
        this.acceleratorValidators.set(acceleratorType, validator);
    }
    
    /**
     * Validate accelerator compatibility between framework and instance.
     * Delegates to appropriate accelerator-specific validator.
     * 
     * @param {Object} frameworkConfig - Framework accelerator requirements
     * @param {Object} frameworkConfig.accelerator - Accelerator configuration
     * @param {string} frameworkConfig.accelerator.type - Accelerator type
     * @param {string} frameworkConfig.accelerator.version - Required version
     * @param {Object} instanceConfig - Instance accelerator capabilities
     * @param {Object} instanceConfig.accelerator - Accelerator configuration
     * @param {string} instanceConfig.accelerator.type - Accelerator type
     * @param {Array<string>} instanceConfig.accelerator.versions - Supported versions
     * @returns {Object} ValidationResult
     * @returns {boolean} ValidationResult.compatible - Whether configuration is compatible
     * @returns {string} [ValidationResult.error] - Error message if incompatible
     * @returns {string} [ValidationResult.warning] - Warning message if issues detected
     * @returns {string} [ValidationResult.info] - Informational message
     * 
     * Requirements: 4.11, 4.12, 4.13, 4.14, 4.15, 4.16, 4.17, 4.18
     */
    validateAcceleratorCompatibility(frameworkConfig, instanceConfig) {
        // Check if accelerator types match
        if (frameworkConfig.accelerator.type !== instanceConfig.accelerator.type) {
            return {
                compatible: false,
                error: `Framework requires ${frameworkConfig.accelerator.type} accelerator, ` +
                       `but instance provides ${instanceConfig.accelerator.type}. ` +
                       `Please select an instance type with ${frameworkConfig.accelerator.type} support.`
            };
        }
        
        // Get validator for accelerator type
        const validator = this.acceleratorValidators.get(frameworkConfig.accelerator.type);
        
        if (!validator) {
            return {
                compatible: true,
                warning: `No validator available for ${frameworkConfig.accelerator.type} accelerator. ` +
                        'Proceeding without version validation.'
            };
        }
        
        // Delegate to accelerator-specific validator
        return validator.validate(frameworkConfig, instanceConfig);
    }
    
    /**
     * Get recommended instance types for a framework configuration.
     * 
     * @param {Object} frameworkConfig - Framework configuration
     * @param {Object} instanceAcceleratorMapping - Instance accelerator mapping registry
     * @returns {Array<Object>} Recommended instance types with compatibility info
     * 
     * Requirements: 4.2, 4.3, 4.7, 4.8
     */
    getRecommendedInstanceTypes(frameworkConfig, instanceAcceleratorMapping) {
        const recommendations = [];
        
        // Iterate through all instance types in mapping
        for (const [instanceType, instanceConfig] of Object.entries(instanceAcceleratorMapping)) {
            // Validate compatibility
            const validation = this.validateAcceleratorCompatibility(frameworkConfig, instanceConfig);
            
            if (validation.compatible) {
                recommendations.push({
                    instanceType,
                    acceleratorType: instanceConfig.accelerator.type,
                    acceleratorVersions: instanceConfig.accelerator.versions,
                    compatible: true,
                    info: validation.info
                });
            }
        }
        
        return recommendations;
    }
    
    /**
     * Validate environment variables against framework specifications.
     * Uses multiple validation strategies based on configuration.
     * 
     * @param {Object} environmentVariables - Environment variables to validate
     * @param {Object} frameworkConfig - Framework configuration with known flags
     * @param {Object} options - Validation options
     * @param {boolean} options.enabled - Enable/disable validation completely (default: true)
     * @param {boolean} options.useKnownFlags - Use known flags registry (default: true)
     * @param {boolean} options.useCommunityReports - Use community reports (default: true)
     * @param {boolean} options.useDockerIntrospection - Use Docker introspection (default: false)
     * @returns {Object} ValidationResult
     * @returns {Array<Object>} ValidationResult.errors - Validation errors
     * @returns {Array<Object>} ValidationResult.warnings - Validation warnings
     * @returns {Array<string>} ValidationResult.strategiesUsed - Validation strategies used
     * 
     * Requirements: 13.9, 13.10, 13.11, 13.13, 13.14, 13.15, 13.16, 13.17, 13.31
     */
    validateEnvironmentVariables(environmentVariables, frameworkConfig, options = {}) {
        const {
            enabled = true,
            useKnownFlags = true,
            useCommunityReports = true,
            useDockerIntrospection = false
        } = options;
        
        // If validation is completely disabled, return empty result
        if (!enabled) {
            return {
                errors: [],
                warnings: [],
                strategiesUsed: []
            };
        }
        
        const errors = [];
        const warnings = [];
        const strategiesUsed = [];
        
        // Known flags validation
        if (useKnownFlags && frameworkConfig.knownFlags) {
            strategiesUsed.push('known-flags-registry');
            const knownFlagsResult = this._validateWithKnownFlags(
                environmentVariables,
                frameworkConfig.knownFlags
            );
            errors.push(...knownFlagsResult.errors);
            warnings.push(...knownFlagsResult.warnings);
        }
        
        // Community reports validation
        if (useCommunityReports && frameworkConfig.communityReports) {
            strategiesUsed.push('community-reports');
            const communityResult = this._validateWithCommunityReports(
                environmentVariables,
                frameworkConfig.communityReports
            );
            errors.push(...communityResult.errors);
            warnings.push(...communityResult.warnings);
        }
        
        // Docker introspection validation (opt-in, experimental)
        if (useDockerIntrospection) {
            strategiesUsed.push('docker-introspection');
            warnings.push({
                variable: null,
                message: 'Docker introspection validation is experimental and not tested in CI/CD'
            });
        }
        
        return {
            errors,
            warnings,
            strategiesUsed
        };
    }
    
    /**
     * Validate environment variables using known flags registry.
     * 
     * @param {Object} environmentVariables - Environment variables to validate
     * @param {Object} knownFlags - Known flags registry
     * @returns {Object} Validation result with errors and warnings
     * 
     * Requirements: 13.13, 13.14, 13.15, 13.16, 13.17
     * @private
     */
    _validateWithKnownFlags(environmentVariables, knownFlags) {
        const errors = [];
        const warnings = [];
        
        for (const [varName, varValue] of Object.entries(environmentVariables)) {
            const flagSpec = knownFlags[varName];
            
            if (!flagSpec) {
                // Unknown flag - not an error, just informational
                continue;
            }
            
            // Check if deprecated
            if (flagSpec.deprecated) {
                warnings.push({
                    variable: varName,
                    message: `${varName} is deprecated. ${flagSpec.deprecationMessage || ''}`,
                    replacement: flagSpec.replacement
                });
            }
            
            // Validate type
            if (flagSpec.type) {
                const typeValid = this._validateType(varValue, flagSpec.type);
                if (!typeValid) {
                    errors.push({
                        variable: varName,
                        message: `${varName} must be of type ${flagSpec.type}, got ${typeof varValue}`
                    });
                }
            }
            
            // Validate range constraints
            if (flagSpec.min !== undefined || flagSpec.max !== undefined) {
                const numValue = Number(varValue);
                if (flagSpec.min !== undefined && numValue < flagSpec.min) {
                    errors.push({
                        variable: varName,
                        message: `${varName} must be >= ${flagSpec.min}, got ${numValue}`
                    });
                }
                if (flagSpec.max !== undefined && numValue > flagSpec.max) {
                    errors.push({
                        variable: varName,
                        message: `${varName} must be <= ${flagSpec.max}, got ${numValue}`
                    });
                }
            }
        }
        
        return { errors, warnings };
    }
    
    /**
     * Validate environment variables using community reports.
     * 
     * @param {Object} environmentVariables - Environment variables to validate
     * @param {Object} communityReports - Community validation reports
     * @returns {Object} Validation result with errors and warnings
     * 
     * Requirements: 13.13, 13.14, 13.15
     * @private
     */
    _validateWithCommunityReports(environmentVariables, communityReports) {
        const errors = [];
        const warnings = [];
        
        for (const [varName] of Object.entries(environmentVariables)) {
            const reports = communityReports[varName];
            
            if (!reports || reports.length === 0) {
                continue;
            }
            
            // Check for reported issues
            const issueReports = reports.filter(r => r.status === 'invalid' || r.status === 'deprecated');
            if (issueReports.length > 0) {
                warnings.push({
                    variable: varName,
                    message: `Community reports indicate potential issues with ${varName}`,
                    reports: issueReports
                });
            }
        }
        
        return { errors, warnings };
    }
    
    /**
     * Validate value type.
     * 
     * @param {*} value - Value to validate
     * @param {string} expectedType - Expected type (integer, float, string, boolean)
     * @returns {boolean} True if type is valid
     * @private
     */
    _validateType(value, expectedType) {
        switch (expectedType) {
        case 'integer':
            return Number.isInteger(Number(value));
        case 'float':
            return !isNaN(Number(value));
        case 'string':
            return typeof value === 'string';
        case 'boolean':
            return value === 'true' || value === 'false' || 
                       value === true || value === false ||
                       value === '1' || value === '0' ||
                       value === 1 || value === 0;
        default:
            return true;
        }
    }
}

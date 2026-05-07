/**
 * Known Flags Validator Strategy
 * 
 * Validates environment variables against a registry of known flags for each framework.
 * Checks variable names, types, and range constraints.
 * 
 * Requirements: 13.9, 13.13, 13.14, 13.15
 */
export default class KnownFlagsValidator {
    /**
     * Create a new KnownFlagsValidator.
     * 
     * @param {Object} frameworkFlags - Framework flags registry
     */
    constructor(frameworkFlags = {}) {
        this.frameworkFlags = frameworkFlags;
        this.name = 'known-flags-registry';
    }
    
    /**
     * Validate environment variables against known flags registry.
     * 
     * @param {string} framework - Framework name
     * @param {string} version - Framework version
     * @param {Object} envVars - Environment variables to validate
     * @returns {Object} ValidationResult
     * @returns {Array<Object>} ValidationResult.warnings - Warning messages
     * @returns {Array<Object>} ValidationResult.errors - Error messages
     */
    async validate(framework, version, envVars) {
        const warnings = [];
        const errors = [];
        
        // Get known flags for this framework version
        const knownFlags = this.getKnownFlags(framework, version);
        
        if (!knownFlags || Object.keys(knownFlags).length === 0) {
            // No known flags data available
            return { warnings, errors };
        }
        
        // Validate each environment variable
        for (const [key, value] of Object.entries(envVars)) {
            const flagSpec = knownFlags[key];
            
            if (!flagSpec) {
                // Unknown flag - might be valid but not in our registry
                warnings.push({
                    key,
                    message: `Unknown environment variable '${key}' for ${framework} ${version}`
                });
                continue;
            }
            
            // Check if flag is deprecated
            if (flagSpec.deprecated) {
                warnings.push({
                    key,
                    message: `Environment variable '${key}' is deprecated. ${flagSpec.deprecationMessage || ''}`
                });
                
                if (flagSpec.replacement) {
                    warnings.push({
                        key,
                        message: `Consider using '${flagSpec.replacement}' instead of '${key}'`
                    });
                }
            }
            
            // Validate type
            const typeError = this.validateType(key, value, flagSpec.type);
            if (typeError) {
                errors.push(typeError);
                continue; // Skip range validation if type is wrong
            }
            
            // Validate range constraints
            const rangeError = this.validateRange(key, value, flagSpec);
            if (rangeError) {
                errors.push(rangeError);
            }
        }
        
        return { warnings, errors };
    }
    
    /**
     * Get known flags for a framework version.
     * 
     * @param {string} framework - Framework name
     * @param {string} version - Framework version
     * @returns {Object|null} Known flags specification
     * @private
     */
    getKnownFlags(framework, version) {
        if (!this.frameworkFlags[framework]) {
            return null;
        }
        
        // Try exact version match first
        if (this.frameworkFlags[framework][version]) {
            return this.frameworkFlags[framework][version];
        }
        
        // Try to find closest version (simplified - just use 'default' if available)
        if (this.frameworkFlags[framework].default) {
            return this.frameworkFlags[framework].default;
        }
        
        return null;
    }
    
    /**
     * Validate environment variable type.
     * 
     * @param {string} key - Variable name
     * @param {string} value - Variable value
     * @param {string} expectedType - Expected type (integer, float, string, boolean)
     * @returns {Object|null} Error object or null if valid
     * @private
     */
    validateType(key, value, expectedType) {
        if (!expectedType) {
            return null; // No type constraint
        }
        
        switch (expectedType) {
        case 'integer':
            if (!/^-?\d+$/.test(value)) {
                return {
                    key,
                    message: `Environment variable '${key}' must be an integer, got '${value}'`
                };
            }
            break;
                
        case 'float':
            if (!/^-?\d+(\.\d+)?$/.test(value)) {
                return {
                    key,
                    message: `Environment variable '${key}' must be a float, got '${value}'`
                };
            }
            break;
                
        case 'boolean':
            if (!['true', 'false', '0', '1', 'yes', 'no'].includes(value.toLowerCase())) {
                return {
                    key,
                    message: `Environment variable '${key}' must be a boolean (true/false, 0/1, yes/no), got '${value}'`
                };
            }
            break;
                
        case 'string':
            // String is always valid
            break;
                
        default:
            // Unknown type - skip validation
            break;
        }
        
        return null;
    }
    
    /**
     * Validate environment variable range constraints.
     * 
     * @param {string} key - Variable name
     * @param {string} value - Variable value
     * @param {Object} flagSpec - Flag specification with min/max constraints
     * @returns {Object|null} Error object or null if valid
     * @private
     */
    validateRange(key, value, flagSpec) {
        // Only validate range for numeric types
        if (flagSpec.type !== 'integer' && flagSpec.type !== 'float') {
            return null;
        }
        
        const numValue = parseFloat(value);
        
        if (flagSpec.min !== undefined && numValue < flagSpec.min) {
            return {
                key,
                message: `Environment variable '${key}' must be >= ${flagSpec.min}, got ${value}`
            };
        }
        
        if (flagSpec.max !== undefined && numValue > flagSpec.max) {
            return {
                key,
                message: `Environment variable '${key}' must be <= ${flagSpec.max}, got ${value}`
            };
        }
        
        return null;
    }
}

/**
 * Base class for accelerator-specific validators.
 * Implements the plugin architecture for extensible accelerator validation.
 * 
 * Requirements: 4.10, 4.21
 */
export default class AcceleratorValidator {
    /**
     * Validate framework config against instance config.
     * 
     * @param {Object} frameworkConfig - Framework accelerator requirements
     * @param {Object} frameworkConfig.accelerator - Accelerator configuration
     * @param {string} frameworkConfig.accelerator.type - Accelerator type (cuda, neuron, cpu, rocm)
     * @param {string} frameworkConfig.accelerator.version - Required accelerator version
     * @param {Object} instanceConfig - Instance accelerator capabilities
     * @param {Object} instanceConfig.accelerator - Accelerator configuration
     * @param {string} instanceConfig.accelerator.type - Accelerator type
     * @param {Array<string>} instanceConfig.accelerator.versions - Supported versions
     * @returns {Object} ValidationResult
     * @returns {boolean} ValidationResult.compatible - Whether configuration is compatible
     * @returns {string} [ValidationResult.error] - Error message if incompatible
     * @returns {string} [ValidationResult.warning] - Warning message if issues detected
     * @returns {string} [ValidationResult.info] - Informational message
     */
    validate(_frameworkConfig, _instanceConfig) {
        throw new Error('AcceleratorValidator.validate() must be implemented by subclass');
    }
    
    /**
     * Get user-friendly error message for version mismatch.
     * 
     * @param {string} required - Required version
     * @param {Array<string>|string} provided - Provided version(s)
     * @returns {string} User-friendly error message
     */
    getVersionMismatchMessage(_required, _provided) {
        throw new Error('AcceleratorValidator.getVersionMismatchMessage() must be implemented by subclass');
    }
}

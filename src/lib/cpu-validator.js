import AcceleratorValidator from './accelerator-validator.js';

/**
 * CPU accelerator validator.
 * CPU-based inference is always compatible (no version requirements).
 * 
 * Requirements: 4.9
 */
export default class CpuValidator extends AcceleratorValidator {
    /**
     * Validate CPU compatibility.
     * CPU is always compatible - no version checking needed.
     * 
     * @param {Object} frameworkConfig - Framework accelerator requirements
     * @param {Object} instanceConfig - Instance accelerator capabilities
     * @returns {Object} ValidationResult
     */
    validate(_frameworkConfig, _instanceConfig) {
        return {
            compatible: true,
            info: 'CPU-based inference (no accelerator version requirements)'
        };
    }
    
    /**
     * Get version mismatch message.
     * Not used for CPU since it's always compatible.
     * 
     * @param {string} required - Required version
     * @param {Array<string>|string} provided - Provided version(s)
     * @returns {string} Empty string (not used for CPU)
     */
    getVersionMismatchMessage(_required, _provided) {
        return ''; // Not used for CPU
    }
}

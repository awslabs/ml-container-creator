import AcceleratorValidator from './accelerator-validator.js';

/**
 * CUDA-specific accelerator validator.
 * Implements CUDA major.minor version comparison.
 * 
 * Requirements: 4.11, 4.12, 4.13, 4.14, 4.22
 */
export default class CudaValidator extends AcceleratorValidator {
    /**
     * Validate CUDA version compatibility.
     * CUDA uses major.minor versioning (e.g., 12.1, 11.8).
     * 
     * @param {Object} frameworkConfig - Framework accelerator requirements
     * @param {Object} instanceConfig - Instance accelerator capabilities
     * @returns {Object} ValidationResult
     */
    validate(frameworkConfig, instanceConfig) {
        const required = frameworkConfig.accelerator;
        const provided = instanceConfig.accelerator;
        
        // Parse required CUDA version (major.minor)
        const requiredMajor = parseInt(required.version.split('.')[0]);
        const requiredMinor = parseInt(required.version.split('.')[1]);
        
        // Check if instance supports required CUDA version
        // Instance must have same major version and >= minor version
        const compatibleVersions = provided.versions.filter(v => {
            const [major, minor] = v.split('.').map(Number);
            return major === requiredMajor && minor >= requiredMinor;
        });
        
        if (compatibleVersions.length === 0) {
            return {
                compatible: false,
                error: this.getVersionMismatchMessage(required.version, provided.versions)
            };
        }
        
        return {
            compatible: true,
            info: `Using CUDA ${compatibleVersions[0]} (compatible with required ${required.version})`
        };
    }
    
    /**
     * Get user-friendly error message for CUDA version mismatch.
     * 
     * @param {string} required - Required CUDA version
     * @param {Array<string>} provided - Provided CUDA versions
     * @returns {string} User-friendly error message
     */
    getVersionMismatchMessage(required, provided) {
        return `Framework requires CUDA ${required}, but instance only supports ${provided.join(', ')}. ` +
               'Consider using ml.g5 or ml.g6 instances for CUDA 12.x support.';
    }
}

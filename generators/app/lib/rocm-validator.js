import AcceleratorValidator from './accelerator-validator.js';

/**
 * ROCm accelerator validator for AMD GPUs.
 * Implements ROCm semantic versioning.
 * 
 * Requirements: 4.9, 4.22
 */
export default class RocmValidator extends AcceleratorValidator {
    /**
     * Validate ROCm version compatibility.
     * ROCm uses semantic versioning (e.g., 5.4.0, 5.5.0).
     * Major version must match, minor version must be >= required.
     * 
     * @param {Object} frameworkConfig - Framework accelerator requirements
     * @param {Object} instanceConfig - Instance accelerator capabilities
     * @returns {Object} ValidationResult
     */
    validate(frameworkConfig, instanceConfig) {
        const required = frameworkConfig.accelerator;
        const provided = instanceConfig.accelerator;
        
        // Parse required ROCm version
        const requiredVersion = this.parseVersion(required.version);
        
        // Check if instance supports required ROCm version
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
            info: `Using ROCm ${compatibleVersions[0]} (compatible with required ${required.version})`
        };
    }
    
    /**
     * Parse semantic version string into components.
     * 
     * @param {string} versionString - Version string (e.g., "5.4.0")
     * @returns {Object} Parsed version with major, minor, patch
     */
    parseVersion(versionString) {
        const [major, minor, patch] = versionString.split('.').map(Number);
        return { major, minor, patch };
    }
    
    /**
     * Check if provided version is compatible with required version.
     * ROCm: major must match, minor must be >= required.
     * 
     * @param {Object} required - Required version
     * @param {Object} provided - Provided version
     * @returns {boolean} True if compatible
     */
    isCompatible(required, provided) {
        return provided.major === required.major && 
               provided.minor >= required.minor;
    }
    
    /**
     * Get user-friendly error message for ROCm version mismatch.
     * 
     * @param {string} required - Required ROCm version
     * @param {Array<string>} provided - Provided ROCm versions
     * @returns {string} User-friendly error message
     */
    getVersionMismatchMessage(required, provided) {
        return `Framework requires ROCm ${required}, but instance only supports ${provided.join(', ')}. ` +
               'AMD GPU instances with ROCm support may be limited in SageMaker.';
    }
}

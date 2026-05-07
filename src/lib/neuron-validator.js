import AcceleratorValidator from './accelerator-validator.js';

/**
 * Neuron SDK accelerator validator.
 * Implements Neuron SDK semantic versioning.
 * 
 * Requirements: 4.11, 4.12, 4.13, 4.14, 4.22
 */
export default class NeuronValidator extends AcceleratorValidator {
    /**
     * Validate Neuron SDK version compatibility.
     * Neuron SDK uses semantic versioning (e.g., 2.15.0, 2.16.0).
     * Major version must match, minor version must be >= required.
     * 
     * @param {Object} frameworkConfig - Framework accelerator requirements
     * @param {Object} instanceConfig - Instance accelerator capabilities
     * @returns {Object} ValidationResult
     */
    validate(frameworkConfig, instanceConfig) {
        const required = frameworkConfig.accelerator;
        const provided = instanceConfig.accelerator;
        
        // Parse required Neuron SDK version
        const requiredVersion = this.parseVersion(required.version);
        
        // Check if instance supports required Neuron SDK version
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
            info: `Using Neuron SDK ${compatibleVersions[0]} (compatible with required ${required.version})`
        };
    }
    
    /**
     * Parse semantic version string into components.
     * 
     * @param {string} versionString - Version string (e.g., "2.15.0")
     * @returns {Object} Parsed version with major, minor, patch
     */
    parseVersion(versionString) {
        const [major, minor, patch] = versionString.split('.').map(Number);
        return { major, minor, patch };
    }
    
    /**
     * Check if provided version is compatible with required version.
     * Neuron SDK: major must match, minor must be >= required.
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
     * Get user-friendly error message for Neuron SDK version mismatch.
     * 
     * @param {string} required - Required Neuron SDK version
     * @param {Array<string>} provided - Provided Neuron SDK versions
     * @returns {string} User-friendly error message
     */
    getVersionMismatchMessage(required, provided) {
        return `Framework requires Neuron SDK ${required}, but instance only supports ${provided.join(', ')}. ` +
               'Consider using ml.inf2 instances for Neuron SDK 2.15+ support.';
    }
}

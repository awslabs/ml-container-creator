import AcceleratorValidator from './accelerator-validator.js';
import { compatibleVersions } from './accelerator-version.js';

/*
 * PATTERN: Strategy — the CUDA specialisation of the accelerator validator.
 *   CUDA is kept a distinct strategy (its own guidance message + major.minor
 *   semantics, ADR-006), but the major-match/minor->= comparison is shared with
 *   the semver validators via accelerator-version.js rather than re-inlined here.
 * COLLABORATORS: extends AcceleratorValidator; registered as the 'cuda' validator
 *   by ValidationEngine; delegates the version compare to accelerator-version.js.
 * See: docs/architecture/validation.md, docs/adr/ADR-006-unified-validation-framework.md
 *
 * Requirements: 4.11, 4.12, 4.13, 4.14, 4.22
 */
export default class CudaValidator extends AcceleratorValidator {
    /**
     * Validate CUDA version compatibility.
     * CUDA uses major.minor versioning (e.g., 12.1, 11.8): the instance must
     * offer the same major and a minor >= the required minor.
     * 
     * @param {Object} frameworkConfig - Framework accelerator requirements
     * @param {Object} instanceConfig - Instance accelerator capabilities
     * @returns {Object} ValidationResult
     */
    validate(frameworkConfig, instanceConfig) {
        const required = frameworkConfig.accelerator;
        const provided = instanceConfig.accelerator;

        const compatible = compatibleVersions(required.version, provided.versions);

        if (compatible.length === 0) {
            return {
                compatible: false,
                error: this.getVersionMismatchMessage(required.version, provided.versions)
            };
        }

        return {
            compatible: true,
            info: `Using CUDA ${compatible[0]} (compatible with required ${required.version})`
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

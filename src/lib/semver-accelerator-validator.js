import AcceleratorValidator from './accelerator-validator.js';
import { parseAcceleratorVersion, isMajorMinorCompatible } from './accelerator-version.js';

/*
 * PATTERN: Template Method / parameterized Strategy — one semantic-version
 *   compatibility algorithm (major must match, minor must be >=) shared by every
 *   accelerator that versions this way, specialised only by its display label
 *   and mismatch-message tail. The comparison rule itself lives in
 *   accelerator-version.js so cuda (a distinct strategy) shares it too.
 * COLLABORATORS: extends AcceleratorValidator (the strategy contract); subclassed
 *   by NeuronValidator and RocmValidator; instantiated/registered by
 *   ValidationEngine (validation-engine.js); delegates the version compare to
 *   accelerator-version.js.
 * DATA-FLOW ROLE: collapses the previously byte-identical neuron/rocm semver
 *   logic into one place while preserving each accelerator's distinct user-facing
 *   messages (neuron -> ml.inf2 guidance, rocm -> AMD GPU guidance).
 * See: docs/architecture/validation.md, docs/adr/ADR-006-unified-validation-framework.md
 */

/**
 * Base class for accelerators whose compatibility is "major must match, minor
 * must be >= required" over dotted semantic versions (e.g. Neuron SDK, ROCm).
 *
 * Subclasses provide a `label` (used in the success/info message) and a
 * `mismatchTail` (the guidance appended to the version-mismatch error). The
 * comparison algorithm itself lives here once.
 */
export default class SemverAcceleratorValidator extends AcceleratorValidator {
    /**
     * @param {Object} options
     * @param {string} options.label - Human-readable accelerator name (e.g. 'Neuron SDK', 'ROCm')
     * @param {string} options.mismatchTail - Sentence appended after the version
     *   mismatch summary in getVersionMismatchMessage
     */
    constructor({ label, mismatchTail } = {}) {
        super();
        this.label = label;
        this.mismatchTail = mismatchTail;
    }

    /**
     * Validate semantic-version compatibility.
     * Major version must match, minor version must be >= required.
     *
     * @param {Object} frameworkConfig - Framework accelerator requirements
     * @param {Object} instanceConfig - Instance accelerator capabilities
     * @returns {Object} ValidationResult { compatible, error? | info? }
     */
    validate(frameworkConfig, instanceConfig) {
        const required = frameworkConfig.accelerator;
        const provided = instanceConfig.accelerator;

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
            info: `Using ${this.label} ${compatibleVersions[0]} (compatible with required ${required.version})`
        };
    }

    /**
     * Parse a dotted semantic version string into components.
     * Delegates to the shared helper (single source of truth).
     * @param {string} versionString - Version string (e.g. '2.15.0')
     * @returns {{ major: number, minor: number, patch: number }}
     */
    parseVersion(versionString) {
        return parseAcceleratorVersion(versionString);
    }

    /**
     * Compatibility rule: major must match, minor must be >= required.
     * Delegates to the shared helper (single source of truth).
     * @param {Object} required - Parsed required version
     * @param {Object} provided - Parsed provided version
     * @returns {boolean}
     */
    isCompatible(required, provided) {
        return isMajorMinorCompatible(required, provided);
    }

    /**
     * User-friendly error message for a version mismatch.
     * The label and guidance tail come from the subclass, so neuron and rocm
     * keep their distinct wording.
     * @param {string} required - Required version
     * @param {Array<string>} provided - Provided versions
     * @returns {string}
     */
    getVersionMismatchMessage(required, provided) {
        return `Framework requires ${this.label} ${required}, but instance only supports ${provided.join(', ')}. ${this.mismatchTail}`;
    }
}

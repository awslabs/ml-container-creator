/**
 * Configuration Matcher
 * 
 * Finds best matching configurations for user selections.
 * Supports exact matching, fuzzy version matching, and pattern matching.
 */

class ConfigurationMatcher {
    constructor(frameworkRegistry = {}, modelRegistry = {}) {
        this.frameworkRegistry = frameworkRegistry;
        this.modelRegistry = modelRegistry;
    }

    /**
     * Match framework configuration
     * Tries exact match first, then finds closest compatible version
     * @param {string} framework - Framework name
     * @param {string} version - Framework version
     * @returns {Object|null} Framework configuration or null if not found
     */
    matchFramework(framework, version) {
        if (!Object.hasOwn(this.frameworkRegistry, framework)) {
            return null;
        }
        const frameworkVersions = this.frameworkRegistry[framework];

        // Exact match first
        if (Object.hasOwn(frameworkVersions, version)) {
            return {
                ...frameworkVersions[version],
                matchType: 'exact',
                matchedVersion: version
            };
        }

        // Find closest compatible version
        const closestMatch = this.findClosestVersion(frameworkVersions, version);
        if (closestMatch) {
            return {
                ...closestMatch.config,
                matchType: 'fuzzy',
                matchedVersion: closestMatch.version,
                requestedVersion: version
            };
        }

        return null;
    }

    /**
     * Find closest compatible version using semantic versioning
     * @param {Object} versions - Available versions object
     * @param {string} targetVersion - Target version to match
     * @returns {Object|null} Object with {version, config} or null
     */
    findClosestVersion(versions, targetVersion) {
        const availableVersions = Object.keys(versions);
        if (availableVersions.length === 0) {
            return null;
        }

        const target = this.parseVersion(targetVersion);
        if (!target) {
            return null;
        }

        let bestMatch = null;
        let smallestDiff = Infinity;

        for (const version of availableVersions) {
            const current = this.parseVersion(version);
            if (!current) continue;

            // Calculate version distance
            const diff = this.calculateVersionDistance(target, current);

            // Prefer versions that are >= target (forward compatible)
            // But also consider older versions if no newer ones exist
            if (diff < smallestDiff) {
                smallestDiff = diff;
                bestMatch = { version, config: versions[version] };
            }
        }

        return bestMatch;
    }

    /**
     * Parse semantic version string into components
     * @param {string} versionString - Version string (e.g., "1.2.3")
     * @returns {Object|null} Object with {major, minor, patch} or null
     */
    parseVersion(versionString) {
        if (!versionString || typeof versionString !== 'string') {
            return null;
        }

        // Remove 'v' prefix if present
        const cleaned = versionString.replace(/^v/, '');
        
        // Match semantic version pattern
        const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
        if (!match) {
            return null;
        }

        return {
            major: parseInt(match[1], 10),
            minor: parseInt(match[2] || '0', 10),
            patch: parseInt(match[3] || '0', 10)
        };
    }

    /**
     * Calculate distance between two versions
     * Lower distance means closer match
     * @param {Object} target - Target version {major, minor, patch}
     * @param {Object} current - Current version {major, minor, patch}
     * @returns {number} Distance value
     */
    calculateVersionDistance(target, current) {
        // Major version difference is most significant
        const majorDiff = Math.abs(current.major - target.major) * 10000;
        
        // Minor version difference
        const minorDiff = Math.abs(current.minor - target.minor) * 100;
        
        // Patch version difference
        const patchDiff = Math.abs(current.patch - target.patch);

        // Prefer newer versions slightly (small penalty for older versions)
        const directionPenalty = current.major < target.major ? 1 :
            current.major === target.major && current.minor < target.minor ? 0.5 :
                current.major === target.major && current.minor === target.minor && current.patch < target.patch ? 0.1 :
                    0;

        return majorDiff + minorDiff + patchDiff + directionPenalty;
    }

    /**
     * Match model configuration
     * Checks exact match first, then pattern matching
     * @param {string} modelId - Model ID (e.g., "meta-llama/Llama-2-7b-chat-hf")
     * @returns {Object|null} Model configuration or null if not found
     */
    matchModel(modelId) {
        if (!modelId) {
            return null;
        }

        // Check exact match first
        if (Object.hasOwn(this.modelRegistry, modelId)) {
            return {
                ...this.modelRegistry[modelId],
                matchType: 'exact',
                matchedPattern: modelId
            };
        }

        // Try pattern matching
        const patternMatch = this.matchModelPattern(modelId);
        if (patternMatch) {
            return {
                ...patternMatch.config,
                matchType: 'pattern',
                matchedPattern: patternMatch.pattern,
                modelId
            };
        }

        return null;
    }

    /**
     * Match model by pattern (e.g., "mistral*" matches "mistralai/Mistral-7B-v0.1")
     * @param {string} modelId - Model ID to match
     * @returns {Object|null} Object with {pattern, config} or null
     */
    matchModelPattern(modelId) {
        if (!modelId) {
            return null;
        }

        for (const [pattern, config] of Object.entries(this.modelRegistry)) {
            if (this.matchesPattern(modelId, pattern)) {
                return { pattern, config };
            }
        }

        return null;
    }

    /**
     * Check if a model ID matches a pattern
     * Supports wildcards (*) and case-insensitive matching
     * @param {string} modelId - Model ID to test
     * @param {string} pattern - Pattern to match against
     * @returns {boolean} True if matches
     */
    matchesPattern(modelId, pattern) {
        if (!modelId || !pattern) {
            return false;
        }

        // Exact match (no wildcards)
        if (!pattern.includes('*')) {
            return modelId.toLowerCase() === pattern.toLowerCase();
        }

        // Convert pattern to regex
        // Escape special regex characters except *
        const regexPattern = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
            .replace(/\*/g, '.*');  // Convert * to .*

        const regex = new RegExp(`^${regexPattern}$`, 'i');  // Case-insensitive
        return regex.test(modelId);
    }
}

export default ConfigurationMatcher;

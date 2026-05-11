/**
 * Base class for all validation plugins.
 * Custom validators extend this class and implement the validate method.
 *
 * Requirements: 12.1, 12.3, 12.6
 */
export default class BaseValidator {
    /**
     * Plugin name for source attribution in findings.
     * @type {string}
     */
    get name() {
        return 'base';
    }

    /**
     * When this validator runs: 'static', 'smart', or 'both'.
     * Static-only plugins run always; smart-only plugins run only when --smart is passed.
     * @type {'static'|'smart'|'both'}
     */
    get mode() {
        return 'static';
    }

    /**
     * Validate the context and return findings.
     * @param {Object} context - Full validation context (ValidationContext)
     * @param {Object} options
     * @param {Array} options.priorFindings - Findings from earlier validators
     * @param {Array} options.serviceModels - Parsed service models
     * @returns {Promise<Array>} Array of Finding objects
     */
    async validate(_context, _options) {
        return [];
    }
}

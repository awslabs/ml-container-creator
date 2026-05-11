/**
 * Required field validator.
 * Validates that all required fields in an operation's input shape
 * are present and non-empty in the payload.
 *
 * Requirements: 5.1, 5.2, 5.3
 */
import BaseValidator from './base-validator.js';

export default class RequiredFieldValidator extends BaseValidator {
    get name() {
        return 'required-field';
    }

    get mode() {
        return 'static';
    }

    /**
     * Validate required field presence for all payload operations.
     * @param {Object} context - ValidationContext from PayloadBuilder
     * @param {Object} options
     * @param {Array} options.serviceModels - Parsed ServiceModelIndex objects
     * @param {Array} options.priorFindings - Findings from earlier validators
     * @returns {Promise<Array>} Array of Finding objects
     */
    async validate(context, options) {
        const findings = [];
        const serviceModels = options.serviceModels || [];

        for (const [operationKey, payload] of Object.entries(context.payloads || {})) {
            const [service, operation] = operationKey.split(':');

            for (const model of serviceModels) {
                const op = model.operations.get(operation);
                if (!op || !op.input) continue;

                const inputShape = model.shapes.get(op.input);
                if (!inputShape || inputShape.type !== 'structure') continue;

                this._validateRequiredFields(
                    payload, inputShape, model, service, operation, '', findings
                );
            }
        }

        return findings;
    }

    /**
     * Recursively validate required fields in a structure.
     * @param {Object} payload - The payload object to validate
     * @param {Object} shape - The structure shape definition
     * @param {Object} model - The ServiceModelIndex
     * @param {string} service - Service name
     * @param {string} operation - Operation name
     * @param {string} parentPath - Dot-notation path prefix
     * @param {Array} findings - Accumulator for findings
     */
    _validateRequiredFields(payload, shape, model, service, operation, parentPath, findings) {
        if (!shape || shape.type !== 'structure') return;

        const requiredFields = shape.required || [];

        for (const fieldName of requiredFields) {
            const fieldPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;
            const memberDef = shape.members.get
                ? shape.members.get(fieldName)
                : shape.members[fieldName];

            const value = payload ? payload[fieldName] : undefined;

            if (value === undefined || value === null || value === '') {
                const description = memberDef && memberDef.documentation
                    ? memberDef.documentation
                    : `Required field for ${operation}`;

                findings.push({
                    service,
                    operation,
                    fieldPath,
                    invalidValue: value === undefined ? 'undefined' : value === null ? 'null' : '(empty string)',
                    constraint: { type: 'required', field: fieldName },
                    severity: 'error',
                    confidence: 'definitive',
                    source: this.name,
                    remediationHint: `Required field "${fieldName}" is missing or empty in ${operation}. ${description}`
                });
            } else if (typeof value === 'object' && !Array.isArray(value) && memberDef) {
                // Recursively validate nested structures
                const nestedShape = model.shapes.get(memberDef.shape);
                if (nestedShape && nestedShape.type === 'structure') {
                    this._validateRequiredFields(
                        value, nestedShape, model, service, operation, fieldPath, findings
                    );
                }
            }
        }

        // Also recursively validate nested structures that are present (even if optional)
        if (payload && typeof payload === 'object' && shape.members) {
            for (const [fieldName, value] of Object.entries(payload)) {
                if (value === null || value === undefined) continue;
                if (typeof value !== 'object' || Array.isArray(value)) continue;

                const memberDef = shape.members.get
                    ? shape.members.get(fieldName)
                    : shape.members[fieldName];
                if (!memberDef) continue;

                const nestedShape = model.shapes.get(memberDef.shape);
                if (!nestedShape || nestedShape.type !== 'structure') continue;

                // Skip if already validated as a required field above
                if (requiredFields.includes(fieldName)) continue;

                const fieldPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;
                this._validateRequiredFields(
                    value, nestedShape, model, service, operation, fieldPath, findings
                );
            }
        }

        // Recursively validate list elements that are structures
        if (payload && typeof payload === 'object' && shape.members) {
            for (const [fieldName, value] of Object.entries(payload)) {
                if (!Array.isArray(value)) continue;

                const memberDef = shape.members.get
                    ? shape.members.get(fieldName)
                    : shape.members[fieldName];
                if (!memberDef) continue;

                const listShape = model.shapes.get(memberDef.shape);
                if (!listShape || listShape.type !== 'list' || !listShape.member) continue;

                const elementShape = model.shapes.get(listShape.member.shape);
                if (!elementShape || elementShape.type !== 'structure') continue;

                const fieldPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;
                for (let i = 0; i < value.length; i++) {
                    this._validateRequiredFields(
                        value[i], elementShape, model, service, operation,
                        `${fieldPath}[${i}]`, findings
                    );
                }
            }
        }
    }
}

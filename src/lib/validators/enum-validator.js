/**
 * Enum constraint validator.
 * Validates that payload field values are within the allowed enum set
 * defined in the AWS service model.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.5
 */
import BaseValidator from './base-validator.js';

export default class EnumValidator extends BaseValidator {
    get name() {
        return 'enum';
    }

    get mode() {
        return 'static';
    }

    /**
     * Validate enum constraints for all payload fields.
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

                this._validateStructure(
                    payload, inputShape, model, service, operation, '', findings
                );
            }
        }

        return findings;
    }

    /**
     * Recursively validate enum constraints in a structure.
     * @param {Object} payload - The payload object to validate
     * @param {Object} shape - The structure shape definition
     * @param {Object} model - The ServiceModelIndex
     * @param {string} service - Service name
     * @param {string} operation - Operation name
     * @param {string} parentPath - Dot-notation path prefix
     * @param {Array} findings - Accumulator for findings
     */
    _validateStructure(payload, shape, model, service, operation, parentPath, findings) {
        if (!payload || typeof payload !== 'object' || !shape.members) return;

        for (const [fieldName, value] of Object.entries(payload)) {
            const memberDef = shape.members.get
                ? shape.members.get(fieldName)
                : shape.members[fieldName];
            if (!memberDef) continue;

            const fieldPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;
            const fieldShape = model.shapes.get(memberDef.shape);
            if (!fieldShape) continue;

            if (fieldShape.type === 'string' && fieldShape.enum && fieldShape.enum.length > 0) {
                if (typeof value === 'string' && !fieldShape.enum.includes(value)) {
                    findings.push({
                        service,
                        operation,
                        fieldPath,
                        invalidValue: value,
                        constraint: { type: 'enum', values: [...fieldShape.enum] },
                        severity: 'error',
                        confidence: 'definitive',
                        source: this.name,
                        remediationHint: `Value "${value}" is not valid. Allowed values: ${fieldShape.enum.join(', ')}. Run \`bootstrap sync-schemas\` to update the enum set.`
                    });
                }
            } else if (fieldShape.type === 'structure') {
                this._validateStructure(
                    value, fieldShape, model, service, operation, fieldPath, findings
                );
            } else if (fieldShape.type === 'list' && Array.isArray(value) && fieldShape.member) {
                const elementShape = model.shapes.get(fieldShape.member.shape);
                if (elementShape && elementShape.type === 'structure') {
                    for (let i = 0; i < value.length; i++) {
                        this._validateStructure(
                            value[i], elementShape, model, service, operation,
                            `${fieldPath}[${i}]`, findings
                        );
                    }
                } else if (elementShape && elementShape.type === 'string' && elementShape.enum) {
                    for (let i = 0; i < value.length; i++) {
                        if (typeof value[i] === 'string' && !elementShape.enum.includes(value[i])) {
                            findings.push({
                                service,
                                operation,
                                fieldPath: `${fieldPath}[${i}]`,
                                invalidValue: value[i],
                                constraint: { type: 'enum', values: [...elementShape.enum] },
                                severity: 'error',
                                confidence: 'definitive',
                                source: this.name,
                                remediationHint: `Value "${value[i]}" is not valid. Allowed values: ${elementShape.enum.join(', ')}. Run \`bootstrap sync-schemas\` to update the enum set.`
                            });
                        }
                    }
                }
            }
        }
    }
}

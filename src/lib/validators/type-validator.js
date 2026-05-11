/* eslint-disable eqeqeq */
/**
 * Type constraint validator.
 * Validates that payload field values match their expected types
 * (integer, string, boolean, list) and numeric min/max constraints.
 * Also validates pattern constraints on string fields.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 4.4
 */
import BaseValidator from './base-validator.js';

export default class TypeValidator extends BaseValidator {
    get name() {
        return 'type';
    }

    get mode() {
        return 'static';
    }

    /**
     * Validate type constraints for all payload fields.
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
     * Recursively validate type constraints in a structure.
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

            this._validateField(value, fieldShape, model, service, operation, fieldPath, findings);
        }
    }

    /**
     * Validate a single field value against its shape definition.
     * @param {*} value - The field value
     * @param {Object} fieldShape - The shape definition for this field
     * @param {Object} model - The ServiceModelIndex
     * @param {string} service - Service name
     * @param {string} operation - Operation name
     * @param {string} fieldPath - Full dot-notation path
     * @param {Array} findings - Accumulator for findings
     */
    _validateField(value, fieldShape, model, service, operation, fieldPath, findings) {
        if (value === null || value === undefined) return;

        switch (fieldShape.type) {
        case 'string':
            this._validateString(value, fieldShape, service, operation, fieldPath, findings);
            break;
        case 'integer':
        case 'long':
            this._validateInteger(value, fieldShape, service, operation, fieldPath, findings);
            break;
        case 'float':
        case 'double':
            this._validateNumeric(value, fieldShape, service, operation, fieldPath, findings);
            break;
        case 'boolean':
            this._validateBoolean(value, service, operation, fieldPath, findings);
            break;
        case 'list':
            this._validateList(value, fieldShape, model, service, operation, fieldPath, findings);
            break;
        case 'structure':
            this._validateStructure(value, fieldShape, model, service, operation, fieldPath, findings);
            break;
        }
    }

    /**
     * Validate a string field.
     */
    _validateString(value, fieldShape, service, operation, fieldPath, findings) {
        if (typeof value !== 'string') {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'type', expected: 'string', actual: typeof value },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `Expected a string value but got ${typeof value}.`
            });
            return;
        }

        // Pattern validation (only when no enum — enum validator handles enum shapes)
        if (fieldShape.pattern && !fieldShape.enum) {
            try {
                const regex = new RegExp(fieldShape.pattern);
                if (!regex.test(value)) {
                    findings.push({
                        service,
                        operation,
                        fieldPath,
                        invalidValue: value,
                        constraint: { type: 'pattern', pattern: fieldShape.pattern },
                        severity: 'error',
                        confidence: 'definitive',
                        source: this.name,
                        remediationHint: `Value "${value}" does not match required pattern: ${fieldShape.pattern}`
                    });
                }
            } catch (e) {
                // Invalid regex in service model — skip pattern validation
            }
        }

        // String length constraints
        if (fieldShape.min != null && value.length < fieldShape.min) {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'range', min: fieldShape.min, max: fieldShape.max },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `String length ${value.length} is below minimum ${fieldShape.min}.`
            });
        }
        if (fieldShape.max != null && value.length > fieldShape.max) {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'range', min: fieldShape.min, max: fieldShape.max },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `String length ${value.length} exceeds maximum ${fieldShape.max}.`
            });
        }
    }

    /**
     * Validate an integer field.
     */
    _validateInteger(value, fieldShape, service, operation, fieldPath, findings) {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'type', expected: 'integer', actual: typeof value },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `Expected an integer value but got ${typeof value === 'number' ? 'float' : typeof value}.`
            });
            return;
        }

        this._validateRange(value, fieldShape, service, operation, fieldPath, findings);
    }

    /**
     * Validate a numeric (float/double) field.
     */
    _validateNumeric(value, fieldShape, service, operation, fieldPath, findings) {
        if (typeof value !== 'number') {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'type', expected: 'number', actual: typeof value },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `Expected a numeric value but got ${typeof value}.`
            });
            return;
        }

        this._validateRange(value, fieldShape, service, operation, fieldPath, findings);
    }

    /**
     * Validate a boolean field.
     */
    _validateBoolean(value, service, operation, fieldPath, findings) {
        if (typeof value !== 'boolean') {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'type', expected: 'boolean', actual: typeof value },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `Expected a boolean value but got ${typeof value}.`
            });
        }
    }

    /**
     * Validate a list field.
     */
    _validateList(value, fieldShape, model, service, operation, fieldPath, findings) {
        if (!Array.isArray(value)) {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'type', expected: 'list', actual: typeof value },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `Expected an array but got ${typeof value}.`
            });
            return;
        }

        // Recursively validate each element
        if (fieldShape.member && fieldShape.member.shape) {
            const elementShape = model.shapes.get(fieldShape.member.shape);
            if (elementShape) {
                for (let i = 0; i < value.length; i++) {
                    this._validateField(
                        value[i], elementShape, model, service, operation,
                        `${fieldPath}[${i}]`, findings
                    );
                }
            }
        }
    }

    /**
     * Validate numeric range constraints (min/max).
     */
    _validateRange(value, fieldShape, service, operation, fieldPath, findings) {
        if (fieldShape.min != null && value < fieldShape.min) {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'range', min: fieldShape.min, max: fieldShape.max },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `Value ${value} is below minimum ${fieldShape.min}.`
            });
        }
        if (fieldShape.max != null && value > fieldShape.max) {
            findings.push({
                service,
                operation,
                fieldPath,
                invalidValue: value,
                constraint: { type: 'range', min: fieldShape.min, max: fieldShape.max },
                severity: 'error',
                confidence: 'definitive',
                source: this.name,
                remediationHint: `Value ${value} exceeds maximum ${fieldShape.max}.`
            });
        }
    }
}

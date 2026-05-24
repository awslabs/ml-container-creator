// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parameter Schema Validator
 *
 * Validates infrastructure parameters (endpoint, iC) against constraints
 * defined in the Parameter_Schema JSON file. Supports schema loading from
 * a file path or programmatic object override.
 *
 * Requirements: 10.1, 10.5, 10.6
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUNDLED_SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'config', 'parameter-schema-v2.json');

const SUPPORTED_SCHEMA_VERSION = '2.0.0';

/**
 * Maps ConfigManager parameter keys to their schema paths in parameter-schema-v2.json.
 * Format: 'deploymentTarget.group.shortName' for the old nested schema format.
 * The validator resolves these paths against both old and new schema formats.
 */
const PARAMETER_NAME_MAP = {
    endpointInitialInstanceCount: 'realtime-inference.endpoint.initialInstanceCount',
    endpointDataCapturePercent: 'realtime-inference.endpoint.dataCapturePercent',
    endpointVariantName: 'realtime-inference.endpoint.variantName',
    endpointVolumeSize: 'realtime-inference.endpoint.volumeSize',
    icCpuCount: 'realtime-inference.inferenceComponent.cpuCount',
    icMemorySize: 'realtime-inference.inferenceComponent.memorySize',
    icGpuCount: 'realtime-inference.inferenceComponent.gpuCount',
    icCopyCount: 'realtime-inference.inferenceComponent.copyCount',
    icModelWeight: 'realtime-inference.inferenceComponent.modelWeight'
};

/**
 * Maps parameter keys to their AWS API references for error messages.
 */
const API_REFERENCE_MAP = {
    endpointInitialInstanceCount: 'CreateEndpointConfig.ProductionVariants.InitialInstanceCount',
    endpointDataCapturePercent: 'CreateEndpointConfig.DataCaptureConfig.InitialSamplingPercentage',
    endpointVariantName: 'CreateEndpointConfig.ProductionVariants.VariantName',
    endpointVolumeSize: 'CreateEndpointConfig.ProductionVariants.VolumeSizeInGB',
    icCpuCount: 'CreateInferenceComponent.Specification.ComputeResourceRequirements.NumberOfCpuCoresRequired',
    icMemorySize: 'CreateInferenceComponent.Specification.ComputeResourceRequirements.MinMemoryRequiredInMb',
    icGpuCount: 'CreateInferenceComponent.Specification.ComputeResourceRequirements.NumberOfAcceleratorDevicesRequired',
    icCopyCount: 'CreateInferenceComponent.RuntimeConfig.CopyCount',
    icModelWeight: 'CreateInferenceComponent.RuntimeConfig.ModelWeight'
};

export default class ParameterSchemaValidator {
    /**
     * @param {string|Object} schemaSource - File path to schema JSON, or schema object override
     */
    constructor(schemaSource) {
        this.schema = null;
        this._loadSchema(schemaSource);
    }

    /**
     * Load schema from file path or object override.
     * Falls back to bundled baseline on failure.
     * @param {string|Object} schemaSource
     */
    _loadSchema(schemaSource) {
        if (schemaSource && typeof schemaSource === 'object') {
            this.schema = schemaSource;
            this._checkSchemaVersion();
            return;
        }

        const filePath = typeof schemaSource === 'string' ? schemaSource : BUNDLED_SCHEMA_PATH;

        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            this.schema = JSON.parse(raw);
            this._checkSchemaVersion();
        } catch (err) {
            if (filePath !== BUNDLED_SCHEMA_PATH) {
                console.warn(`Parameter schema not found at ${filePath}, using bundled baseline`);
                try {
                    const raw = fs.readFileSync(BUNDLED_SCHEMA_PATH, 'utf8');
                    this.schema = JSON.parse(raw);
                    this._checkSchemaVersion();
                } catch (fallbackErr) {
                    console.warn(`Failed to load bundled parameter schema: ${fallbackErr.message}`);
                    this.schema = { schemaVersion: SUPPORTED_SCHEMA_VERSION, deploymentTargets: {} };
                }
            } else {
                console.warn(`Failed to load bundled parameter schema: ${err.message}`);
                this.schema = { schemaVersion: SUPPORTED_SCHEMA_VERSION, deploymentTargets: {} };
            }
        }
    }

    /**
     * Check schema version compatibility.
     */
    _checkSchemaVersion() {
        const version = this.schema && this.schema.schemaVersion;
        if (version && version !== SUPPORTED_SCHEMA_VERSION && version !== '1.0.0') {
            console.warn(`Schema version ${version} may not be fully compatible with this validator`);
        }
    }

    /**
     * Resolve a parameter name to its schema constraint object.
     * Supports both the old nested format (deploymentTargets.{target}.{group}.{param})
     * and the new flat format (parameters.{key}).
     * @param {string} parameterName - ConfigManager key (e.g., 'endpointVolumeSize')
     * @param {string} [deploymentTarget] - Deployment target override
     * @returns {Object|null} Constraint object or null if not found
     */
    _resolveConstraint(parameterName, deploymentTarget) {
        const schemaPath = PARAMETER_NAME_MAP[parameterName];
        if (!schemaPath) {
            return null;
        }

        // Try old nested format first: deploymentTargets.{target}.{group}.{param}
        const deploymentTargets = this.schema && this.schema.deploymentTargets;
        if (deploymentTargets) {
            const parts = schemaPath.split('.');
            const [defaultTarget, group, shortName] = parts;
            const target = deploymentTarget || defaultTarget;

            const targetObj = deploymentTargets[target];
            if (targetObj && targetObj[group] && targetObj[group][shortName]) {
                const constraint = targetObj[group][shortName];
                return {
                    type: constraint.type,
                    min: constraint.min,
                    max: constraint.max,
                    pattern: constraint.pattern,
                    default: constraint.default,
                    description: constraint.description,
                    apiReference: constraint.apiReference || API_REFERENCE_MAP[parameterName] || `parameter-schema-v2.json#${parameterName}`
                };
            }
        }

        // Try new flat format: parameters.{key}
        const params = this.schema && this.schema.parameters;
        if (params && params[parameterName]) {
            const param = params[parameterName];
            if (!param.validation || Object.keys(param.validation).length === 0) {
                return null;
            }

            return {
                type: param.type,
                min: param.validation.min,
                max: param.validation.max,
                pattern: param.validation.pattern,
                default: param.default,
                description: param.description,
                apiReference: API_REFERENCE_MAP[parameterName] || `parameter-schema-v2.json#${parameterName}`
            };
        }

        return null;
    }

    /**
     * Validate a parameter value against schema constraints.
     * @param {string} parameterName - ConfigManager key (e.g., 'endpointVolumeSize')
     * @param {*} value - The value to validate
     * @param {string} [deploymentTarget] - Deployment target (defaults to schema path target)
     * @returns {{ valid: boolean, error?: string }}
     */
    validate(parameterName, value, deploymentTarget) {
        const constraint = this._resolveConstraint(parameterName, deploymentTarget);
        if (!constraint) {
            return { valid: true };
        }

        // Null/undefined values are valid (parameter is optional)
        if (value === null || value === undefined) {
            return { valid: true };
        }

        // Type validation
        const typeResult = this._validateType(value, constraint);
        if (!typeResult.valid) {
            return {
                valid: false,
                error: this.getErrorMessage(parameterName, value, constraint)
            };
        }

        // Range validation for numeric types
        if (constraint.type === 'integer' || constraint.type === 'number') {
            const rangeResult = this._validateRange(value, constraint);
            if (!rangeResult.valid) {
                return {
                    valid: false,
                    error: this.getErrorMessage(parameterName, value, constraint)
                };
            }
        }

        // Pattern validation for string types
        if (constraint.type === 'string' && constraint.pattern) {
            const patternResult = this._validatePattern(value, constraint);
            if (!patternResult.valid) {
                return {
                    valid: false,
                    error: this.getErrorMessage(parameterName, value, constraint)
                };
            }
        }

        return { valid: true };
    }

    /**
     * Get constraints for a parameter.
     * @param {string} parameterName - ConfigManager key
     * @param {string} [deploymentTarget] - Deployment target override
     * @returns {Object|null} Constraint object or null
     */
    getConstraints(parameterName, deploymentTarget) {
        return this._resolveConstraint(parameterName, deploymentTarget);
    }

    /**
     * Build a constraint-referencing error message.
     * @param {string} parameterName - ConfigManager key
     * @param {*} value - The invalid value
     * @param {Object} constraint - The constraint object from schema
     * @returns {string} Error message with API reference
     */
    getErrorMessage(parameterName, value, constraint) {
        const description = this._buildConstraintDescription(constraint);
        const apiRef = constraint.apiReference || 'unknown';
        return `${parameterName} must be ${description} per ${apiRef}`;
    }

    /**
     * Build a human-readable constraint description.
     * @param {Object} constraint
     * @returns {string}
     */
    _buildConstraintDescription(constraint) {
        if (constraint.type === 'string' && constraint.pattern) {
            return `a string matching pattern ${constraint.pattern}`;
        }

        const parts = [];

        if (constraint.type === 'integer') {
            parts.push('an integer');
        } else if (constraint.type === 'number') {
            parts.push('a number');
        }

        if (constraint.min !== undefined && constraint.max !== undefined) {
            parts.push(`\u2265 ${constraint.min} and \u2264 ${constraint.max}`);
        } else if (constraint.min !== undefined) {
            parts.push(`\u2265 ${constraint.min}`);
        } else if (constraint.max !== undefined) {
            parts.push(`\u2264 ${constraint.max}`);
        }

        return parts.join(' ') || `a valid ${constraint.type}`;
    }

    /**
     * Validate value type against constraint type.
     * @param {*} value
     * @param {Object} constraint
     * @returns {{ valid: boolean }}
     */
    _validateType(value, constraint) {
        if (constraint.type === 'integer') {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                return { valid: false };
            }
        } else if (constraint.type === 'number') {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return { valid: false };
            }
        } else if (constraint.type === 'string') {
            if (typeof value !== 'string') {
                return { valid: false };
            }
        }
        return { valid: true };
    }

    /**
     * Validate numeric value against min/max bounds.
     * @param {number} value
     * @param {Object} constraint
     * @returns {{ valid: boolean }}
     */
    _validateRange(value, constraint) {
        if (constraint.min !== undefined && value < constraint.min) {
            return { valid: false };
        }
        if (constraint.max !== undefined && value > constraint.max) {
            return { valid: false };
        }
        return { valid: true };
    }

    /**
     * Validate string value against pattern.
     * @param {string} value
     * @param {Object} constraint
     * @returns {{ valid: boolean }}
     */
    _validatePattern(value, constraint) {
        const regex = new RegExp(constraint.pattern);
        if (!regex.test(value)) {
            return { valid: false };
        }
        return { valid: true };
    }
}

export { PARAMETER_NAME_MAP, SUPPORTED_SCHEMA_VERSION, BUNDLED_SCHEMA_PATH };

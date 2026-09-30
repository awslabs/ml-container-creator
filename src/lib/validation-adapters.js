// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * PATTERN: Adapter — translate the one unified Finding shape back into the
 *   legacy result shapes that pre-Wave-5 callers still expect.
 * COLLABORATORS: consumes Finding objects (see validators/base-validator.js and
 *   validation-report.js); serves registry-config-manager.js (accelerator +
 *   env-var results), config-validator.js (message arrays) and the parameter /
 *   tune-catalog validators ({valid,error} results).
 * DATA-FLOW ROLE: the SINGLE compatibility surface between the unified
 *   validation framework and legacy call sites. During Wave 5 migration, this is
 *   the only place a legacy shape is constructed from Findings; when every caller
 *   reads Findings directly these adapters can be deleted.
 * See: docs/architecture/validation.md, docs/adr/ADR-006-unified-validation-framework.md
 */

/**
 * A Finding is the atom of validation output (see ADR-006):
 *   { service, operation, fieldPath, invalidValue, constraint,
 *     severity: 'error'|'warning'|'info',
 *     confidence: 'definitive'|'medium'|'low',
 *     source, remediationHint }
 */

/**
 * Build a Finding from an accelerator-compatibility outcome.
 * Centralises the {compatible, error?, warning?, info?} -> Finding mapping so
 * accelerator strategies can emit Findings while `toAcceleratorResult` rebuilds
 * the legacy shape for callers that have not migrated.
 *
 * @param {Object} outcome
 * @param {boolean} outcome.compatible
 * @param {string} [outcome.error]
 * @param {string} [outcome.warning]
 * @param {string} [outcome.info]
 * @param {string} [outcome.source] - attribution (default 'accelerator')
 * @param {string} [outcome.fieldPath] - accelerator type/field (optional)
 * @returns {Object|null} a Finding, or null when compatible with no message
 */
export function acceleratorFinding(outcome) {
    const source = outcome.source || 'accelerator';
    const fieldPath = outcome.fieldPath || '';

    if (outcome.error) {
        return {
            service: 'accelerator',
            operation: '',
            fieldPath,
            invalidValue: undefined,
            constraint: undefined,
            severity: 'error',
            confidence: 'definitive',
            source,
            remediationHint: outcome.error
        };
    }
    if (outcome.warning) {
        return {
            service: 'accelerator',
            operation: '',
            fieldPath,
            invalidValue: undefined,
            constraint: undefined,
            severity: 'warning',
            confidence: 'definitive',
            source,
            remediationHint: outcome.warning
        };
    }
    if (outcome.info) {
        return {
            service: 'accelerator',
            operation: '',
            fieldPath,
            invalidValue: undefined,
            constraint: undefined,
            severity: 'info',
            confidence: 'definitive',
            source,
            remediationHint: outcome.info
        };
    }
    return null;
}

/**
 * Rebuild the legacy accelerator result shape from Findings.
 * Mirrors ValidationEngine.validateAcceleratorCompatibility's contract:
 *   { compatible, error?, warning?, info? } (strings).
 * An error makes it incompatible; warning/info are attached when present.
 *
 * @param {Array<Object>} findings
 * @returns {{ compatible: boolean, error?: string, warning?: string, info?: string }}
 */
export function toAcceleratorResult(findings) {
    const list = findings || [];
    const error = list.find(f => f.severity === 'error');
    if (error) {
        return { compatible: false, error: error.remediationHint };
    }

    const result = { compatible: true };
    const warning = list.find(f => f.severity === 'warning');
    if (warning) {
        result.warning = warning.remediationHint;
    }
    const info = list.find(f => f.severity === 'info');
    if (info) {
        result.info = info.remediationHint;
    }
    return result;
}

/**
 * Build an env-var Finding. The legacy env-var result carries per-variable
 * objects ({variable, message, ...}); we preserve those extra keys under
 * `constraint` so `toEnvVarResult` can reconstruct them verbatim.
 *
 * @param {Object} entry - legacy env-var error/warning object (has `variable`)
 * @param {'error'|'warning'} severity
 * @param {string} strategy - the strategy that produced it
 * @returns {Object} a Finding
 */
export function envVarFinding(entry, severity, strategy) {
    const { variable, message, ...rest } = entry;
    return {
        service: 'env-var',
        operation: '',
        fieldPath: variable || '',
        invalidValue: undefined,
        constraint: { strategy, ...rest },
        severity,
        confidence: 'definitive',
        source: 'env-var',
        remediationHint: message || ''
    };
}

/**
 * Rebuild the legacy env-var result shape from Findings + the strategies list.
 * Mirrors ValidationEngine.validateEnvironmentVariables's contract:
 *   { errors: [{variable, message, ...}], warnings: [...], strategiesUsed: [] }.
 *
 * @param {Array<Object>} findings
 * @param {Array<string>} strategiesUsed
 * @returns {{ errors: Array<Object>, warnings: Array<Object>, strategiesUsed: Array<string> }}
 */
export function toEnvVarResult(findings, strategiesUsed = []) {
    const errors = [];
    const warnings = [];

    for (const f of findings || []) {
        // Strip the internal `strategy` key; the rest were the legacy entry's extra fields.
        const rest = { ...(f.constraint || {}) };
        delete rest.strategy;
        const entry = { variable: f.fieldPath || null, message: f.remediationHint, ...rest };
        if (f.severity === 'error') {
            errors.push(entry);
        } else {
            warnings.push(entry);
        }
    }

    return { errors, warnings, strategiesUsed };
}

/**
 * Build a Finding from a single human-readable config message.
 * @param {string} message
 * @param {Object} [opts]
 * @param {string} [opts.fieldPath]
 * @param {'error'|'warning'} [opts.severity]
 * @returns {Object} a Finding
 */
export function configFinding(message, opts = {}) {
    return {
        service: 'config',
        operation: '',
        fieldPath: opts.fieldPath || '',
        invalidValue: undefined,
        constraint: undefined,
        severity: opts.severity || 'error',
        confidence: 'definitive',
        source: 'config',
        remediationHint: message
    };
}

/**
 * Rebuild the legacy string-array shape from Findings.
 * Mirrors ConfigValidator.validateConfiguration / validateRequiredParameters:
 *   Array<string> (the remediation messages).
 *
 * @param {Array<Object>} findings
 * @returns {Array<string>}
 */
export function toMessageArray(findings) {
    return (findings || []).map(f => f.remediationHint).filter(Boolean);
}

/**
 * Rebuild the legacy { valid, error? } shape from Findings.
 * Mirrors parameter-schema-validator / tune-catalog-validator's contract:
 * valid when there are no error-severity findings; error is the first message.
 *
 * @param {Array<Object>} findings
 * @returns {{ valid: boolean, error?: string }}
 */
export function toValidField(findings) {
    const error = (findings || []).find(f => f.severity === 'error');
    if (error) {
        return { valid: false, error: error.remediationHint };
    }
    return { valid: true };
}

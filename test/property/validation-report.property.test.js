// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation Report Property-Based Tests
 *
 * Feature: schema-driven-validation, Property 19: Finding metadata completeness
 * Feature: schema-driven-validation, Property 20: Report summary accuracy
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ValidationReport from '../../src/lib/validation-report.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid severity value.
 */
const arbSeverity = fc.constantFrom('error', 'warning');

/**
 * Generate a valid confidence value.
 */
const arbConfidence = fc.constantFrom('definitive', 'high', 'medium', 'low');

/**
 * Generate a valid source string (non-empty, identifying the producing validator).
 */
const arbSource = fc.constantFrom(
    'enum', 'type', 'required-field', 'cross-cutting', 'smart-mode', 'catalog', 'custom-plugin'
);

/**
 * Generate a valid service name.
 */
const arbService = fc.constantFrom('sagemaker', 'iam', 'ecr', 's3', 'cross-cutting');

/**
 * Generate a valid operation name.
 */
const arbOperation = fc.constantFrom(
    'CreateEndpointConfig', 'CreateInferenceComponent', 'CreateModel',
    'CreateTransformJob', 'CreateRepository', 'CreateRole', 'configuration'
);

/**
 * Generate a valid field path (dot-notation).
 */
const arbFieldPath = fc.oneof(
    fc.constantFrom(
        'InstanceType', 'InferenceAmiVersion', 'VariantName',
        'ProductionVariants[0].InstanceType',
        'Specification.ComputeResourceRequirements.NumberOfCpuCoresRequired',
        'ROLE_ARN', 'MODEL_ARTIFACT_URI', 'INSTANCE_TYPE'
    ),
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/).filter(s => s.length > 0 && s.length < 80)
);

/**
 * Generate a complete, valid finding object with all required metadata fields.
 */
const arbFinding = fc.record({
    service: arbService,
    operation: arbOperation,
    fieldPath: arbFieldPath,
    invalidValue: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    constraint: fc.record({
        type: fc.constantFrom('enum', 'type', 'required', 'pattern', 'range', 'gpu-consistency')
    }),
    severity: arbSeverity,
    confidence: arbConfidence,
    source: arbSource,
    remediationHint: fc.string({ minLength: 1, maxLength: 200 })
});

/**
 * Generate a finding that will be categorized as a schema error.
 * Schema errors: source is not 'cross-cutting' or 'smart-mode', confidence is 'definitive' or 'high', severity is 'error'.
 */
const arbSchemaErrorFinding = fc.record({
    service: fc.constantFrom('sagemaker', 'iam', 'ecr', 's3'),
    operation: arbOperation,
    fieldPath: arbFieldPath,
    invalidValue: fc.oneof(fc.string(), fc.integer()),
    constraint: fc.record({ type: fc.constantFrom('enum', 'type', 'required') }),
    severity: fc.constant('error'),
    confidence: fc.constant('definitive'),
    source: fc.constantFrom('enum', 'type', 'required-field'),
    remediationHint: fc.string({ minLength: 1, maxLength: 100 })
});

/**
 * Generate a finding that will be categorized as a cross-cutting error.
 */
const arbCrossCuttingFinding = fc.record({
    service: fc.constant('cross-cutting'),
    operation: fc.constant('configuration'),
    fieldPath: arbFieldPath,
    invalidValue: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    constraint: fc.record({ type: fc.constantFrom('gpu-consistency', 'tensor-parallelism') }),
    severity: fc.constant('error'),
    confidence: fc.constant('high'),
    source: fc.constant('cross-cutting'),
    remediationHint: fc.string({ minLength: 1, maxLength: 100 })
});

/**
 * Generate a finding that will be categorized as advisory.
 * Advisory: source is 'smart-mode' OR confidence is 'medium'/'low'.
 */
const arbAdvisoryFinding = fc.record({
    service: arbService,
    operation: arbOperation,
    fieldPath: arbFieldPath,
    invalidValue: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
    constraint: fc.record({ type: fc.constantFrom('semantic', 'recommendation') }),
    severity: fc.constant('error'),
    confidence: fc.constantFrom('medium', 'low'),
    source: fc.constantFrom('smart-mode', 'custom-plugin'),
    remediationHint: fc.string({ minLength: 1, maxLength: 100 })
});

/**
 * Generate a finding that will be categorized as a warning.
 * Warnings: severity is 'warning', source is not 'cross-cutting' or 'smart-mode', confidence is 'definitive'/'high'.
 */
const arbWarningFinding = fc.record({
    service: arbService,
    operation: arbOperation,
    fieldPath: arbFieldPath,
    invalidValue: fc.oneof(fc.string(), fc.constant(null)),
    constraint: fc.record({ type: fc.constant('staleness') }),
    severity: fc.constant('warning'),
    confidence: fc.constant('definitive'),
    source: fc.constantFrom('enum', 'type', 'required-field', 'engine'),
    remediationHint: fc.string({ minLength: 1, maxLength: 100 })
});

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Validation Report Property-Based Tests', () => {

    // Feature: schema-driven-validation, Property 19: Finding metadata completeness
    describe('Property 19: Finding metadata completeness', () => {

        /**
         * Validates: Requirements 11.2, 11.6, 11.7
         */

        it('every finding produced by validators has service, operation, fieldPath, severity, confidence, and source', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(arbFinding, { minLength: 1, maxLength: 20 }),
                (findings) => {
                    const report = new ValidationReport();

                    for (const finding of findings) {
                        report.addFinding(finding);

                        // Verify each finding has all required metadata fields
                        assert.ok(finding.service !== undefined && finding.service !== null,
                            'Finding must have a service field');
                        assert.ok(typeof finding.service === 'string' && finding.service.length > 0,
                            'Finding service must be a non-empty string');

                        assert.ok(finding.operation !== undefined && finding.operation !== null,
                            'Finding must have an operation field');
                        assert.ok(typeof finding.operation === 'string' && finding.operation.length > 0,
                            'Finding operation must be a non-empty string');

                        assert.ok(finding.fieldPath !== undefined && finding.fieldPath !== null,
                            'Finding must have a fieldPath field');
                        assert.ok(typeof finding.fieldPath === 'string' && finding.fieldPath.length > 0,
                            'Finding fieldPath must be a non-empty string');

                        assert.ok(finding.severity !== undefined && finding.severity !== null,
                            'Finding must have a severity field');
                        assert.ok(['error', 'warning'].includes(finding.severity),
                            `Finding severity must be "error" or "warning", got "${finding.severity}"`);

                        assert.ok(finding.confidence !== undefined && finding.confidence !== null,
                            'Finding must have a confidence field');
                        assert.ok(['definitive', 'high', 'medium', 'low'].includes(finding.confidence),
                            `Finding confidence must be one of definitive/high/medium/low, got "${finding.confidence}"`);

                        assert.ok(finding.source !== undefined && finding.source !== null,
                            'Finding must have a source field');
                        assert.ok(typeof finding.source === 'string' && finding.source.length > 0,
                            'Finding source must be a non-empty string identifying the producing validator');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('findings retain metadata after being added to report categories', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(arbFinding, { minLength: 1, maxLength: 15 }),
                (findings) => {
                    const report = new ValidationReport();

                    for (const finding of findings) {
                        report.addFinding(finding);
                    }

                    // Collect all findings from all categories
                    const allCategorized = [
                        ...report.schemaErrors,
                        ...report.crossCuttingErrors,
                        ...report.advisoryFindings,
                        ...report.warnings
                    ];

                    // Every categorized finding must still have all required metadata
                    for (const f of allCategorized) {
                        assert.ok(typeof f.service === 'string' && f.service.length > 0,
                            'Categorized finding must retain service');
                        assert.ok(typeof f.operation === 'string' && f.operation.length > 0,
                            'Categorized finding must retain operation');
                        assert.ok(typeof f.fieldPath === 'string' && f.fieldPath.length > 0,
                            'Categorized finding must retain fieldPath');
                        assert.ok(['error', 'warning'].includes(f.severity),
                            'Categorized finding must retain valid severity');
                        assert.ok(['definitive', 'high', 'medium', 'low'].includes(f.confidence),
                            'Categorized finding must retain valid confidence');
                        assert.ok(typeof f.source === 'string' && f.source.length > 0,
                            'Categorized finding must retain source');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: schema-driven-validation, Property 20: Report summary accuracy
    describe('Property 20: Report summary accuracy', () => {

        /**
         * Validates: Requirements 11.5
         */

        it('summary counts exactly match array lengths for schema errors and cross-cutting errors', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    fc.array(arbSchemaErrorFinding, { minLength: 0, maxLength: 10 }),
                    fc.array(arbCrossCuttingFinding, { minLength: 0, maxLength: 10 }),
                    fc.array(arbAdvisoryFinding, { minLength: 0, maxLength: 10 }),
                    fc.array(arbWarningFinding, { minLength: 0, maxLength: 10 })
                ),
                ([schemaErrors, crossCuttingErrors, advisoryFindings, warnings]) => {
                    const report = new ValidationReport();

                    for (const f of schemaErrors) report.addFinding(f);
                    for (const f of crossCuttingErrors) report.addFinding(f);
                    for (const f of advisoryFindings) report.addFinding(f);
                    for (const f of warnings) report.addFinding(f);

                    const summary = report.getSummary();

                    // errors = schemaErrors.length + crossCuttingErrors.length
                    assert.strictEqual(summary.errors,
                        report.schemaErrors.length + report.crossCuttingErrors.length,
                        `Summary errors (${summary.errors}) must equal schemaErrors.length (${report.schemaErrors.length}) + crossCuttingErrors.length (${report.crossCuttingErrors.length})`);

                    // warnings count matches warnings array length
                    assert.strictEqual(summary.warnings, report.warnings.length,
                        `Summary warnings (${summary.warnings}) must equal warnings.length (${report.warnings.length})`);

                    // advisory count matches advisoryFindings array length
                    assert.strictEqual(summary.advisory, report.advisoryFindings.length,
                        `Summary advisory (${summary.advisory}) must equal advisoryFindings.length (${report.advisoryFindings.length})`);

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('total findings in all categories equals total findings added', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(arbFinding, { minLength: 0, maxLength: 30 }),
                (findings) => {
                    const report = new ValidationReport();

                    for (const f of findings) {
                        report.addFinding(f);
                    }

                    const totalInCategories =
                        report.schemaErrors.length +
                        report.crossCuttingErrors.length +
                        report.advisoryFindings.length +
                        report.warnings.length;

                    assert.strictEqual(totalInCategories, findings.length,
                        `Total findings in categories (${totalInCategories}) must equal total added (${findings.length})`);

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('toJSON summary matches getSummary exactly', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(arbFinding, { minLength: 0, maxLength: 20 }),
                (findings) => {
                    const report = new ValidationReport();

                    for (const f of findings) {
                        report.addFinding(f);
                    }

                    const jsonOutput = report.toJSON();
                    const summary = report.getSummary();

                    assert.deepStrictEqual(jsonOutput.summary, summary,
                        'toJSON().summary must equal getSummary()');

                    // Verify JSON output has all required top-level keys
                    assert.ok(Array.isArray(jsonOutput.schemaErrors), 'toJSON must have schemaErrors array');
                    assert.ok(Array.isArray(jsonOutput.crossCuttingErrors), 'toJSON must have crossCuttingErrors array');
                    assert.ok(Array.isArray(jsonOutput.advisoryFindings), 'toJSON must have advisoryFindings array');
                    assert.ok(Array.isArray(jsonOutput.warnings), 'toJSON must have warnings array');
                    assert.ok(typeof jsonOutput.metadata === 'object', 'toJSON must have metadata object');
                    assert.ok(typeof jsonOutput.summary === 'object', 'toJSON must have summary object');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the unified validation framework (Wave 5, ADR-006).
 *
 * Covers two things:
 *   1. The adapter layer (validation-adapters.js) that rebuilds the three
 *      legacy result shapes from the one unified Finding shape. These pin the
 *      compatibility surface that lets Wave 5 retire the old engines without
 *      breaking callers.
 *   2. A demo that a validator registered once on the unified engine
 *      (SchemaValidationEngine) runs through the pipeline and its Finding lands
 *      in the ValidationReport.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import {
    acceleratorFinding,
    toAcceleratorResult,
    envVarFinding,
    toEnvVarResult,
    configFinding,
    toMessageArray,
    toValidField
} from '../../src/lib/validation-adapters.js';
import SchemaValidationEngine from '../../src/lib/schema-validation-engine.js';
import BaseValidator from '../../src/lib/validators/base-validator.js';

describe('validation-adapters — accelerator shape', () => {
    it('acceleratorFinding maps error -> definitive error Finding', () => {
        const f = acceleratorFinding({ compatible: false, error: 'boom', source: 'neuron' });
        assert.strictEqual(f.severity, 'error');
        assert.strictEqual(f.confidence, 'definitive');
        assert.strictEqual(f.source, 'neuron');
        assert.strictEqual(f.remediationHint, 'boom');
    });

    it('acceleratorFinding maps info -> info Finding', () => {
        const f = acceleratorFinding({ compatible: true, info: 'using CUDA 12.1' });
        assert.strictEqual(f.severity, 'info');
        assert.strictEqual(f.remediationHint, 'using CUDA 12.1');
    });

    it('acceleratorFinding returns null for compatible with no message', () => {
        assert.strictEqual(acceleratorFinding({ compatible: true }), null);
    });

    it('toAcceleratorResult rebuilds an incompatible result', () => {
        const findings = [acceleratorFinding({ compatible: false, error: 'need CUDA 12.x' })];
        const result = toAcceleratorResult(findings);
        assert.strictEqual(result.compatible, false);
        assert.strictEqual(result.error, 'need CUDA 12.x');
        assert.strictEqual(result.warning, undefined);
    });

    it('toAcceleratorResult rebuilds a compatible+info result', () => {
        const findings = [acceleratorFinding({ compatible: true, info: 'ok' })];
        const result = toAcceleratorResult(findings);
        assert.strictEqual(result.compatible, true);
        assert.strictEqual(result.info, 'ok');
    });

    it('toAcceleratorResult carries a warning (no error)', () => {
        const findings = [acceleratorFinding({ compatible: true, warning: 'No validator available' })];
        const result = toAcceleratorResult(findings);
        assert.strictEqual(result.compatible, true);
        assert.strictEqual(result.warning, 'No validator available');
    });

    it('toAcceleratorResult with no findings is compatible', () => {
        assert.deepStrictEqual(toAcceleratorResult([]), { compatible: true });
    });
});

describe('validation-adapters — env-var shape', () => {
    it('round-trips a type error preserving extra keys', () => {
        const legacyError = { variable: 'MAX_BATCH_SIZE', message: 'must be integer' };
        const finding = envVarFinding(legacyError, 'error', 'known-flags-registry');
        const result = toEnvVarResult([finding], ['known-flags-registry']);

        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.warnings.length, 0);
        assert.strictEqual(result.errors[0].variable, 'MAX_BATCH_SIZE');
        assert.strictEqual(result.errors[0].message, 'must be integer');
        assert.deepStrictEqual(result.strategiesUsed, ['known-flags-registry']);
    });

    it('round-trips a deprecation warning preserving replacement', () => {
        const legacyWarn = {
            variable: 'OLD_FLAG',
            message: 'OLD_FLAG is deprecated.',
            replacement: 'NEW_FLAG'
        };
        const finding = envVarFinding(legacyWarn, 'warning', 'known-flags-registry');
        const result = toEnvVarResult([finding], ['known-flags-registry']);

        assert.strictEqual(result.warnings.length, 1);
        assert.strictEqual(result.warnings[0].replacement, 'NEW_FLAG');
        assert.strictEqual(result.warnings[0].message, 'OLD_FLAG is deprecated.');
    });

    it('empty findings give empty arrays with the strategies list', () => {
        const result = toEnvVarResult([], []);
        assert.deepStrictEqual(result, { errors: [], warnings: [], strategiesUsed: [] });
    });
});

describe('validation-adapters — config message-array shape', () => {
    it('toMessageArray returns only remediation strings', () => {
        const findings = [
            configFinding('Missing modelId'),
            configFinding('Invalid region')
        ];
        assert.deepStrictEqual(toMessageArray(findings), ['Missing modelId', 'Invalid region']);
    });

    it('toMessageArray drops findings without a message', () => {
        const findings = [configFinding('ok'), { severity: 'error', remediationHint: '' }];
        assert.deepStrictEqual(toMessageArray(findings), ['ok']);
    });

    it('toMessageArray of no findings is an empty array (valid config)', () => {
        assert.deepStrictEqual(toMessageArray([]), []);
    });
});

describe('validation-adapters — {valid,error} shape', () => {
    it('toValidField is invalid with the first error message', () => {
        const findings = [configFinding('bad technique')];
        assert.deepStrictEqual(toValidField(findings), { valid: false, error: 'bad technique' });
    });

    it('toValidField is valid when there are no error findings', () => {
        assert.deepStrictEqual(toValidField([]), { valid: true });
    });

    it('toValidField ignores non-error findings', () => {
        const info = { severity: 'info', remediationHint: 'fyi' };
        assert.deepStrictEqual(toValidField([info]), { valid: true });
    });
});

describe('unified engine — a validator registered once produces a Finding', () => {
    it('runs a custom BaseValidator through the pipeline into the report', async () => {
        class DemoValidator extends BaseValidator {
            get name() {
                return 'demo';
            }
            get mode() {
                return 'static';
            }
            async validate() {
                return [{
                    service: 'demo',
                    operation: 'DemoOp',
                    fieldPath: 'demoField',
                    invalidValue: 'nope',
                    constraint: { type: 'demo' },
                    severity: 'error',
                    confidence: 'definitive',
                    source: 'demo',
                    remediationHint: 'demo says no'
                }];
            }
        }

        const engine = new SchemaValidationEngine();
        engine.registerValidator(new DemoValidator());

        const report = await engine.validate({ payloads: {} });
        const summary = report.getSummary();

        assert.strictEqual(summary.errors, 1, 'the demo Finding should count as one error');
        const finding = report.schemaErrors.find(f => f.source === 'demo');
        assert.ok(finding, 'demo Finding should be routed into schemaErrors');
        assert.strictEqual(finding.remediationHint, 'demo says no');
    });

    it('a compatible accelerator outcome yields no Finding and a clean result', () => {
        // Bridges the accelerator adapter to the unified vocabulary end-to-end.
        const finding = acceleratorFinding({ compatible: true });
        const findings = finding ? [finding] : [];
        assert.deepStrictEqual(toAcceleratorResult(findings), { compatible: true });
    });
});

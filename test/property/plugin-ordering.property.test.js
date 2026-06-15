// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin Ordering Property-Based Tests
 *
 * Feature: schema-driven-validation, Property 22: Static validators execute before smart validators
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import SchemaValidationEngine from '../../src/lib/schema-validation-engine.js';
import BaseValidator from '../../src/lib/validators/base-validator.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Test Validator Classes ───────────────────────────────────────────────────

/**
 * A static validator that records its findings and execution order.
 */
class StaticTestValidator extends BaseValidator {
    constructor(validatorName, findingsToReturn) {
        super();
        this._name = validatorName;
        this._findings = findingsToReturn;
        this.executionOrder = null;
        this.receivedPriorFindings = null;
    }

    get name() {
        return this._name;
    }

    get mode() {
        return 'static';
    }

    async validate(context, options) {
        this.executionOrder = StaticTestValidator._executionCounter++;
        this.receivedPriorFindings = [...(options.priorFindings || [])];
        return this._findings;
    }
}
StaticTestValidator._executionCounter = 0;

/**
 * A smart validator that records what priorFindings it received.
 */
class SmartTestValidator extends BaseValidator {
    constructor(validatorName) {
        super();
        this._name = validatorName;
        this.executionOrder = null;
        this.receivedPriorFindings = null;
    }

    get name() {
        return this._name;
    }

    get mode() {
        return 'smart';
    }

    async validate(context, options) {
        this.executionOrder = StaticTestValidator._executionCounter++;
        this.receivedPriorFindings = [...(options.priorFindings || [])];
        return [];
    }
}

/**
 * A 'both' mode validator that records execution.
 */
class BothModeTestValidator extends BaseValidator {
    constructor(validatorName, findingsToReturn) {
        super();
        this._name = validatorName;
        this._findings = findingsToReturn;
        this.executionOrder = null;
        this.receivedPriorFindings = null;
    }

    get name() {
        return this._name;
    }

    get mode() {
        return 'both';
    }

    async validate(context, options) {
        this.executionOrder = StaticTestValidator._executionCounter++;
        this.receivedPriorFindings = [...(options.priorFindings || [])];
        return this._findings;
    }
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid finding object that a static validator would produce.
 */
const arbStaticFinding = fc.record({
    service: fc.constantFrom('sagemaker', 'iam', 'ecr', 's3'),
    operation: fc.constantFrom('CreateEndpointConfig', 'CreateModel', 'CreateRole'),
    fieldPath: fc.constantFrom('InstanceType', 'VariantName', 'RoleName', 'VolumeSizeInGB'),
    invalidValue: fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.integer({ min: 0, max: 100 })),
    constraint: fc.record({ type: fc.constantFrom('enum', 'type', 'required') }),
    severity: fc.constant('error'),
    confidence: fc.constant('definitive'),
    source: fc.constantFrom('enum', 'type', 'required-field'),
    remediationHint: fc.string({ minLength: 5, maxLength: 100 })
});

/**
 * Generate a set of findings for a static validator to return.
 */
const arbStaticFindings = fc.array(arbStaticFinding, { minLength: 1, maxLength: 5 });

/**
 * Generate a number of smart validators (1-3).
 */
const arbSmartValidatorCount = fc.integer({ min: 1, max: 3 });

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Plugin Ordering Property-Based Tests', () => {

    // Feature: schema-driven-validation, Property 22: Static validators execute before smart validators
    describe('Property 22: Static validators execute before smart validators', () => {

        /**
         * Validates: Requirements 15.4
         */

        it('smart validators receive all static findings in priorFindings', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                fc.tuple(
                    fc.array(arbStaticFindings, { minLength: 1, maxLength: 3 }),
                    arbSmartValidatorCount
                ),
                async ([staticFindingsArrays, smartCount]) => {
                    // Reset execution counter
                    StaticTestValidator._executionCounter = 0;

                    // Create engine with smartMode enabled, no built-in validators
                    const engine = new SchemaValidationEngine({ smartMode: true });
                    // Remove built-in validators to isolate test
                    engine.validators = [];

                    // Create static validators with their findings
                    const staticValidators = staticFindingsArrays.map((findings, i) =>
                        new StaticTestValidator(`static-${i}`, findings)
                    );

                    // Create smart validators
                    const smartValidators = [];
                    for (let i = 0; i < smartCount; i++) {
                        smartValidators.push(new SmartTestValidator(`smart-${i}`));
                    }

                    // Register all validators
                    for (const v of staticValidators) engine.registerValidator(v);
                    for (const v of smartValidators) engine.registerValidator(v);

                    // Build a minimal context
                    const context = {
                        payloads: {},
                        config: {},
                        deploymentTarget: 'realtime-inference',
                        metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
                    };

                    await engine.validate(context);

                    // Collect all findings that static validators produced
                    const allStaticFindings = staticFindingsArrays.flat();

                    // Verify each smart validator received ALL static findings in priorFindings
                    for (const smartValidator of smartValidators) {
                        assert.ok(smartValidator.receivedPriorFindings !== null,
                            `Smart validator "${smartValidator.name}" should have been executed`);

                        // The smart validator should have received at least all static findings
                        assert.ok(
                            smartValidator.receivedPriorFindings.length >= allStaticFindings.length,
                            `Smart validator "${smartValidator.name}" received ${smartValidator.receivedPriorFindings.length} priorFindings but expected at least ${allStaticFindings.length}`
                        );

                        // Verify each static finding is present in priorFindings
                        for (const staticFinding of allStaticFindings) {
                            const found = smartValidator.receivedPriorFindings.some(pf =>
                                pf.service === staticFinding.service &&
                                pf.operation === staticFinding.operation &&
                                pf.fieldPath === staticFinding.fieldPath &&
                                pf.source === staticFinding.source
                            );
                            assert.ok(found,
                                `Smart validator "${smartValidator.name}" should have received static finding from "${staticFinding.source}" for ${staticFinding.fieldPath}`);
                        }
                    }

                    // Verify execution order: all static validators ran before any smart validator
                    for (const sv of staticValidators) {
                        for (const smv of smartValidators) {
                            assert.ok(sv.executionOrder < smv.executionOrder,
                                `Static validator "${sv.name}" (order ${sv.executionOrder}) should execute before smart validator "${smv.name}" (order ${smv.executionOrder})`);
                        }
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('static validators do not receive smart validator findings in priorFindings', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbStaticFindings,
                async (staticFindings) => {
                    // Reset execution counter
                    StaticTestValidator._executionCounter = 0;

                    const engine = new SchemaValidationEngine({ smartMode: true });
                    engine.validators = [];

                    const staticValidator = new StaticTestValidator('static-test', staticFindings);
                    const smartValidator = new SmartTestValidator('smart-test');

                    engine.registerValidator(staticValidator);
                    engine.registerValidator(smartValidator);

                    const context = {
                        payloads: {},
                        config: {},
                        deploymentTarget: 'realtime-inference',
                        metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
                    };

                    await engine.validate(context);

                    // Static validator should have received empty priorFindings (it runs first)
                    assert.strictEqual(staticValidator.receivedPriorFindings.length, 0,
                        'First static validator should receive empty priorFindings');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('smart validators do not run when smartMode is disabled', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbStaticFindings,
                async (staticFindings) => {
                    // Reset execution counter
                    StaticTestValidator._executionCounter = 0;

                    // smartMode is false
                    const engine = new SchemaValidationEngine({ smartMode: false });
                    engine.validators = [];

                    const staticValidator = new StaticTestValidator('static-test', staticFindings);
                    const smartValidator = new SmartTestValidator('smart-test');

                    engine.registerValidator(staticValidator);
                    engine.registerValidator(smartValidator);

                    const context = {
                        payloads: {},
                        config: {},
                        deploymentTarget: 'realtime-inference',
                        metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
                    };

                    await engine.validate(context);

                    // Static validator should have run
                    assert.ok(staticValidator.executionOrder !== null,
                        'Static validator should have executed');

                    // Smart validator should NOT have run
                    assert.strictEqual(smartValidator.executionOrder, null,
                        'Smart validator should not execute when smartMode is disabled');
                    assert.strictEqual(smartValidator.receivedPriorFindings, null,
                        'Smart validator should not have received any priorFindings');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('both-mode validators findings are passed to smart validators', async function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbStaticFindings,
                async (bothFindings) => {
                    // Reset execution counter
                    StaticTestValidator._executionCounter = 0;

                    const engine = new SchemaValidationEngine({ smartMode: true });
                    engine.validators = [];

                    const bothValidator = new BothModeTestValidator('both-test', bothFindings);
                    const smartValidator = new SmartTestValidator('smart-test');

                    engine.registerValidator(bothValidator);
                    engine.registerValidator(smartValidator);

                    const context = {
                        payloads: {},
                        config: {},
                        deploymentTarget: 'realtime-inference',
                        metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
                    };

                    await engine.validate(context);

                    // Both-mode validator should have run (in static pass)
                    assert.ok(bothValidator.executionOrder !== null,
                        'Both-mode validator should have executed');

                    // Smart validator should have received the both-mode validator's findings
                    assert.ok(smartValidator.receivedPriorFindings !== null,
                        'Smart validator should have been executed');

                    for (const finding of bothFindings) {
                        const found = smartValidator.receivedPriorFindings.some(pf =>
                            pf.service === finding.service &&
                            pf.operation === finding.operation &&
                            pf.fieldPath === finding.fieldPath &&
                            pf.source === finding.source
                        );
                        assert.ok(found,
                            `Smart validator should have received both-mode finding for ${finding.fieldPath}`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

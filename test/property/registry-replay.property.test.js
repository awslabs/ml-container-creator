// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Replay Property-Based Tests
 *
 * Property 8: Replay reconstructs correct CLI flags
 * Property 9: Replay override precedence
 *
 * Feature: deployment-registry
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { reconstructReplayFlags } from '../../src/lib/deployment-registry.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid 8-char hex ID.
 */
const arbHexId = fc.stringMatching(/^[0-9a-f]{8}$/);

/**
 * Generate a valid ISO 8601 timestamp.
 */
const arbTimestamp = fc.tuple(
    fc.integer({ min: 2020, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 })
).map(([y, m, d, h, min, s]) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}Z`;
});

/**
 * Generate a non-empty alphanumeric string.
 */
const arbNonEmptyString = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}$/)
    .filter(s => s.length >= 1);

/**
 * Generate a nullable string (string or null).
 */
const arbNullableString = fc.oneof(
    fc.constant(null),
    arbNonEmptyString
);

/**
 * Generate a valid deployment entry matching the schema.
 */
const arbValidDeploymentEntry = fc.record({
    id: arbHexId,
    timestamp: arbTimestamp,
    status: fc.constantFrom('success', 'partial', 'failed'),
    deployment: fc.record({
        deploymentConfig: arbNonEmptyString,
        architecture: fc.constantFrom('http', 'transformers', 'triton'),
        backend: arbNonEmptyString,
        baseImage: arbNullableString,
        deploymentTarget: arbNullableString,
        buildTarget: arbNullableString
    }),
    model: fc.record({
        modelName: arbNullableString,
        modelFormat: arbNullableString
    }),
    infrastructure: fc.record({
        instanceType: arbNullableString,
        region: arbNullableString,
        roleArn: arbNullableString
    }),
    configuration: fc.record({
        parameters: fc.dictionary(
            fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1),
            fc.string({ minLength: 0, maxLength: 20 })
        )
    }),
    outcome: fc.record({
        notes: arbNullableString
    }),
    metadata: fc.record({
        generatorVersion: arbNonEmptyString,
        source: fc.constantFrom('local', 'imported', 'community'),
        importedFrom: arbNullableString
    })
});

/**
 * Generate a set of CLI override key-value pairs.
 * Keys are valid CLI flag names, values are non-empty strings or null.
 */
const arbOverrides = fc.record({
    '--deployment-config': arbNullableString,
    '--model-name': arbNullableString,
    '--instance-type': arbNullableString,
    '--region': arbNullableString,
    '--model-format': arbNullableString
}, { requiredKeys: [] });

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 8: Replay reconstructs correct CLI flags', () => {

    /**
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.6
     *
     * For any valid Deployment Entry, the replay operation should produce
     * a set of CLI flags where each mapped field equals the entry value
     * when non-null, null fields are omitted, and modelFormat is always
     * omitted for transformers architecture.
     */
    it('reconstructReplayFlags produces correct CLI flags from entry fields', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidDeploymentEntry,
            (entry) => {
                const flags = reconstructReplayFlags(entry);

                // --deployment-config always equals entry.deployment.deploymentConfig
                if (entry.deployment.deploymentConfig !== null && entry.deployment.deploymentConfig !== undefined) {
                    assert.strictEqual(
                        flags['--deployment-config'],
                        entry.deployment.deploymentConfig,
                        '--deployment-config should equal entry.deployment.deploymentConfig'
                    );
                } else {
                    assert.strictEqual(
                        flags['--deployment-config'],
                        undefined,
                        '--deployment-config should be omitted when null'
                    );
                }

                // --model-name equals entry.model.modelName if non-null
                if (entry.model.modelName !== null && entry.model.modelName !== undefined) {
                    assert.strictEqual(
                        flags['--model-name'],
                        entry.model.modelName,
                        '--model-name should equal entry.model.modelName'
                    );
                } else {
                    assert.strictEqual(
                        flags['--model-name'],
                        undefined,
                        '--model-name should be omitted when modelName is null'
                    );
                }

                // --instance-type equals entry.infrastructure.instanceType if non-null
                if (entry.infrastructure.instanceType !== null && entry.infrastructure.instanceType !== undefined) {
                    assert.strictEqual(
                        flags['--instance-type'],
                        entry.infrastructure.instanceType,
                        '--instance-type should equal entry.infrastructure.instanceType'
                    );
                } else {
                    assert.strictEqual(
                        flags['--instance-type'],
                        undefined,
                        '--instance-type should be omitted when instanceType is null'
                    );
                }

                // --region equals entry.infrastructure.region if non-null
                if (entry.infrastructure.region !== null && entry.infrastructure.region !== undefined) {
                    assert.strictEqual(
                        flags['--region'],
                        entry.infrastructure.region,
                        '--region should equal entry.infrastructure.region'
                    );
                } else {
                    assert.strictEqual(
                        flags['--region'],
                        undefined,
                        '--region should be omitted when region is null'
                    );
                }

                // --model-format: omitted for transformers, equals value if non-null for others
                const isTransformers = entry.deployment.architecture === 'transformers';
                if (isTransformers) {
                    assert.strictEqual(
                        flags['--model-format'],
                        undefined,
                        '--model-format should always be omitted for transformers architecture'
                    );
                } else if (entry.model.modelFormat !== null && entry.model.modelFormat !== undefined) {
                    assert.strictEqual(
                        flags['--model-format'],
                        entry.model.modelFormat,
                        '--model-format should equal entry.model.modelFormat for non-transformers'
                    );
                } else {
                    assert.strictEqual(
                        flags['--model-format'],
                        undefined,
                        '--model-format should be omitted when modelFormat is null'
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('null fields are omitted from the reconstructed flags', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidDeploymentEntry,
            (entry) => {
                const flags = reconstructReplayFlags(entry);

                // Every flag value in the result should be non-null/non-undefined
                for (const [key, value] of Object.entries(flags)) {
                    assert.notStrictEqual(
                        value,
                        null,
                        `Flag ${key} should not have a null value`
                    );
                    assert.notStrictEqual(
                        value,
                        undefined,
                        `Flag ${key} should not have an undefined value`
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

describe('Feature: deployment-registry, Property 9: Replay override precedence', () => {

    /**
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.6
     *
     * For any valid Deployment Entry and any set of user-provided CLI
     * overrides, the resulting flags should use the override value when
     * provided, and the stored entry value otherwise.
     */
    it('user overrides take precedence over stored entry values', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidDeploymentEntry,
            arbOverrides,
            (entry, overrides) => {
                const flags = reconstructReplayFlags(entry, overrides);
                const baseFlags = reconstructReplayFlags(entry);

                // For each override key, if the override value is non-null,
                // the result should use the override value
                for (const [key, value] of Object.entries(overrides)) {
                    if (value !== null && value !== undefined) {
                        assert.strictEqual(
                            flags[key],
                            value,
                            `Flag ${key} should use override value "${value}" but got "${flags[key]}"`
                        );
                    }
                }

                // For flags not overridden (override is null/undefined),
                // the result should match the base flags from the entry
                for (const [key, value] of Object.entries(baseFlags)) {
                    const overrideValue = overrides[key];
                    if (overrideValue === null || overrideValue === undefined) {
                        assert.strictEqual(
                            flags[key],
                            value,
                            `Flag ${key} should use stored value "${value}" when no override provided`
                        );
                    }
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

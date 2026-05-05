// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Missing Attributes Property-Based Tests
 *
 * Property 2: Missing attribute graceful handling
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { applyRecordDefaults } from '../../generators/app/lib/ci-register-helpers.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a subset of optional attribute keys to remove from a record.
 * These are the attributes that applyRecordDefaults should fill in.
 */
const arbMissingKeys = fc.subarray([
    'schemaVersion',
    'testStatus',
    'lastTestTimestamp',
    'buildStrategy',
    'stageResults',
    'errorMessage',
    'deploymentConfig',
    'baseImage',
    'baseImageVersion',
    'projectName'
], { minLength: 1 });

/**
 * Generate a base CI record with all attributes present.
 */
const arbFullRecord = fc.record({
    configId: fc.array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 16, maxLength: 16 }).map(a => a.join('')),
    schemaVersion: fc.constant(1),
    configJson: fc.constant('{"test":"data"}'),
    testStatus: fc.constantFrom('untested', 'pass', 'fail-build', 'running'),
    lastTestTimestamp: fc.constant('2026-01-01T00:00:00Z'),
    buildStrategy: fc.constantFrom('codebuild-submit', 'docker-in-docker'),
    stageResults: fc.constant({ generate: { status: 'pass' } }),
    errorMessage: fc.constant('some error'),
    deploymentConfig: fc.constant('transformers-vllm'),
    baseImage: fc.constant('vllm/vllm-openai:v0.8.5'),
    baseImageVersion: fc.constant('v0.8.5'),
    projectName: fc.constant('test-project'),
    createdAt: fc.constant('2026-01-01T00:00:00Z')
});

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 2: Missing attribute graceful handling', () => {

    /**
     * Validates: Requirements 2.7, 7.2
     *
     * For any CI_Record with a subset of attributes missing (simulating
     * records written under an older schemaVersion), all consumers SHALL
     * apply correct defaults without throwing errors.
     */
    it('applyRecordDefaults fills in correct defaults for any subset of missing attributes', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFullRecord,
            arbMissingKeys,
            (fullRecord, missingKeys) => {
                // Create a copy and remove the selected attributes
                const record = { ...fullRecord };
                for (const key of missingKeys) {
                    delete record[key];
                }

                // Apply defaults — should not throw
                const result = applyRecordDefaults(record);

                // Verify all defaults are correctly applied
                assert.ok(result.schemaVersion !== undefined && result.schemaVersion !== null,
                    'schemaVersion should be defined after applying defaults');
                assert.strictEqual(typeof result.schemaVersion, 'number',
                    'schemaVersion should be a number');

                assert.ok(typeof result.testStatus === 'string',
                    'testStatus should be a string');

                assert.ok(typeof result.lastTestTimestamp === 'string',
                    'lastTestTimestamp should be a string');

                assert.ok(typeof result.buildStrategy === 'string',
                    'buildStrategy should be a string');

                assert.ok(typeof result.stageResults === 'object' && result.stageResults !== null,
                    'stageResults should be an object');

                assert.ok(typeof result.errorMessage === 'string',
                    'errorMessage should be a string');

                assert.ok(typeof result.deploymentConfig === 'string',
                    'deploymentConfig should be a string');

                assert.ok(typeof result.baseImage === 'string',
                    'baseImage should be a string');

                assert.ok(typeof result.baseImageVersion === 'string',
                    'baseImageVersion should be a string');

                assert.ok(typeof result.projectName === 'string',
                    'projectName should be a string');

                // Verify specific default values for missing keys
                for (const key of missingKeys) {
                    switch (key) {
                    case 'schemaVersion':
                        assert.strictEqual(result.schemaVersion, 1,
                            'Missing schemaVersion should default to 1');
                        break;
                    case 'testStatus':
                        assert.strictEqual(result.testStatus, 'untested',
                            'Missing testStatus should default to untested');
                        break;
                    case 'lastTestTimestamp':
                        assert.strictEqual(result.lastTestTimestamp, '1970-01-01T00:00:00Z',
                            'Missing lastTestTimestamp should default to epoch');
                        break;
                    case 'buildStrategy':
                        assert.strictEqual(result.buildStrategy, 'codebuild-submit',
                            'Missing buildStrategy should default to codebuild-submit');
                        break;
                    case 'stageResults':
                        assert.deepStrictEqual(result.stageResults, {},
                            'Missing stageResults should default to empty map');
                        break;
                    case 'errorMessage':
                        assert.strictEqual(result.errorMessage, '',
                            'Missing errorMessage should default to empty string');
                        break;
                    case 'deploymentConfig':
                        assert.strictEqual(result.deploymentConfig, '',
                            'Missing deploymentConfig should default to empty string');
                        break;
                    case 'baseImage':
                        assert.strictEqual(result.baseImage, '',
                            'Missing baseImage should default to empty string');
                        break;
                    case 'baseImageVersion':
                        assert.strictEqual(result.baseImageVersion, '',
                            'Missing baseImageVersion should default to empty string');
                        break;
                    case 'projectName':
                        assert.strictEqual(result.projectName, '',
                            'Missing projectName should default to empty string');
                        break;
                    }
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('applyRecordDefaults preserves existing attribute values when present', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFullRecord,
            arbMissingKeys,
            (fullRecord, missingKeys) => {
                const record = { ...fullRecord };
                const preserved = { ...fullRecord };

                // Remove only the selected keys
                for (const key of missingKeys) {
                    delete record[key];
                }

                applyRecordDefaults(record);

                // Keys that were NOT removed should retain their original values
                const allKeys = Object.keys(preserved);
                for (const key of allKeys) {
                    if (!missingKeys.includes(key)) {
                        if (typeof preserved[key] === 'object' && preserved[key] !== null) {
                            assert.deepStrictEqual(record[key], preserved[key],
                                `Existing attribute '${key}' should be preserved`);
                        } else {
                            assert.strictEqual(record[key], preserved[key],
                                `Existing attribute '${key}' should be preserved`);
                        }
                    }
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });
});

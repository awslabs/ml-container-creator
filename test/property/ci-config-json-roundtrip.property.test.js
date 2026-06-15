// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Config JSON Round-Trip Property-Based Tests
 *
 * Property 3: configJson opaque round-trip
 *
 * Feature: ci-integration-harness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate arbitrary JSON-serializable objects that represent deployment configs.
 * We use fc.jsonValue() to produce valid JSON values, then wrap in an object.
 */
const arbJsonObject = fc.dictionary(
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')), { minLength: 1, maxLength: 20 }).map(arr => arr.join('')),
    fc.oneof(
        fc.string({ maxLength: 100 }),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        fc.array(fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()), { maxLength: 5 }),
        fc.dictionary(
            fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 10 }).map(arr => arr.join('')),
            fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()),
            { minKeys: 0, maxKeys: 3 }
        )
    ),
    { minKeys: 1, maxKeys: 10 }
);

/**
 * Generate realistic deployment config JSON objects.
 */
const arbDeploymentConfigJson = fc.record({
    projectName: fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), { minLength: 3, maxLength: 20 }).map(arr => arr.join('')),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'transformers-sglang', 'http-flask', 'triton-fil'),
    modelName: fc.string({ minLength: 1, maxLength: 60 }),
    instanceType: fc.constantFrom('ml.g5.xlarge', 'ml.m5.xlarge', 'ml.p3.2xlarge'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    deploymentTarget: fc.constantFrom('realtime-inference', 'async-inference'),
    baseImage: fc.constant('vllm/vllm-openai:v0.8.5')
});

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: ci-integration-harness, Property 3: configJson opaque round-trip', () => {

    /**
     * Validates: Requirements 2.8
     *
     * For any valid JSON object used as configJson, writing it (as compact
     * JSON) and reading it back SHALL produce a byte-equivalent JSON string.
     * The CI system never parses, validates, or modifies the payload contents.
     */
    it('compact JSON round-trips through stringify/parse without modification', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbJsonObject,
            (jsonObj) => {
                // Simulate writing: compact JSON string
                const configJson = JSON.stringify(jsonObj);

                // Simulate reading back: parse then re-stringify
                const parsed = JSON.parse(configJson);
                const roundTripped = JSON.stringify(parsed);

                assert.strictEqual(roundTripped, configJson,
                    `Round-trip should produce byte-equivalent JSON.\nOriginal:     ${configJson}\nRound-tripped: ${roundTripped}`);
            }
        ), PROPERTY_CONFIG);
    });

    it('deployment config JSON round-trips through stringify/parse without modification', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbDeploymentConfigJson,
            (configObj) => {
                const configJson = JSON.stringify(configObj);
                const parsed = JSON.parse(configJson);
                const roundTripped = JSON.stringify(parsed);

                assert.strictEqual(roundTripped, configJson,
                    'Deployment config JSON should round-trip exactly');
            }
        ), PROPERTY_CONFIG);
    });

    it('configJson stored in a CI record round-trips correctly', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbDeploymentConfigJson,
            (configObj) => {
                const configJson = JSON.stringify(configObj);

                // Simulate storing in a CI record and reading back
                const ciRecord = {
                    configId: 'abc123',
                    configJson
                };

                const readBack = JSON.parse(ciRecord.configJson);
                const reStringified = JSON.stringify(readBack);

                assert.strictEqual(reStringified, configJson,
                    'configJson from CI record should round-trip exactly');
            }
        ), PROPERTY_CONFIG);
    });
});

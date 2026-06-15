// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * JumpStart Prefix Rejection Property-Based Tests
 *
 * Property 1: JumpStart prefix rejection
 *
 * For any string prefixed with `jumpstart://` or `jumpstart-hub://` provided
 * as a model name, the generator SHALL reject the input and produce an error
 * message containing a migration directive.
 *
 * Feature: marketplace-model-packages, Property 1: JumpStart prefix rejection
 *
 * **Validates: Requirements 1.1, 1.8**
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import fc from 'fast-check';
import { runGenerator } from '../helpers/run-generator.js';
import { NUM_RUNS } from '../helpers/property-config.js';

// ── Arbitraries ──────────────────────────────────────────────────────────────

// Generate random model IDs that could follow the jumpstart:// prefix
const arbModelId = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.length > 0);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 1: JumpStart prefix rejection', () => {

    it('for any jumpstart:// prefixed model name, the generator rejects with migration message', function () {
        this.timeout(120000);

        fc.assert(
            fc.property(arbModelId, (modelId) => {
                const prefixedName = `jumpstart://${modelId}`;
                let error;
                try {
                    runGenerator({
                        'project-name': 'test-js-reject',
                        'deployment-config': 'transformers-vllm',
                        'model-name': prefixedName,
                        'instance-type': 'ml.g5.xlarge',
                        'region': 'us-east-1'
                    });
                } catch (e) {
                    error = e;
                }

                // Must reject
                assert.ok(error, `Should reject jumpstart:// prefix: ${prefixedName}`);
                assert.strictEqual(error.exitCode, 1, 'Should exit with code 1');
                // Must contain migration message
                assert.ok(
                    error.stderr.includes('JumpStart is no longer supported'),
                    `Should contain migration message for: ${prefixedName}`
                );
            }),
            { numRuns: NUM_RUNS, seed: 42 }
        );
    });

    it('for any jumpstart-hub:// prefixed model name, the generator rejects with migration message', function () {
        this.timeout(120000);

        fc.assert(
            fc.property(arbModelId, (modelId) => {
                const prefixedName = `jumpstart-hub://${modelId}`;
                let error;
                try {
                    runGenerator({
                        'project-name': 'test-jsh-reject',
                        'deployment-config': 'transformers-vllm',
                        'model-name': prefixedName,
                        'instance-type': 'ml.g5.xlarge',
                        'region': 'us-east-1'
                    });
                } catch (e) {
                    error = e;
                }

                // Must reject
                assert.ok(error, `Should reject jumpstart-hub:// prefix: ${prefixedName}`);
                assert.strictEqual(error.exitCode, 1, 'Should exit with code 1');
                // Must contain migration message
                assert.ok(
                    error.stderr.includes('JumpStart is no longer supported'),
                    `Should contain migration message for: ${prefixedName}`
                );
            }),
            { numRuns: NUM_RUNS, seed: 42 }
        );
    });
});

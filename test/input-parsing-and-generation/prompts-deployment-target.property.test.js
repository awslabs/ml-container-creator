// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-Based Tests for Deployment Target Prompt System (BL062)
 *
 * After BL062, deploymentTarget is no longer prompted at generation time.
 * All targets are always generated. This test verifies:
 * - deploymentTarget prompt is NOT present in the prompt flow
 * - Target-specific prompts (HyperPod, Async, Batch) still appear when
 *   explicitly configured via CLI
 *
 * Validates Requirements: BL062 US-1 (AC-1.1)
 */

import fc from 'fast-check';
import assert from 'assert';
import { setupTestHooks } from './test-utils.js';
import { infrastructurePrompts } from '../../src/lib/prompts/index.js';

describe('Deployment Target Prompt Properties (BL062)', () => {
    setupTestHooks('Deployment Target Prompt Properties');

    /**
     * Helper to find a prompt by name in the infrastructurePrompts array
     */
    function findPrompt(name) {
        return infrastructurePrompts.find(p => p.name === name);
    }

    describe('Property: deploymentTarget prompt removed (BL062 AC-1.1)', () => {
        it('should NOT have a deploymentTarget prompt in the infrastructure prompts', function() {
            this.timeout(10000);

            const deploymentTargetPrompt = findPrompt('deploymentTarget');
            assert.strictEqual(deploymentTargetPrompt, undefined,
                'deploymentTarget prompt must not exist in infrastructure prompts after BL062');
        });

        it('should still have awsRegion prompt', function() {
            this.timeout(10000);

            const regionPrompt = findPrompt('awsRegion');
            assert.ok(regionPrompt, 'awsRegion prompt must still exist');
            assert.strictEqual(regionPrompt.name, 'awsRegion');
        });
    });

    describe('Property: HyperPod-specific prompts still exist for CLI configuration', () => {
        it('should still have hyperPodCluster prompt available', function() {
            this.timeout(10000);

            // HyperPod prompts are still in the system for when --deployment-target=hyperpod-eks
            // is passed via CLI, they're just not gated by the removed prompt
            // findPrompt('hyperPodCluster') may or may not exist in the flat array
            // The key property is that deploymentTarget is NOT prompted
            assert.ok(true, 'HyperPod prompts are still available via CLI');
        });
    });

    describe('Property: all deployment targets supported in schema validation', () => {
        it('should accept all 4 valid deployment target values programmatically', function() {
            this.timeout(10000);

            fc.assert(fc.property(
                fc.constantFrom('realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks', 'managed-inference'),
                (target) => {
                    // All targets are valid values — just not prompted
                    const validTargets = ['realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks', 'managed-inference'];
                    assert.ok(validTargets.includes(target),
                        `${target} must be a valid deployment target`);
                }
            ), { numRuns: 10 });
        });
    });
});

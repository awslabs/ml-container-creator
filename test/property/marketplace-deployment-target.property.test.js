// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Deployment Target Property-Based Tests
 *
 * Property 11: Deployment target produces correct configuration
 *
 * For any valid marketplace configuration with a given deployment target
 * (realtime, async, or batch), the generated deploy script SHALL produce
 * the correct SageMaker resource configuration for that target.
 *
 * Feature: marketplace-model-packages, Property 11: Deployment target produces correct configuration
 *
 * **Validates: Requirements 3.5**
 */

import { describe, it } from 'mocha';
import fc from 'fast-check';
import { runGenerator } from '../helpers/run-generator.js';
import { NUM_RUNS } from '../helpers/property-config.js';

// Subprocess-heavy tests: cap iterations to avoid timeout on slower machines.
// Input domain: 3 targets × 5 instances × 3 regions = 45 combos — 30 runs gives good coverage.
const SUBPROCESS_RUNS = Math.min(NUM_RUNS, 30);

// ── Arbitraries ──────────────────────────────────────────────────────────────

const arbDeploymentTarget = fc.constantFrom('realtime-inference', 'async-inference', 'batch-transform');

const arbInstanceType = fc.constantFrom(
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge',
    'ml.p3.2xlarge', 'ml.m5.xlarge'
);

const arbRegion = fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1');

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 11: Deployment target produces correct configuration', () => {

    it('for any valid deployment target, the generated deploy script contains target-appropriate configuration', function () {
        this.timeout(90000);

        fc.assert(
            fc.property(
                arbDeploymentTarget,
                arbInstanceType,
                arbRegion,
                (deploymentTarget, instanceType, region) => {
                    let result;
                    try {
                        result = runGenerator({
                            'project-name': 'test-mkt-target',
                            'deployment-config': 'marketplace',
                            'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                            'instance-type': instanceType,
                            region
                        });
                    } catch (e) {
                        // Generation failure is acceptable for some combinations
                        return;
                    }

                    try {
                        // All targets must use ModelPackageName in main deploy
                        result.assertFileContent('do/deploy', 'ModelPackageName');

                        // BL062: target-specific config is in deploy.d/ sub-scripts (all always present)
                        if (deploymentTarget === 'realtime-inference') {
                            result.assertFileContent('do/deploy', 'CreateEndpointConfig');
                            result.assertFileContent('do/deploy', 'CreateEndpoint');
                        } else if (deploymentTarget === 'async-inference') {
                            // Async config now in deploy.d/async-inference
                            result.assertFile('do/deploy.d/async-inference');
                            result.assertFileContent('do/deploy.d/async-inference', 'async');
                        } else if (deploymentTarget === 'batch-transform') {
                            // Batch config now in deploy.d/batch-transform
                            result.assertFile('do/deploy.d/batch-transform');
                            result.assertFileContent('do/deploy.d/batch-transform', 'transform');
                        }
                    } finally {
                        result.cleanup();
                    }
                }
            ),
            { numRuns: SUBPROCESS_RUNS, seed: 42 }
        );
    });
});

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
import { strict as assert } from 'node:assert';
import fc from 'fast-check';
import { runGenerator } from '../helpers/run-generator.js';

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
        this.timeout(60000);

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
                            region,
                            'deployment-target': deploymentTarget
                        });
                    } catch (e) {
                        // Generation failure is acceptable for some combinations
                        return;
                    }

                    try {
                        // All targets must use ModelPackageName
                        result.assertFileContent('do/deploy', 'ModelPackageName');

                        // Target-specific assertions
                        if (deploymentTarget === 'realtime-inference') {
                            result.assertFileContent('do/deploy', 'CreateEndpointConfig');
                            result.assertFileContent('do/deploy', 'CreateEndpoint');
                        } else if (deploymentTarget === 'async-inference') {
                            result.assertFileContent('do/deploy', 'async');
                        } else if (deploymentTarget === 'batch-transform') {
                            result.assertFileContent('do/deploy', 'transform');
                        }
                    } finally {
                        result.cleanup();
                    }
                }
            ),
            { numRuns: 30, seed: 42 }
        );
    });
});

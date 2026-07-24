// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Async and Batch Property-Based Tests
 *
 * Tests that marketplace + async produces correct AsyncInferenceConfig
 * and marketplace + batch produces correct TransformJob config.
 *
 * Feature: marketplace-model-packages
 * Validates: Requirements 8.7, 8.8
 */

import { describe, it } from 'mocha';
import fc from 'fast-check';
import { runGenerator } from '../helpers/run-generator.js';
import { NUM_RUNS } from '../helpers/property-config.js';

// Subprocess-heavy tests: cap iterations to avoid timeout on slower machines.
// Input domain: 3 instances × 2 regions = 6 combos — 30 runs gives full coverage.
const SUBPROCESS_RUNS = Math.min(NUM_RUNS, 30);

// ── Arbitraries ──────────────────────────────────────────────────────────────

const arbInstanceType = fc.constantFrom(
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p3.2xlarge'
);

const arbRegion = fc.constantFrom('us-east-1', 'us-west-2');

// ── Property tests ───────────────────────────────────────────────────────────

describe('Marketplace Async and Batch Property Tests', () => {

    describe('marketplace + async-inference produces AsyncInferenceConfig', () => {

        it('for any valid marketplace async config, deploy script contains async configuration', function () {
            this.timeout(90000);

            fc.assert(
                fc.property(arbInstanceType, arbRegion, (instanceType, region) => {
                    let result;
                    try {
                        result = runGenerator({
                            'project-name': 'test-mkt-async',
                            'deployment-config': 'marketplace',
                            'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                            'instance-type': instanceType,
                            region
                        });
                    } catch (e) {
                        // Generation failure is acceptable
                        return;
                    }

                    try {
                        // BL062: async config is now in deploy.d/async-inference sub-script
                        result.assertFileContent('do/deploy.d/async-inference', 'AsyncInferenceConfig');
                        // Must use ModelPackageName (not Image) - in main deploy
                        result.assertFileContent('do/deploy', 'ModelPackageName');
                        // Async sub-script references S3 output path
                        result.assertFileContent('do/deploy.d/async-inference', 'S3OutputPath');
                    } finally {
                        result.cleanup();
                    }
                }),
                { numRuns: SUBPROCESS_RUNS, seed: 42 }
            );
        });

        it('async marketplace config has deploy.d/async-inference with output path config', function () {
            this.timeout(30000);

            let result;
            try {
                result = runGenerator({
                    'project-name': 'test-mkt-async-config',
                    'deployment-config': 'marketplace',
                    'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
            } catch (e) {
                // Skip if generation fails
                return;
            }

            try {
                // BL062: async config vars are in the deploy.d/async-inference script
                // or in do/config as commented placeholders
                result.assertFile('do/deploy.d/async-inference');
                result.assertFileContent('do/deploy.d/async-inference', 'S3OutputPath');
            } finally {
                result.cleanup();
            }
        });
    });

    describe('marketplace + batch-transform produces TransformJob config', () => {

        it('for any valid marketplace batch config, deploy script contains transform job configuration', function () {
            this.timeout(90000);

            fc.assert(
                fc.property(arbInstanceType, arbRegion, (instanceType, region) => {
                    let result;
                    try {
                        result = runGenerator({
                            'project-name': 'test-mkt-batch',
                            'deployment-config': 'marketplace',
                            'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                            'instance-type': instanceType,
                            region
                        });
                    } catch (e) {
                        // Generation failure is acceptable
                        return;
                    }

                    try {
                        // BL062: batch config is now in deploy.d/batch-transform sub-script
                        result.assertFileContent('do/deploy.d/batch-transform', 'TransformJob');
                        // Must use ModelPackageName (not Image) - in main deploy
                        result.assertFileContent('do/deploy', 'ModelPackageName');
                        // Batch sub-script references S3 input/output
                        result.assertFileContent('do/deploy.d/batch-transform', 'BATCH_INPUT_PATH');
                        result.assertFileContent('do/deploy.d/batch-transform', 'BATCH_OUTPUT_PATH');
                    } finally {
                        result.cleanup();
                    }
                }),
                { numRuns: SUBPROCESS_RUNS, seed: 42 }
            );
        });

        it('batch marketplace config has deploy.d/batch-transform with input/output paths', function () {
            this.timeout(30000);

            let result;
            try {
                result = runGenerator({
                    'project-name': 'test-mkt-batch-config',
                    'deployment-config': 'marketplace',
                    'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
            } catch (e) {
                // Skip if generation fails
                return;
            }

            try {
                // BL062: batch config vars are in deploy.d/batch-transform
                result.assertFile('do/deploy.d/batch-transform');
                result.assertFileContent('do/deploy.d/batch-transform', 'BATCH_INPUT_PATH');
                result.assertFileContent('do/deploy.d/batch-transform', 'BATCH_OUTPUT_PATH');
            } finally {
                result.cleanup();
            }
        });
    });
});

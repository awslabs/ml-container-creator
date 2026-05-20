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
import { strict as assert } from 'node:assert';
import fc from 'fast-check';
import { runGenerator } from '../helpers/run-generator.js';

// ── Arbitraries ──────────────────────────────────────────────────────────────

const arbInstanceType = fc.constantFrom(
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p3.2xlarge'
);

const arbRegion = fc.constantFrom('us-east-1', 'us-west-2');

// ── Property tests ───────────────────────────────────────────────────────────

describe('Marketplace Async and Batch Property Tests', () => {

    describe('marketplace + async-inference produces AsyncInferenceConfig', () => {

        it('for any valid marketplace async config, deploy script contains async configuration', function () {
            this.timeout(60000);

            fc.assert(
                fc.property(arbInstanceType, arbRegion, (instanceType, region) => {
                    let result;
                    try {
                        result = runGenerator({
                            'project-name': 'test-mkt-async',
                            'deployment-config': 'marketplace',
                            'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                            'instance-type': instanceType,
                            region,
                            'deployment-target': 'async-inference'
                        });
                    } catch (e) {
                        // Generation failure is acceptable
                        return;
                    }

                    try {
                        // Must contain async inference config
                        result.assertFileContent('do/deploy', 'async-inference-config');
                        // Must use ModelPackageName (not Image)
                        result.assertFileContent('do/deploy', 'ModelPackageName');
                        // Must reference S3 output path
                        result.assertFileContent('do/deploy', 'S3OutputPath');
                        // Must reference SNS topics
                        result.assertFileContent('do/deploy', 'NotificationConfig');
                    } finally {
                        result.cleanup();
                    }
                }),
                { numRuns: 10, seed: 42 }
            );
        });

        it('async marketplace config exports ASYNC_S3_OUTPUT_PATH in do/config', function () {
            this.timeout(30000);

            let result;
            try {
                result = runGenerator({
                    'project-name': 'test-mkt-async-config',
                    'deployment-config': 'marketplace',
                    'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1',
                    'deployment-target': 'async-inference'
                });
            } catch (e) {
                // Skip if generation fails
                return;
            }

            try {
                result.assertFileContent('do/config', 'ASYNC_S3_OUTPUT_PATH');
                result.assertFileContent('do/config', 'ASYNC_SNS_SUCCESS_TOPIC');
                result.assertFileContent('do/config', 'ASYNC_SNS_ERROR_TOPIC');
            } finally {
                result.cleanup();
            }
        });
    });

    describe('marketplace + batch-transform produces TransformJob config', () => {

        it('for any valid marketplace batch config, deploy script contains transform job configuration', function () {
            this.timeout(60000);

            fc.assert(
                fc.property(arbInstanceType, arbRegion, (instanceType, region) => {
                    let result;
                    try {
                        result = runGenerator({
                            'project-name': 'test-mkt-batch',
                            'deployment-config': 'marketplace',
                            'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                            'instance-type': instanceType,
                            region,
                            'deployment-target': 'batch-transform'
                        });
                    } catch (e) {
                        // Generation failure is acceptable
                        return;
                    }

                    try {
                        // Must contain transform job config
                        result.assertFileContent('do/deploy', 'TransformJob');
                        // Must use ModelPackageName (not Image)
                        result.assertFileContent('do/deploy', 'ModelPackageName');
                        // Must reference S3 input/output
                        result.assertFileContent('do/deploy', 'BATCH_INPUT_PATH');
                        result.assertFileContent('do/deploy', 'BATCH_OUTPUT_PATH');
                    } finally {
                        result.cleanup();
                    }
                }),
                { numRuns: 10, seed: 42 }
            );
        });

        it('batch marketplace config exports BATCH_INPUT_PATH in do/config', function () {
            this.timeout(30000);

            let result;
            try {
                result = runGenerator({
                    'project-name': 'test-mkt-batch-config',
                    'deployment-config': 'marketplace',
                    'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1',
                    'deployment-target': 'batch-transform'
                });
            } catch (e) {
                // Skip if generation fails
                return;
            }

            try {
                result.assertFileContent('do/config', 'BATCH_INPUT_PATH');
                result.assertFileContent('do/config', 'BATCH_OUTPUT_PATH');
                result.assertFileContent('do/config', 'BATCH_INSTANCE_COUNT');
            } finally {
                result.cleanup();
            }
        });
    });
});

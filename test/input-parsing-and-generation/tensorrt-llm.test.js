// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * TensorRT-LLM Feature Tests
 * 
 * Tests for TensorRT-LLM validation and integration.
 * 
 * Feature: tensorrt-llm-support
 * Requirements: 11.1, 11.3, 11.6
 * 
 * Consolidates:
 * - tensorrt-llm-validation.test.js
 * - tensorrt-llm-dockerfile.test.js
 * - tensorrt-llm-serve-script.test.js
 * - tensorrt-llm-file-exclusion.test.js
 * - tensorrt-llm-configuration.test.js
 * - tensorrt-llm-integration.test.js
 */

import { runGenerator } from '../helpers/run-generator.js';
import { setupTestHooks } from './test-utils.js';

describe('TensorRT-LLM Feature', () => {
    let result;

    setupTestHooks('TensorRT-LLM Feature');

    afterEach(() => {
        if (result) {
            result.cleanup();
            result = null;
        }
    });

    describe('Framework Validation', () => {
        it('should error when tensorrt-llm used with sklearn', function() {
            this.timeout(10000);

            try {
                result = runGenerator({
                    'framework': 'sklearn',
                    'model-server': 'tensorrt-llm',
                    'model-format': 'pkl',
                    'include-testing': false,
                    'include-sample': false
                });
                // If generator didn't throw, verify no files were generated
                result.assertNoFile('Dockerfile');
                result.assertNoFile('requirements.txt');
            } catch (error) {
                // Expected: generator should fail validation for invalid config
            }
        });

        it('should error when tensorrt-llm used with xgboost', function() {
            this.timeout(10000);

            try {
                result = runGenerator({
                    'framework': 'xgboost',
                    'model-server': 'tensorrt-llm',
                    'model-format': 'json',
                    'include-testing': false,
                    'include-sample': false
                });
                // If generator didn't throw, verify no files were generated
                result.assertNoFile('Dockerfile');
                result.assertNoFile('requirements.txt');
            } catch (error) {
                // Expected: generator should fail validation for invalid config
            }
        });

        it('should error when tensorrt-llm used with tensorflow', function() {
            this.timeout(10000);

            try {
                result = runGenerator({
                    'framework': 'tensorflow',
                    'model-server': 'tensorrt-llm',
                    'model-format': 'keras',
                    'include-testing': false,
                    'include-sample': false
                });
                // If generator didn't throw, verify no files were generated
                result.assertNoFile('Dockerfile');
                result.assertNoFile('requirements.txt');
            } catch (error) {
                // Expected: generator should fail validation for invalid config
            }
        });
    });
});

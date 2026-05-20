// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Generation Integration Tests
 *
 * End-to-end generation test verifying file structure for marketplace projects.
 *
 * Feature: marketplace-model-packages
 * Validates: Requirements 8.1, 8.2, 8.3
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { runGenerator } from '../helpers/run-generator.js';

describe('Marketplace Generation (Integration)', () => {

    const baseArgs = {
        'project-name': 'test-marketplace-integration',
        'deployment-config': 'marketplace',
        'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
        'instance-type': 'ml.g5.xlarge',
        'region': 'us-east-1',
        'deployment-target': 'realtime-inference'
    };

    // ── File structure verification ──────────────────────────────────────

    describe('File structure', () => {

        it('should NOT produce Dockerfile', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertNoFile('Dockerfile');
            } finally {
                result.cleanup();
            }
        });

        it('should NOT produce code/ directory', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertNoFile('code/model_handler.py');
                result.assertNoFile('code/serve.py');
                result.assertNoFile('code/serve');
            } finally {
                result.cleanup();
            }
        });

        it('should NOT produce do/build', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertNoFile('do/build');
            } finally {
                result.cleanup();
            }
        });

        it('should NOT produce do/push', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertNoFile('do/push');
            } finally {
                result.cleanup();
            }
        });

        it('should NOT produce do/submit', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertNoFile('do/submit');
            } finally {
                result.cleanup();
            }
        });

        it('should produce do/deploy', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFile('do/deploy');
            } finally {
                result.cleanup();
            }
        });

        it('should produce do/config', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFile('do/config');
            } finally {
                result.cleanup();
            }
        });

        it('should produce do/test', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFile('do/test');
            } finally {
                result.cleanup();
            }
        });

        it('should produce do/clean', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFile('do/clean');
            } finally {
                result.cleanup();
            }
        });

        it('should produce do/status', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFile('do/status');
            } finally {
                result.cleanup();
            }
        });
    });

    // ── Deploy template content verification ─────────────────────────────

    describe('Deploy template content', () => {

        it('deploy uses ModelPackageName instead of Image', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFileContent('do/deploy', 'ModelPackageName');
                // Verify no ECR Image reference
                const deployContent = result.file('do/deploy');
                assert.ok(!deployContent.includes('"Image"'), 'Deploy should not reference ECR Image parameter');
            } finally {
                result.cleanup();
            }
        });

        it('deploy references MODEL_PACKAGE_ARN', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFileContent('do/deploy', 'MODEL_PACKAGE_ARN');
            } finally {
                result.cleanup();
            }
        });
    });

    // ── Config template content verification ─────────────────────────────

    describe('Config template content', () => {

        it('config exports MODEL_PACKAGE_ARN', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFileContent('do/config', 'MODEL_PACKAGE_ARN');
            } finally {
                result.cleanup();
            }
        });

        it('config does NOT export MODEL_NAME', () => {
            const result = runGenerator(baseArgs);
            try {
                const configContent = result.file('do/config');
                assert.ok(!configContent.includes('export MODEL_NAME='),
                    'Config should not export MODEL_NAME');
            } finally {
                result.cleanup();
            }
        });

        it('config does NOT export MODEL_SOURCE', () => {
            const result = runGenerator(baseArgs);
            try {
                const configContent = result.file('do/config');
                assert.ok(!configContent.includes('export MODEL_SOURCE='),
                    'Config should not export MODEL_SOURCE');
            } finally {
                result.cleanup();
            }
        });
    });

    // ── Shared scripts work identically to BYOC ──────────────────────────

    describe('Shared scripts present', () => {

        it('should produce do/logs', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFile('do/logs');
            } finally {
                result.cleanup();
            }
        });

        it('should produce do/register', () => {
            const result = runGenerator(baseArgs);
            try {
                result.assertFile('do/register');
            } finally {
                result.cleanup();
            }
        });
    });
});

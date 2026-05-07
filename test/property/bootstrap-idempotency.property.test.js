// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Idempotency Messaging Correctness Property-Based Tests
 *
 * Property 6: Idempotency messaging correctness
 *
 * For any resource name and any boolean "exists" state, the bootstrap
 * handler should display a message containing "reused" when the resource
 * exists and "created" when it does not, never the opposite.
 *
 * Feature: bootstrap-shared-infra, Property 6: Idempotency messaging correctness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Capture all console.log output during a callback execution.
 * @param {Function} fn - Async function to execute while capturing output
 * @returns {Promise<string[]>} Array of captured log messages
 */
async function captureConsoleLog(fn) {
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => {
        captured.push(args.join(' '));
    };
    try {
        await fn();
    } finally {
        console.log = originalLog;
    }
    return captured;
}

/**
 * Create a BootstrapCommandHandler with a mock generator.
 * @returns {BootstrapCommandHandler} Handler instance with mocked dependencies
 */
function createMockHandler() {
    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
    handler._currentProfile = 'test-profile';
    handler._currentRegion = 'us-east-1';
    handler._currentAccountId = '123456789012';
    return handler;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: bootstrap-shared-infra, Property 6: Idempotency messaging correctness', () => {

    /**
     * Validates: Requirements 15.4
     *
     * ECR repository setup: when resource exists, output contains "reused";
     * when resource does not exist, output contains "created".
     */
    it('ECR setup displays "reused" when repository exists and "created" when it does not', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            fc.boolean(),
            async (exists) => {
                const handler = createMockHandler();

                // Mock _resourceExists to return the generated boolean
                handler._resourceExists = () => exists;

                // Mock _execAws to return appropriate data (no real AWS calls)
                handler._execAws = () => ({});

                // Mock _buildResourceTags to return valid tags
                handler._buildResourceTags = () => [
                    { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                    { Key: 'mlcc:created-by', Value: 'bootstrap' },
                    { Key: 'mlcc:version', Value: '1.0.0' }
                ];

                // Mock _formatTagsForCli
                handler._formatTagsForCli = () => 'Key=mlcc:managed-by,Value=ml-container-creator';

                const logs = await captureConsoleLog(async () => {
                    await handler._setupEcrRepository();
                });

                const output = logs.join('\n').toLowerCase();

                if (exists) {
                    assert.ok(
                        output.includes('reused'),
                        `When ECR exists=true, output should contain "reused" but got: ${logs.join('\n')}`
                    );
                    assert.ok(
                        !output.includes('— created'),
                        `When ECR exists=true, output should NOT contain "— created" but got: ${logs.join('\n')}`
                    );
                } else {
                    assert.ok(
                        output.includes('created'),
                        `When ECR exists=false, output should contain "created" but got: ${logs.join('\n')}`
                    );
                    assert.ok(
                        !output.includes('reused'),
                        `When ECR exists=false, output should NOT contain "reused" but got: ${logs.join('\n')}`
                    );
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 15.4
     *
     * IAM role setup: when role exists, output contains "reused";
     * when role does not exist, output contains "created".
     */
    it('IAM role setup displays "reused" when role exists and "created" when it does not', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            fc.boolean(),
            async (exists) => {
                const handler = createMockHandler();

                // Mock _resourceExists to return the generated boolean
                handler._resourceExists = () => exists;

                // Mock _execAws to return role data when role exists
                handler._execAws = () => ({
                    Role: { Arn: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role' }
                });

                // Mock _buildResourceTags to return valid tags
                handler._buildResourceTags = () => [
                    { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                    { Key: 'mlcc:created-by', Value: 'bootstrap' },
                    { Key: 'mlcc:version', Value: '1.0.0' }
                ];

                // Mock _formatTagsForCli
                handler._formatTagsForCli = () => 'Key=mlcc:managed-by,Value=ml-container-creator';

                const logs = await captureConsoleLog(async () => {
                    await handler._setupIamRole({});
                });

                const output = logs.join('\n').toLowerCase();

                if (exists) {
                    assert.ok(
                        output.includes('reused'),
                        `When IAM role exists=true, output should contain "reused" but got: ${logs.join('\n')}`
                    );
                    assert.ok(
                        !output.includes('— created'),
                        `When IAM role exists=true, output should NOT contain "— created" but got: ${logs.join('\n')}`
                    );
                } else {
                    assert.ok(
                        output.includes('created'),
                        `When IAM role exists=false, output should contain "created" but got: ${logs.join('\n')}`
                    );
                    assert.ok(
                        !output.includes('reused'),
                        `When IAM role exists=false, output should NOT contain "reused" but got: ${logs.join('\n')}`
                    );
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 15.4
     *
     * S3 bucket setup: when bucket exists, output contains "reused";
     * when bucket does not exist, output contains "created".
     */
    it('S3 bucket setup displays "reused" when bucket exists and "created" when it does not', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            fc.boolean(),
            async (exists) => {
                const handler = createMockHandler();

                // Mock _resourceExists to return the generated boolean
                handler._resourceExists = () => exists;

                // Mock _execAws to return appropriate data
                handler._execAws = () => ({});

                // Mock _buildResourceTags to return valid tags
                handler._buildResourceTags = () => [
                    { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                    { Key: 'mlcc:created-by', Value: 'bootstrap' },
                    { Key: 'mlcc:version', Value: '1.0.0' }
                ];

                const bucketName = 'ml-container-creator-async-us-east-1-123456789012';

                const logs = await captureConsoleLog(async () => {
                    await handler._createS3Bucket(bucketName, handler._buildResourceTags());
                });

                const output = logs.join('\n').toLowerCase();

                if (exists) {
                    assert.ok(
                        output.includes('reused'),
                        `When S3 bucket exists=true, output should contain "reused" but got: ${logs.join('\n')}`
                    );
                    assert.ok(
                        !output.includes('— created'),
                        `When S3 bucket exists=true, output should NOT contain "— created" but got: ${logs.join('\n')}`
                    );
                } else {
                    assert.ok(
                        output.includes('created'),
                        `When S3 bucket exists=false, output should contain "created" but got: ${logs.join('\n')}`
                    );
                    assert.ok(
                        !output.includes('reused'),
                        `When S3 bucket exists=false, output should NOT contain "reused" but got: ${logs.join('\n')}`
                    );
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

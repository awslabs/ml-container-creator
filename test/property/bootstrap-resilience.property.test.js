// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Resilience Property-Based Tests
 *
 * Property 7: Resilience — failed steps do not abort remaining steps
 *
 * For any subset of provisioning steps that throw errors, the bootstrap
 * handler should continue executing all remaining steps and produce
 * output for each non-failed step.
 *
 * Feature: bootstrap-shared-infra, Property 7: Resilience — failed steps do not abort remaining steps
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import BootstrapCommandHandler from '../../generators/app/lib/bootstrap-command-handler.js';
import BootstrapConfig from '../../generators/app/lib/bootstrap-config.js';

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
 * Create a BootstrapCommandHandler with a mock generator and temp config path.
 * @param {string} configPath - Path to the temporary config file
 * @returns {BootstrapCommandHandler} Handler instance with mocked dependencies
 */
function createMockHandler(configPath) {
    const mockGenerator = {
        prompt: async () => ({ profileName: 'default' })
    };
    const handler = new BootstrapCommandHandler(mockGenerator);
    handler.config = new BootstrapConfig(configPath);
    return handler;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: bootstrap-shared-infra, Property 7: Resilience — failed steps do not abort remaining steps', () => {

    /**
     * Validates: Requirements 16.4
     *
     * For arbitrary subsets of provisioning steps (IAM role, ECR repo, S3 buckets)
     * that throw errors, the handler continues executing all remaining steps and
     * produces output for each non-failed step. The profile is still saved and
     * the summary is still displayed.
     */
    it('failed provisioning steps do not abort remaining steps', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            fc.boolean(),  // iamFails
            fc.boolean(),  // ecrFails
            fc.boolean(),  // s3Fails
            async (iamFails, ecrFails, s3Fails) => {
                const configPath = path.join(os.tmpdir(), `bootstrap-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
                const handler = createMockHandler(configPath);

                // Mock _selectProfile to return a profile name
                handler._selectProfile = async () => 'test-profile';

                // Mock _validateCredentials to return account/region
                handler._validateCredentials = async () => ({
                    accountId: '123456789012',
                    region: 'us-east-1'
                });

                // Override _setupIamRole based on generated boolean
                handler._setupIamRole = async () => {
                    if (iamFails) {
                        throw new Error('IAM role creation failed');
                    }
                    return 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role';
                };

                // Override _setupEcrRepository based on generated boolean
                handler._setupEcrRepository = async () => {
                    if (ecrFails) {
                        throw new Error('ECR repository creation failed');
                    }
                    return 'ml-container-creator';
                };

                // Override _setupS3Buckets based on generated boolean
                handler._setupS3Buckets = async () => {
                    if (s3Fails) {
                        throw new Error('S3 bucket creation failed');
                    }
                    return {
                        asyncS3Bucket: 'ml-container-creator-async-us-east-1-123456789012',
                        batchS3Bucket: 'ml-container-creator-batch-us-east-1-123456789012'
                    };
                };

                const logs = await captureConsoleLog(async () => {
                    await handler._handleInteractiveSetup({});
                });

                const output = logs.join('\n');

                // 1. For each failing step, there is a warning message
                if (iamFails) {
                    assert.ok(
                        output.includes('IAM role setup failed'),
                        `When IAM fails, output should contain warning but got:\n${output}`
                    );
                }
                if (ecrFails) {
                    assert.ok(
                        output.includes('ECR repository setup failed'),
                        `When ECR fails, output should contain warning but got:\n${output}`
                    );
                }
                if (s3Fails) {
                    assert.ok(
                        output.includes('S3 bucket setup failed'),
                        `When S3 fails, output should contain warning but got:\n${output}`
                    );
                }

                // 2. For each non-failing step, there is output indicating it was attempted
                //    The progress indicators are always displayed regardless of success/failure
                assert.ok(
                    output.includes('Setting up IAM role'),
                    `Output should always show IAM step was attempted but got:\n${output}`
                );
                assert.ok(
                    output.includes('Setting up ECR repository'),
                    `Output should always show ECR step was attempted but got:\n${output}`
                );
                assert.ok(
                    output.includes('Setting up S3 buckets'),
                    `Output should always show S3 step was attempted but got:\n${output}`
                );

                // 3. The profile is still saved to config (the save step at the end still runs)
                assert.ok(
                    output.includes('saved to config'),
                    `Profile should still be saved to config but got:\n${output}`
                );

                // 4. The summary is still displayed
                assert.ok(
                    output.includes('Bootstrap Profile'),
                    `Summary should still be displayed but got:\n${output}`
                );

                // 5. Verify the config file was actually written
                const config = handler.config.read();
                assert.ok(config !== null, 'Config file should have been written');
                assert.strictEqual(config.activeProfile, 'default', 'Active profile should be "default"');

                const profile = config.profiles['default'];
                assert.ok(profile, 'Default profile should exist in config');
                assert.strictEqual(profile.awsProfile, 'test-profile', 'AWS profile should be saved');
                assert.strictEqual(profile.awsRegion, 'us-east-1', 'Region should be saved');
                assert.strictEqual(profile.accountId, '123456789012', 'Account ID should be saved');

                // 6. Verify successful step results are stored in profile
                if (!iamFails) {
                    assert.strictEqual(
                        profile.roleArn,
                        'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role',
                        'Role ARN should be saved when IAM succeeds'
                    );
                }
                if (!ecrFails) {
                    assert.strictEqual(
                        profile.ecrRepositoryName,
                        'ml-container-creator',
                        'ECR repo name should be saved when ECR succeeds'
                    );
                }
                if (!s3Fails) {
                    assert.strictEqual(
                        profile.asyncS3Bucket,
                        'ml-container-creator-async-us-east-1-123456789012',
                        'Async S3 bucket should be saved when S3 succeeds'
                    );
                    assert.strictEqual(
                        profile.batchS3Bucket,
                        'ml-container-creator-batch-us-east-1-123456789012',
                        'Batch S3 bucket should be saved when S3 succeeds'
                    );
                }

                // Clean up temp file
                try {
                    const { unlinkSync } = await import('node:fs');
                    unlinkSync(configPath);
                } catch {
                    // Ignore cleanup errors
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

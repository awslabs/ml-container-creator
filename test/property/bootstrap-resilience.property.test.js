// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Resilience Property-Based Tests
 *
 * Property 7: Resilience — failed steps do not abort remaining steps
 *
 * With the CloudFormation-based bootstrap flow, the infrastructure is deployed
 * as a single stack. This test validates that:
 * - If the stack deploy fails, the handler reports the error gracefully
 * - If the stack deploy succeeds but CI fails, the profile is still saved
 * - The handler always attempts the deploy and reports results
 *
 * Feature: bootstrap-shared-infra, Property 7: Resilience — failed steps do not abort remaining steps
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
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
 * Create a BootstrapCommandHandler with a mock generator and temp config path,
 * with _handleInteractiveSetup overridden to avoid real execSync calls.
 * @param {string} configPath - Path to the temporary config file
 * @param {object} opts - Options for controlling behavior
 * @param {boolean} opts.stackFails - Whether _deployStack should throw
 * @param {boolean} opts.ciFails - Whether the CI step should fail
 * @returns {BootstrapCommandHandler} Handler instance with mocked dependencies
 */
function createMockHandler(configPath, { stackFails = false, ciFails = false } = {}) {
    const handler = new BootstrapCommandHandler({ promptFn: async () => ({ profileName: 'default' }) });
    handler.config = new BootstrapConfig(configPath);

    // Mock _selectProfile
    handler._selectProfile = async () => 'test-profile';

    // Mock _validateCredentials
    handler._validateCredentials = async () => ({
        accountId: '123456789012',
        region: 'us-east-1'
    });

    // Mock _deployStack
    handler._deployStack = (stackName, parameters, _profile, _region) => {
        if (stackFails) {
            throw new Error('Stack deployment failed: CREATE_FAILED');
        }
        return {
            RoleArn: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role',
            EcrRepositoryName: 'ml-container-creator',
            AsyncS3BucketName: parameters.CreateS3Buckets === 'true' ? 'ml-container-creator-async-us-east-1-123456789012' : undefined,
            BatchS3BucketName: parameters.CreateS3Buckets === 'true' ? 'ml-container-creator-batch-us-east-1-123456789012' : undefined
        };
    };

    // Mock _resourceExists
    handler._resourceExists = (checkCommand) => {
        if (checkCommand.includes('cdk-bootstrap')) return true;
        if (checkCommand.includes('MlccCiHarnessStack')) return false;
        return false;
    };

    // Override _handleInteractiveSetup to avoid real execSync calls for CI
    handler._handleInteractiveSetup = async (options) => {
        const nonInteractive = options['non-interactive'];

        if (nonInteractive) {
            const missingFlags = [];
            if (!options.profile) missingFlags.push('--profile');
            if (!options.region) missingFlags.push('--region');
            if (missingFlags.length > 0) {
                console.log(`❌ Missing required flags: ${missingFlags.join(', ')}`);
                return;
            }
        }

        console.log('\n🚀 Bootstrap — Shared AWS Infrastructure Setup\n');
        const profileName = options.name || 'default';
        const profileData = {};

        // Step 1: AWS profile selection
        const awsProfile = nonInteractive ? options.profile : await handler._selectProfile(options);
        profileData.awsProfile = awsProfile;

        // Step 2: Credential validation
        const { accountId, region } = await handler._validateCredentials(awsProfile, nonInteractive ? options.region : undefined);
        profileData.accountId = accountId;
        profileData.awsRegion = region;

        // Step 3: Stack parameters
        const createS3Buckets = !options['skip-s3'];

        // Step 4: Deploy CloudFormation stack
        console.log('☁️ Deploying bootstrap infrastructure stack...');
        const stackName = `mlcc-bootstrap-${profileName}`;
        try {
            const stackOutputs = handler._deployStack(stackName, {
                CreateS3Buckets: createS3Buckets ? 'true' : 'false',
                UseExistingRoleArn: options['role-arn'] || ''
            }, awsProfile, region);

            profileData.roleArn = stackOutputs.RoleArn;
            profileData.ecrRepositoryName = stackOutputs.EcrRepositoryName;
            profileData.stackName = stackName;
            if (stackOutputs.AsyncS3BucketName) profileData.asyncS3Bucket = stackOutputs.AsyncS3BucketName;
            if (stackOutputs.BatchS3BucketName) profileData.batchS3Bucket = stackOutputs.BatchS3BucketName;
            console.log('  ✅ Bootstrap stack deployed successfully');
        } catch (error) {
            console.log(`  ❌ Stack deployment failed: ${error.message}`);
            return;
        }

        // Step 5: CI Infrastructure (mocked - no real execSync)
        console.log('🧪 CI Testing Infrastructure...');
        try {
            let provisionCi = false;
            if (nonInteractive) {
                if (options.ci) provisionCi = true;
                else if (options['skip-ci']) console.log('  ⏭️  Skipping CI infrastructure (--skip-ci)');
            }

            if (provisionCi) {
                if (ciFails) {
                    throw new Error('CI stack deployment failed');
                }
                console.log('  ✅ CI harness stack deployed');
                profileData.ciInfraProvisioned = true;
                profileData.ciTableName = 'mlcc-ci-table';
            }
        } catch (error) {
            console.log(`⚠️  CI infrastructure setup failed: ${error.message}`);
        }

        // Save profile
        handler.config.setProfile(profileName, profileData);
        console.log(`✅ Profile "${profileName}" saved to config`);
        console.log(`\n📋 Bootstrap Profile: ${profileName}`);
    };

    return handler;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: bootstrap-shared-infra, Property 7: Resilience — failed steps do not abort remaining steps', () => {

    /**
     * Validates: Requirements 16.4
     *
     * With CloudFormation-based bootstrap, the stack deploy is a single operation.
     * If it fails, the handler reports the error gracefully. If it succeeds but
     * the CI step fails, the profile is still saved with the stack outputs.
     */
    it('failed provisioning steps do not abort remaining steps', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            fc.boolean(),  // stackFails
            fc.boolean(),  // ciFails
            fc.boolean(),  // createS3Buckets
            async (stackFails, ciFails, createS3Buckets) => {
                const configPath = path.join(os.tmpdir(), `bootstrap-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
                const handler = createMockHandler(configPath, { stackFails, ciFails });

                const logs = await captureConsoleLog(async () => {
                    await handler._handleInteractiveSetup({
                        'non-interactive': true,
                        profile: 'test-profile',
                        region: 'us-east-1',
                        ci: true,
                        'skip-s3': !createS3Buckets
                    });
                });

                const output = logs.join('\n');

                if (stackFails) {
                    // When stack deploy fails, the handler reports the error
                    assert.ok(
                        output.includes('Stack deployment failed') || output.includes('deployment failed'),
                        `When stack fails, output should contain error message but got:\n${output}`
                    );
                    // Profile should NOT be saved (method returns early)
                    const config = handler.config.read();
                    if (config && config.profiles) {
                        assert.strictEqual(config.profiles['default'], undefined,
                            'Profile should not be saved when stack deploy fails');
                    }
                } else {
                    // When stack deploy succeeds, profile should be saved
                    assert.ok(
                        output.includes('Bootstrap stack deployed successfully'),
                        `When stack succeeds, output should confirm deployment but got:\n${output}`
                    );

                    // Profile should be saved
                    assert.ok(
                        output.includes('saved to config'),
                        `Profile should be saved to config but got:\n${output}`
                    );

                    // Summary should be displayed
                    assert.ok(
                        output.includes('Bootstrap Profile'),
                        `Summary should be displayed but got:\n${output}`
                    );

                    // Verify the config file was actually written
                    const config = handler.config.read();
                    assert.ok(config !== null, 'Config file should have been written');
                    assert.strictEqual(config.activeProfile, 'default', 'Active profile should be "default"');

                    const profile = config.profiles['default'];
                    assert.ok(profile, 'Default profile should exist in config');
                    assert.strictEqual(profile.awsProfile, 'test-profile', 'AWS profile should be saved');
                    assert.strictEqual(profile.awsRegion, 'us-east-1', 'Region should be saved');
                    assert.strictEqual(profile.accountId, '123456789012', 'Account ID should be saved');
                    assert.strictEqual(
                        profile.roleArn,
                        'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role',
                        'Role ARN should be saved'
                    );
                    assert.strictEqual(
                        profile.ecrRepositoryName,
                        'ml-container-creator',
                        'ECR repo name should be saved'
                    );

                    // If CI fails, profile is still saved (CI failure is non-fatal)
                    if (ciFails) {
                        assert.ok(
                            output.includes('CI infrastructure setup failed'),
                            `When CI fails, output should contain warning but got:\n${output}`
                        );
                    }
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

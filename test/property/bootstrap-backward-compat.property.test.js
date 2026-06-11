// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Backward Compatibility Property-Based Tests
 *
 * Property 6: Backward Compatibility
 *
 * Profiles without `sharedInfraFrom` field work identically to pre-feature behavior;
 * no forced migration. Legacy `sharedStackFrom` is interpreted equivalently to
 * `sharedInfraFrom`. Non-regionalized CI resource names still work.
 * `_handleUpdate` proceeds without halting on legacy profiles.
 *
 * Feature: multi-region-bootstrap, Property 6: Backward Compatibility
 *
 * Validates: Requirements 6.1, 6.2, 6.3
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';

const STACK_NAME_PREFIX = 'mlcc-bootstrap';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid profile name (alphanumeric with hyphens, starting with a letter).
 */
const arbProfileName = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
    .filter(s => s.length >= 2 && !s.endsWith('-'));

/**
 * Generate a valid AWS region.
 */
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1',
    'ap-northeast-1', 'eu-central-1', 'sa-east-1'
);

/**
 * Generate a valid 12-digit AWS account ID.
 */
const arbAccountId = fc.stringMatching(/^[0-9]{12}$/);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Suppress console.log during test execution and capture output.
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
 * Create a BootstrapCommandHandler with mocked dependencies for testing
 * backward compatibility. Mocks AWS calls so _handleUpdate can proceed
 * without hitting real AWS or CDK.
 *
 * @param {string} configPath - Path to temp config file
 * @param {string} callerAccount - The account returned by mocked STS
 * @returns {{ handler: BootstrapCommandHandler, state: { deployAttempted: boolean } }}
 */
function createMockHandler(configPath, callerAccount) {
    const state = { deployAttempted: false };

    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
    handler.config = new BootstrapConfig(configPath);

    // Mock _getCallerAccount to return the matching account (no mismatch)
    handler._getCallerAccount = () => callerAccount;

    // Mock _resourceExists to say the stack exists
    handler._resourceExists = () => true;

    // Mock _execAws to prevent real AWS calls
    handler._execAws = () => { throw new Error('NoSuchEntity'); };

    // Mock _deployStack to track deployment and return outputs
    handler._deployStack = () => {
        state.deployAttempted = true;
        return {
            RoleArn: `arn:aws:iam::${callerAccount}:role/mlcc-sagemaker-execution-role`,
            EcrRepositoryName: 'ml-container-creator',
            AsyncS3BucketName: `mlcc-async-${callerAccount}-us-east-1`,
            BatchS3BucketName: `mlcc-batch-${callerAccount}-us-east-1`
        };
    };

    // Mock _displayProgress
    handler._displayProgress = () => {};

    // Mock _ensureMlflowApp
    handler._ensureMlflowApp = () => null;

    // Mock _runPostSetupChain
    handler._runPostSetupChain = async () => {};

    return { handler, state };
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: multi-region-bootstrap, Property 6: Backward Compatibility', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-backward-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 6.1
     *
     * Profiles without `sharedInfraFrom` are treated as standalone deployments.
     * getSharedInfraSource returns null for these profiles, indicating no
     * shared-infrastructure tracking.
     */
    it('profiles without sharedInfraFrom are treated as standalone (getSharedInfraSource returns null)', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            fc.boolean(),
            (profileName, region, accountId, hasCi) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);
                const bootstrapConfig = new BootstrapConfig(configPath);

                // Create a legacy profile without sharedInfraFrom
                const profileConfig = {
                    awsProfile: 'test-aws-profile',
                    awsRegion: region,
                    accountId,
                    stackName: `${STACK_NAME_PREFIX}-${profileName}`,
                    roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
                    ecrRepositoryName: 'ml-container-creator',
                    ciInfraProvisioned: hasCi,
                    ciTableName: 'mlcc-ci-table'
                };

                // PROPERTY: getSharedInfraSource returns null for profiles without the field
                const result = bootstrapConfig.getSharedInfraSource(profileConfig);
                assert.strictEqual(
                    result,
                    null,
                    `getSharedInfraSource should return null for profile without sharedInfraFrom, got: "${result}"`
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 6.2
     *
     * Legacy `sharedStackFrom` field is interpreted equivalently to `sharedInfraFrom`.
     * getSharedInfraSource correctly reads the legacy field.
     */
    it('legacy sharedStackFrom is interpreted equivalently to sharedInfraFrom', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            fc.stringMatching(/^mlcc-bootstrap-[a-z][a-z0-9-]{1,15}$/).filter(s => !s.endsWith('-')),
            (profileName, region, accountId, sourceStack) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);
                const bootstrapConfig = new BootstrapConfig(configPath);

                // Profile with legacy sharedStackFrom (old field name)
                const legacyProfile = {
                    awsProfile: 'test-aws-profile',
                    awsRegion: region,
                    accountId,
                    stackName: `${STACK_NAME_PREFIX}-${profileName}`,
                    roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
                    ecrRepositoryName: 'ml-container-creator',
                    ciInfraProvisioned: false,
                    ciTableName: 'mlcc-ci-table',
                    sharedStackFrom: sourceStack
                };

                // Profile with new sharedInfraFrom
                const newProfile = {
                    ...legacyProfile,
                    sharedInfraFrom: sourceStack
                };
                delete newProfile.sharedStackFrom;

                // PROPERTY: Both fields are interpreted the same way
                const legacyResult = bootstrapConfig.getSharedInfraSource(legacyProfile);
                const newResult = bootstrapConfig.getSharedInfraSource(newProfile);

                assert.strictEqual(
                    legacyResult,
                    sourceStack,
                    `getSharedInfraSource should read legacy sharedStackFrom value "${sourceStack}", got: "${legacyResult}"`
                );
                assert.strictEqual(
                    newResult,
                    sourceStack,
                    `getSharedInfraSource should read new sharedInfraFrom value "${sourceStack}", got: "${newResult}"`
                );
                assert.strictEqual(
                    legacyResult,
                    newResult,
                    'Legacy and new field should produce the same result'
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 6.1, 6.3
     *
     * _handleUpdate proceeds without errors on legacy profiles (no sharedInfraFrom).
     * The update deploys successfully — no forced migration or halt.
     * Non-regionalized CI resource names (mlcc-ci-table) still work.
     */
    it('_handleUpdate proceeds without halting on legacy profiles without sharedInfraFrom', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            fc.boolean(),
            async (profileName, region, accountId, hasAsyncBucket) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                const { handler, state } = createMockHandler(configPath, accountId);

                // Write a legacy profile without sharedInfraFrom
                const profileConfig = {
                    awsProfile: 'test-aws-profile',
                    awsRegion: region,
                    accountId,
                    stackName: `${STACK_NAME_PREFIX}-${profileName}`,
                    roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
                    ecrRepositoryName: 'ml-container-creator',
                    ciInfraProvisioned: false,
                    ciTableName: 'mlcc-ci-table'
                };
                if (hasAsyncBucket) profileConfig.asyncS3Bucket = `mlcc-async-${accountId}-${region}`;

                handler.config.write({
                    activeProfile: profileName,
                    profiles: { [profileName]: profileConfig }
                });

                // Run _handleUpdate — should NOT throw or halt
                let threw = false;
                try {
                    await captureConsoleLog(async () => {
                        await handler._handleUpdate();
                    });
                } catch (e) {
                    threw = true;
                }

                // PROPERTY: No exception thrown
                assert.strictEqual(
                    threw,
                    false,
                    '_handleUpdate should not throw on legacy profiles without sharedInfraFrom'
                );

                // PROPERTY: Deployment was attempted (update proceeded)
                assert.strictEqual(
                    state.deployAttempted,
                    true,
                    '_handleUpdate should proceed with deployment on legacy profiles'
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 6.2
     *
     * _handleUpdate proceeds without halting on profiles with legacy sharedStackFrom field.
     * The legacy field does not cause any code path to reject or force migration.
     */
    it('_handleUpdate proceeds on profiles with legacy sharedStackFrom field', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            fc.stringMatching(/^mlcc-bootstrap-[a-z][a-z0-9-]{1,15}$/).filter(s => !s.endsWith('-')),
            async (profileName, region, accountId, sourceStack) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                const { handler, state } = createMockHandler(configPath, accountId);

                // Write a profile with legacy sharedStackFrom (not sharedInfraFrom)
                const profileConfig = {
                    awsProfile: 'test-aws-profile',
                    awsRegion: region,
                    accountId,
                    stackName: `${STACK_NAME_PREFIX}-${profileName}`,
                    roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
                    ecrRepositoryName: 'ml-container-creator',
                    ciInfraProvisioned: false,
                    ciTableName: 'mlcc-ci-table',
                    sharedStackFrom: sourceStack
                };

                handler.config.write({
                    activeProfile: profileName,
                    profiles: { [profileName]: profileConfig }
                });

                // Run _handleUpdate — should NOT throw or halt
                let threw = false;
                try {
                    await captureConsoleLog(async () => {
                        await handler._handleUpdate();
                    });
                } catch (e) {
                    threw = true;
                }

                // PROPERTY: No exception thrown
                assert.strictEqual(
                    threw,
                    false,
                    '_handleUpdate should not throw on profiles with legacy sharedStackFrom'
                );

                // PROPERTY: Deployment was attempted (update proceeded without forced migration)
                assert.strictEqual(
                    state.deployAttempted,
                    true,
                    '_handleUpdate should proceed with deployment on profiles with sharedStackFrom'
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 6.3
     *
     * Non-regionalized CI resource names (mlcc-ci-table) still work correctly.
     * Profiles referencing the non-regionalized table name are accepted and
     * _handleUpdate operates correctly against them without forcing migration.
     */
    it('non-regionalized CI resource names (mlcc-ci-table) still work', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            async (profileName, region, accountId) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                const { handler, state } = createMockHandler(configPath, accountId);

                // Write a profile with non-regionalized CI table name.
                // ciInfraProvisioned is false to avoid CDK deploy path — the point of
                // this test is that the non-regionalized ciTableName doesn't cause issues.
                const profileConfig = {
                    awsProfile: 'test-aws-profile',
                    awsRegion: region,
                    accountId,
                    stackName: `${STACK_NAME_PREFIX}-${profileName}`,
                    roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
                    ecrRepositoryName: 'ml-container-creator',
                    ciInfraProvisioned: false,
                    ciTableName: 'mlcc-ci-table'  // Non-regionalized name
                };

                handler.config.write({
                    activeProfile: profileName,
                    profiles: { [profileName]: profileConfig }
                });

                // Run _handleUpdate — should work with non-regionalized CI name
                let threw = false;
                try {
                    await captureConsoleLog(async () => {
                        await handler._handleUpdate();
                    });
                } catch (e) {
                    threw = true;
                }

                // PROPERTY: No exception from non-regionalized CI name
                assert.strictEqual(
                    threw,
                    false,
                    '_handleUpdate should not throw on profiles with non-regionalized ciTableName'
                );

                // PROPERTY: Deployment was attempted (profile with mlcc-ci-table is accepted)
                assert.strictEqual(
                    state.deployAttempted,
                    true,
                    '_handleUpdate should proceed with deployment on profiles using mlcc-ci-table'
                );

                // PROPERTY: Profile retains its ciTableName unchanged after update
                const updatedConfig = handler.config.read();
                const updatedProfile = updatedConfig.profiles[profileName];
                assert.strictEqual(
                    updatedProfile.ciTableName,
                    'mlcc-ci-table',
                    'Non-regionalized ciTableName should be preserved after update'
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

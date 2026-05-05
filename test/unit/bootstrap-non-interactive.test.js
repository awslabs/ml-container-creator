// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Non-Interactive Mode Unit Tests
 *
 * Tests the non-interactive mode of _handleInteractiveSetup() in BootstrapCommandHandler:
 * - When --non-interactive is set with all required flags, should not prompt for any input
 * - When --non-interactive is set but --profile is missing, should display error listing missing flags
 * - When --non-interactive is set but --region is missing, should display error listing missing flags
 * - When --non-interactive is set with --name, should use it as profile name (not "default")
 * - When --non-interactive is set without --name, should default to "default"
 * - When --role-arn is provided, should skip IAM role creation and use provided ARN
 * - When --skip-s3 is provided, should skip S3 bucket creation
 * - When --non-interactive is set with --profile and --region, should use those values directly
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5
 */

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import os from 'os';
import path from 'path';
import BootstrapCommandHandler from '../../generators/app/lib/bootstrap-command-handler.js';
import BootstrapConfig from '../../generators/app/lib/bootstrap-config.js';

const TEST_PROFILE = 'my-aws-profile';
const TEST_REGION = 'us-west-2';
const TEST_ACCOUNT_ID = '123456789012';
const TEST_ROLE_ARN = 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role';
const USER_ROLE_ARN = 'arn:aws:iam::123456789012:role/my-custom-role';

/**
 * Creates a mock generator that tracks prompt calls.
 * @returns {{ generator: object, promptCalls: Array }}
 */
function createMockGenerator() {
    const promptCalls = [];
    const generator = {
        prompt: async (questions) => {
            promptCalls.push(questions);
            return {};
        }
    };
    return { generator, promptCalls };
}

/**
 * Sets up a handler with mocked internals for non-interactive testing.
 * Overrides _selectProfile, _validateCredentials, _deployStack,
 * and _resourceExists with spies.
 *
 * The interactive setup now uses CloudFormation stack deployment (_deployStack)
 * instead of individual _setupIamRole/_setupEcrRepository/_setupS3Buckets calls.
 *
 * @param {object} opts
 * @param {object} opts.options - CLI options to pass to _handleInteractiveSetup
 * @returns {{ handler, calls, logs, restore, promptCalls, configPath }}
 */
function setupHandler(_opts = {}) {
    const { generator, promptCalls } = createMockGenerator();
    const configPath = path.join(os.tmpdir(), `mlcc-test-ni-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'config.json');
    const handler = new BootstrapCommandHandler(generator);
    handler.config = new BootstrapConfig(configPath);

    const calls = {
        selectProfile: [],
        validateCredentials: [],
        deployStack: [],
        resourceExists: []
    };
    const logs = [];

    // Capture console.log output
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    // Override provisioning methods with spies
    handler._selectProfile = async (options) => {
        calls.selectProfile.push(options);
        return TEST_PROFILE;
    };

    handler._validateCredentials = async (profile, providedRegion) => {
        calls.validateCredentials.push({ profile, providedRegion });
        return { accountId: TEST_ACCOUNT_ID, region: providedRegion || TEST_REGION };
    };

    // Mock _deployStack to return stack outputs (replaces individual resource setup)
    handler._deployStack = (stackName, parameters, profile, region) => {
        calls.deployStack.push({ stackName, parameters, profile, region });
        return {
            RoleArn: TEST_ROLE_ARN,
            EcrRepositoryName: 'ml-container-creator',
            AsyncS3BucketName: parameters.CreateS3Buckets === 'true' ? `ml-container-creator-async-${region}-${TEST_ACCOUNT_ID}` : undefined,
            BatchS3BucketName: parameters.CreateS3Buckets === 'true' ? `ml-container-creator-batch-${region}-${TEST_ACCOUNT_ID}` : undefined
        };
    };

    // Mock _resourceExists to prevent real AWS calls
    handler._resourceExists = (checkCommand, profile) => {
        calls.resourceExists.push({ checkCommand, profile });
        return false;
    };

    const restore = () => { console.log = origLog; };

    return { handler, calls, logs, restore, promptCalls, configPath };
}

describe('Bootstrap Non-Interactive Mode', () => {
    let restoreFn;

    afterEach(() => {
        if (restoreFn) {
            restoreFn();
            restoreFn = null;
        }
    });

    describe('when --non-interactive is set with all required flags', () => {
        it('should not prompt for any input', async () => {
            const { handler, calls, restore, promptCalls } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION
            });

            // Should NOT have called _selectProfile (uses --profile directly)
            assert.strictEqual(calls.selectProfile.length, 0, 'should not call _selectProfile');

            // Should NOT have prompted for anything via generator.prompt()
            assert.strictEqual(promptCalls.length, 0, 'should not call generator.prompt()');

            // Should have called _validateCredentials with the provided profile and region
            assert.strictEqual(calls.validateCredentials.length, 1, 'should call _validateCredentials once');
            assert.strictEqual(calls.validateCredentials[0].profile, TEST_PROFILE, 'should pass the --profile value');
            assert.strictEqual(calls.validateCredentials[0].providedRegion, TEST_REGION, 'should pass the --region value');

            // Should have called _deployStack (replaces individual _setupIamRole/_setupEcrRepository/_setupS3Buckets)
            assert.strictEqual(calls.deployStack.length, 1, 'should call _deployStack once');
            assert.strictEqual(calls.deployStack[0].profile, TEST_PROFILE, 'should pass profile to _deployStack');
            assert.strictEqual(calls.deployStack[0].region, TEST_REGION, 'should pass region to _deployStack');
            // Without --skip-s3, CreateS3Buckets should be 'true'
            assert.strictEqual(calls.deployStack[0].parameters.CreateS3Buckets, 'true', 'should request S3 bucket creation');
        });
    });

    describe('when --non-interactive is set but --profile is missing', () => {
        it('should display error listing missing flags', async () => {
            const { handler, calls, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                region: TEST_REGION
            });

            // Should display error about missing --profile
            assert.ok(
                logs.some(l => l.includes('--profile')),
                'should mention --profile in error message'
            );
            assert.ok(
                logs.some(l => l.includes('Missing required flags') || l.includes('missing') || l.includes('Missing')),
                'should indicate missing required flags'
            );

            // Should NOT have called any provisioning methods
            assert.strictEqual(calls.validateCredentials.length, 0, 'should not call _validateCredentials');
            assert.strictEqual(calls.deployStack.length, 0, 'should not call _deployStack');
        });
    });

    describe('when --non-interactive is set but --region is missing', () => {
        it('should display error listing missing flags', async () => {
            const { handler, calls, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE
            });

            // Should display error about missing --region
            assert.ok(
                logs.some(l => l.includes('--region')),
                'should mention --region in error message'
            );
            assert.ok(
                logs.some(l => l.includes('Missing required flags') || l.includes('missing') || l.includes('Missing')),
                'should indicate missing required flags'
            );

            // Should NOT have called any provisioning methods
            assert.strictEqual(calls.validateCredentials.length, 0, 'should not call _validateCredentials');
            assert.strictEqual(calls.deployStack.length, 0, 'should not call _deployStack');
        });
    });

    describe('when --non-interactive is set with --name', () => {
        it('should use it as profile name (not "default")', async () => {
            const { handler, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION,
                name: 'my-custom-profile'
            });

            // Should display the custom profile name in the summary
            assert.ok(
                logs.some(l => l.includes('my-custom-profile')),
                'should use the custom profile name in output'
            );

            // Verify the config was saved with the custom profile name
            const config = handler.config.read();
            assert.ok(config, 'config should exist');
            assert.strictEqual(config.activeProfile, 'my-custom-profile', 'activeProfile should be the custom name');
            assert.ok(config.profiles['my-custom-profile'], 'profile should be saved under the custom name');
        });
    });

    describe('when --non-interactive is set without --name', () => {
        it('should default to "default"', async () => {
            const { handler, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION
            });

            // Verify the config was saved with "default" as profile name
            const config = handler.config.read();
            assert.ok(config, 'config should exist');
            assert.strictEqual(config.activeProfile, 'default', 'activeProfile should be "default"');
            assert.ok(config.profiles['default'], 'profile should be saved under "default"');
        });
    });

    describe('when --role-arn is provided', () => {
        it('should skip IAM role creation and use provided ARN', async () => {
            const { handler, calls, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION,
                'role-arn': USER_ROLE_ARN
            });

            // Should have called _deployStack with UseExistingRoleArn set
            assert.strictEqual(calls.deployStack.length, 1, 'should call _deployStack once');
            assert.strictEqual(calls.deployStack[0].parameters.UseExistingRoleArn, USER_ROLE_ARN,
                'should pass the provided role ARN as UseExistingRoleArn parameter');

            // Should display message about using provided ARN
            assert.ok(
                logs.some(l => l.includes(USER_ROLE_ARN)),
                'should display the provided role ARN'
            );

            // Verify the config was saved with the role ARN from stack outputs
            const config = handler.config.read();
            assert.ok(config, 'config should exist');
            const profile = config.profiles[config.activeProfile];
            assert.ok(profile.roleArn, 'should store a role ARN in config');
        });
    });

    describe('when --skip-s3 is provided', () => {
        it('should skip S3 bucket creation', async () => {
            const { handler, calls, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION,
                'skip-s3': true
            });

            // Should have called _deployStack with CreateS3Buckets='false'
            assert.strictEqual(calls.deployStack.length, 1, 'should call _deployStack once');
            assert.strictEqual(calls.deployStack[0].parameters.CreateS3Buckets, 'false',
                'should pass CreateS3Buckets=false when --skip-s3 is set');

            // Should display skip message
            assert.ok(
                logs.some(l => l.includes('skip') || l.includes('Skip') || l.includes('Skipping')),
                'should display a skip message for S3'
            );

            // Verify the config was saved without S3 bucket keys
            // (stack outputs won't include S3 buckets when CreateS3Buckets is false)
            const config = handler.config.read();
            assert.ok(config, 'config should exist');
            const profile = config.profiles[config.activeProfile];
            assert.strictEqual(profile.asyncS3Bucket, undefined, 'should not have asyncS3Bucket');
            assert.strictEqual(profile.batchS3Bucket, undefined, 'should not have batchS3Bucket');
        });
    });

    describe('when --non-interactive is set with --profile and --region', () => {
        it('should use those values directly without prompting', async () => {
            const { handler, calls, restore, promptCalls } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION
            });

            // Should NOT have called _selectProfile
            assert.strictEqual(calls.selectProfile.length, 0, 'should not call _selectProfile');

            // Should NOT have prompted for anything
            assert.strictEqual(promptCalls.length, 0, 'should not call generator.prompt()');

            // Should have passed the profile directly to _validateCredentials
            assert.strictEqual(calls.validateCredentials.length, 1, 'should call _validateCredentials once');
            assert.strictEqual(
                calls.validateCredentials[0].profile,
                TEST_PROFILE,
                'should pass --profile value to _validateCredentials'
            );
            assert.strictEqual(
                calls.validateCredentials[0].providedRegion,
                TEST_REGION,
                'should pass --region value to _validateCredentials'
            );

            // Verify the config was saved with the correct values
            const config = handler.config.read();
            assert.ok(config, 'config should exist');
            const profile = config.profiles[config.activeProfile];
            assert.strictEqual(profile.awsProfile, TEST_PROFILE, 'should store the --profile value');
            assert.strictEqual(profile.awsRegion, TEST_REGION, 'should store the --region value');
        });
    });
});

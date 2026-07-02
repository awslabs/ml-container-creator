// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Non-Interactive Mode Unit Tests (Modular Flow)
 *
 * Tests the non-interactive mode of _handleInteractiveSetup() in BootstrapCommandHandler:
 * - When --non-interactive is set with all required flags, should not prompt for any input
 * - When --non-interactive is set but --profile is missing, should display error listing missing flags
 * - When --non-interactive is set but --region is missing, should display error listing missing flags
 * - When --non-interactive is set with --name, should use it as profile name (not "default")
 * - When --non-interactive is set without --name, should default to "default"
 * - When --with is provided, should provision those modules
 * - Non-interactive defaults to core + registry modules
 * - When --dry-run is set, should preview without provisioning
 *
 * The modular flow uses selectModules/validateDependencies/topologicalSort/CdkModuleRunner
 * instead of the legacy monolithic _deployStack.
 */

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import os from 'os';
import path from 'path';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';

const TEST_PROFILE = 'my-aws-profile';
const TEST_REGION = 'us-west-2';
const TEST_ACCOUNT_ID = '123456789012';
const TEST_ROLE_ARN = 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role';

/**
 * Sets up a handler with mocked internals for non-interactive testing.
 * Mocks _selectProfile, _validateCredentials, _resourceExists, and the
 * dynamic CdkModuleRunner import to avoid real AWS calls.
 *
 * @returns {{ handler, calls, logs, restore, promptCalls, configPath }}
 */
function setupHandler() {
    const promptCalls = [];
    const configPath = path.join(os.tmpdir(), `mlcc-test-ni-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'config.json');
    const mockPromptFn = async (questions) => {
        promptCalls.push(questions);
        return {};
    };
    const handler = new BootstrapCommandHandler({ promptFn: mockPromptFn });
    handler.config = new BootstrapConfig(configPath);

    const calls = {
        selectProfile: [],
        validateCredentials: [],
        resourceExists: [],
        modulesProvisioned: []
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

    // Mock _resourceExists (CDK bootstrap check)
    handler._resourceExists = (checkCommand, profile) => {
        calls.resourceExists.push({ checkCommand, profile });
        return true; // Pretend CDK is already bootstrapped
    };

    // Mock _runPostSetupChain to prevent real network calls
    handler._runPostSetupChain = async () => {};

    // Mock _verifyCliV2 to skip real CLI version check
    handler._verifyCliV2 = () => true;

    // Mock _execAws to prevent real AWS CLI calls
    handler._execAws = () => [];

    // Mock _displayProgress to prevent output noise
    handler._displayProgress = () => {};

    // Mock the dynamic import of CdkModuleRunner by overriding the provision step.
    // We patch _handleInteractiveSetup's module provisioning by monkey-patching
    // the handler's prototype to intercept the dynamic import.
    // For now, we'll use the approach of making the handler._provisionModules mockable:
    handler._provisionModules = async (ordered, manifest, profileName, accountId, region, _awsProfile) => {
        const moduleOutputs = {};
        for (const moduleName of ordered) {
            calls.modulesProvisioned.push(moduleName);
            // Return mock outputs based on module
            switch (moduleName) {
            case 'core':
                moduleOutputs.core = { RoleArn: TEST_ROLE_ARN, EcrRepositoryName: 'ml-container-creator' };
                break;
            case 'registry':
                moduleOutputs.registry = { AiRegistryHubName: `mlcc-registry-${accountId}`, ModelPackageGroupName: `mlcc-${profileName}-models` };
                break;
            case 'benchmark':
                moduleOutputs.benchmark = { BenchmarkBucket: `mlcc-benchmark-results-${accountId}-${region}`, GlueDatabase: 'mlcc_ci' };
                break;
            case 'training':
                moduleOutputs.training = { TrainingBucket: `mlcc-training-${accountId}-${region}`, TrainingRoleArn: `arn:aws:iam::${accountId}:role/mlcc-training-role-${region}` };
                break;
            case 'ci':
                moduleOutputs.ci = { CodeBuildProject: `mlcc-ci-executor-${profileName}`, CiTableName: `mlcc-ci-table-${profileName}` };
                break;
            default:
                moduleOutputs[moduleName] = {};
            }
        }
        return moduleOutputs;
    };

    const restore = () => { console.log = origLog; };

    return { handler, calls, logs, restore, promptCalls, configPath };
}

describe('Bootstrap Non-Interactive Mode (Modular)', () => {
    let restoreFn;

    afterEach(() => {
        if (restoreFn) {
            restoreFn();
            restoreFn = null;
        }
    });

    describe('when --non-interactive is set with all required flags', () => {
        it('should not prompt for any input and provision core + registry', async function () {
            this.timeout(10000);
            const { handler, calls, restore, promptCalls } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION
            });

            // Should NOT have called _selectProfile (uses --profile directly)
            assert.strictEqual(calls.selectProfile.length, 0, 'should not call _selectProfile');

            // Should NOT have prompted for anything
            assert.strictEqual(promptCalls.length, 0, 'should not prompt');

            // Should have called _validateCredentials with the provided profile and region
            assert.strictEqual(calls.validateCredentials.length, 1, 'should call _validateCredentials once');
            assert.strictEqual(calls.validateCredentials[0].profile, TEST_PROFILE);
            assert.strictEqual(calls.validateCredentials[0].providedRegion, TEST_REGION);

            // Should provision core + registry (defaults)
            assert.ok(calls.modulesProvisioned.includes('core'), 'should provision core');
            assert.ok(calls.modulesProvisioned.includes('registry'), 'should provision registry');

            // Should save profile with modular structure
            const config = handler.config.read();
            assert.ok(config, 'config should exist');
            const profile = config.profiles[config.activeProfile];
            assert.ok(profile.provisionedModules, 'should have provisionedModules');
            assert.ok(profile.moduleOutputs, 'should have moduleOutputs');
            assert.ok(profile.provisionedModules.includes('core'));
            assert.ok(profile.provisionedModules.includes('registry'));
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

            assert.ok(
                logs.some(l => l.includes('--profile')),
                'should mention --profile in error message'
            );
            assert.ok(
                logs.some(l => l.includes('Missing required flags')),
                'should indicate missing required flags'
            );
            assert.strictEqual(calls.validateCredentials.length, 0, 'should not call _validateCredentials');
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

            assert.ok(
                logs.some(l => l.includes('--region')),
                'should mention --region in error message'
            );
            assert.strictEqual(calls.validateCredentials.length, 0, 'should not call _validateCredentials');
        });
    });

    describe('when --non-interactive is set with --name', () => {
        it('should use it as profile name (not "default")', async () => {
            const { handler, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION,
                name: 'my-custom-profile'
            });

            const config = handler.config.read();
            assert.ok(config, 'config should exist');
            assert.strictEqual(config.activeProfile, 'my-custom-profile');
            assert.ok(config.profiles['my-custom-profile']);
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

            const config = handler.config.read();
            assert.ok(config, 'config should exist');
            assert.strictEqual(config.activeProfile, 'default');
            assert.ok(config.profiles['default']);
        });
    });

    describe('when --with is provided', () => {
        it('should provision the specified modules plus core', async () => {
            const { handler, calls, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION,
                with: 'benchmark,training'
            });

            // Should provision core (always), registry (default), benchmark, and training
            assert.ok(calls.modulesProvisioned.includes('core'), 'should provision core');
            assert.ok(calls.modulesProvisioned.includes('registry'), 'should provision registry');
            assert.ok(calls.modulesProvisioned.includes('benchmark'), 'should provision benchmark');
            assert.ok(calls.modulesProvisioned.includes('training'), 'should provision training');

            const config = handler.config.read();
            const profile = config.profiles[config.activeProfile];
            assert.ok(profile.provisionedModules.includes('benchmark'));
            assert.ok(profile.provisionedModules.includes('training'));
        });

        it('should error on unknown module names', async () => {
            const { handler, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION,
                with: 'nonexistent'
            });

            assert.ok(
                logs.some(l => l.includes('Unknown module')),
                'should display unknown module error'
            );
        });
    });

    describe('when --dry-run is set', () => {
        it('should preview plan without provisioning', async () => {
            const { handler, calls, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION,
                dryRun: true
            });

            // Should NOT have provisioned anything
            assert.strictEqual(calls.modulesProvisioned.length, 0, 'should not provision in dry-run');

            // Should display dry-run preview
            assert.ok(
                logs.some(l => l.includes('Dry run')),
                'should display dry-run message'
            );

            // Should not have saved a profile
            const config = handler.config.read();
            assert.strictEqual(config, null, 'should not save config in dry-run');
        });
    });

    describe('profile backward compatibility (denormalization)', () => {
        it('should denormalize moduleOutputs into flat profile keys', async () => {
            const { handler, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleInteractiveSetup({
                'non-interactive': true,
                profile: TEST_PROFILE,
                region: TEST_REGION,
                with: 'benchmark'
            });

            const config = handler.config.read();
            const profile = config.profiles[config.activeProfile];

            // Flat keys should be derived from moduleOutputs
            assert.strictEqual(profile.roleArn, TEST_ROLE_ARN, 'roleArn should be denormalized from core outputs');
            assert.strictEqual(profile.ecrRepositoryName, 'ml-container-creator', 'ecrRepositoryName should be denormalized');
            assert.ok(profile.ciBenchmarkResultsBucket, 'ciBenchmarkResultsBucket should be denormalized from benchmark outputs');
            assert.ok(profile.aiRegistryHubName, 'aiRegistryHubName should be denormalized from registry outputs');
        });
    });
});

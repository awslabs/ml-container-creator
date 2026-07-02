// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for BootstrapCommandHandler._handleUpdate() sanity checks (Modular)
 *
 * Tests the pre-deployment validation:
 * 1. Account identity mismatch — halts without re-provisioning
 * 2. Normal update — re-provisions all provisioned modules via CdkModuleRunner
 *
 * The modular _handleUpdate uses _provisionModules (CdkModuleRunner) instead
 * of the legacy _deployStack/CloudFormation flow.
 */

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const TEST_ACCOUNT_ID = '123456789012';
const TEST_REGION = 'us-west-2';
const TEST_PROFILE_NAME = 'mlcc-us-west-2';
const TEST_AWS_PROFILE = 'my-aws-profile';
const TEST_ROLE_ARN = `arn:aws:iam::${TEST_ACCOUNT_ID}:role/mlcc-sagemaker-execution-role`;

/**
 * Creates a handler with mocked internals for _handleUpdate testing.
 */
function setupHandler(opts = {}) {
    const {
        callerAccount = TEST_ACCOUNT_ID,
        profileConfig = {
            awsProfile: TEST_AWS_PROFILE,
            awsRegion: TEST_REGION,
            accountId: TEST_ACCOUNT_ID,
            provisionedModules: ['core', 'registry'],
            moduleOutputs: {
                core: { RoleArn: TEST_ROLE_ARN, EcrRepositoryName: 'ml-container-creator' },
                registry: { AiRegistryHubName: `mlcc-registry-${TEST_ACCOUNT_ID}` }
            },
            roleArn: TEST_ROLE_ARN,
            ecrRepositoryName: 'ml-container-creator'
        }
    } = opts;

    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });

    const logs = [];
    const modulesProvisioned = [];

    // Mock config
    handler.config = {
        getActiveProfile: () => ({
            name: TEST_PROFILE_NAME,
            config: { ...profileConfig }
        }),
        setProfile: () => {}
    };

    // Mock _getCallerAccount
    handler._getCallerAccount = () => callerAccount;

    // Mock _provisionModules
    handler._provisionModules = async (ordered) => {
        const moduleOutputs = {};
        for (const m of ordered) {
            modulesProvisioned.push(m);
            moduleOutputs[m] = profileConfig.moduleOutputs?.[m] || {};
        }
        return moduleOutputs;
    };

    // Mock _runPostSetupChain
    handler._runPostSetupChain = async () => {};

    // Mock _displayProgress
    handler._displayProgress = () => {};

    // Capture console.log output
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    const restore = () => { console.log = origLog; };

    return { handler, logs, modulesProvisioned, restore };
}

describe('BootstrapCommandHandler._handleUpdate sanity checks', () => {
    let restoreFn;

    afterEach(() => {
        if (restoreFn) {
            restoreFn();
            restoreFn = null;
        }
    });

    describe('Account mismatch (Sanity Check 1)', () => {
        it('returns early without deploying when caller account differs from profile accountId', async () => {
            const { handler, logs, modulesProvisioned, restore } = setupHandler({
                callerAccount: '999999999999'
            });
            restoreFn = restore;

            await handler._handleUpdate();

            assert.ok(
                logs.some(l => l.includes('Account mismatch') && l.includes(TEST_ACCOUNT_ID) && l.includes('999999999999')),
                'should display account mismatch error with both account IDs'
            );
            assert.strictEqual(modulesProvisioned.length, 0,
                'should not provision any modules when account mismatches');
        });
    });

    describe('Normal update flow', () => {
        it('re-provisions all modules in topological order', async () => {
            const { handler, modulesProvisioned, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate();

            assert.ok(modulesProvisioned.includes('core'), 'should re-provision core');
            assert.ok(modulesProvisioned.includes('registry'), 'should re-provision registry');
            // Core should come before registry (topological order)
            assert.ok(
                modulesProvisioned.indexOf('core') < modulesProvisioned.indexOf('registry'),
                'core should be provisioned before registry'
            );
        });

        it('denormalizes module outputs into flat profile keys', async () => {
            let savedProfile = null;
            const { handler, restore } = setupHandler();
            restoreFn = restore;

            handler.config.setProfile = (name, config) => {
                savedProfile = config;
            };

            await handler._handleUpdate();

            assert.ok(savedProfile, 'should save the profile');
            assert.strictEqual(savedProfile.roleArn, TEST_ROLE_ARN, 'should denormalize roleArn');
            assert.strictEqual(savedProfile.ecrRepositoryName, 'ml-container-creator', 'should denormalize ecrRepositoryName');
        });
    });
});

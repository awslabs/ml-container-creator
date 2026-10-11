// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for BootstrapCommandHandler._handleUpdate() scoped redeploy (BL102)
 *
 * Covers the `--module <name>` flag on `mcc bootstrap update`:
 * 1. Scoped deploy — only the named module's CDK stack is deployed.
 * 2. Validation — unknown module errors and lists provisioned modules.
 * 3. Default behavior — no `--module` still deploys all modules.
 * 4. Profile preservation — scoped redeploy keeps the full provisioned set.
 */

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const TEST_ACCOUNT_ID = '123456789012';
const TEST_REGION = 'us-west-2';
const TEST_PROFILE_NAME = 'mlcc-us-west-2';
const TEST_AWS_PROFILE = 'my-aws-profile';
const TEST_ROLE_ARN = `arn:aws:iam::${TEST_ACCOUNT_ID}:role/mlcc-sagemaker-execution-role`;

function setupHandler(opts = {}) {
    const {
        callerAccount = TEST_ACCOUNT_ID,
        profileConfig = {
            awsProfile: TEST_AWS_PROFILE,
            awsRegion: TEST_REGION,
            accountId: TEST_ACCOUNT_ID,
            provisionedModules: ['core', 'registry', 'benchmark'],
            moduleOutputs: {
                core: { RoleArn: TEST_ROLE_ARN, EcrRepositoryName: 'ml-container-creator' },
                registry: { ModelPackageGroupName: `mlcc-${TEST_ACCOUNT_ID}-models` },
                benchmark: { BenchmarkBucket: `mlcc-benchmark-${TEST_ACCOUNT_ID}` }
            },
            roleArn: TEST_ROLE_ARN,
            ecrRepositoryName: 'ml-container-creator'
        }
    } = opts;

    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });

    const logs = [];
    const modulesProvisioned = [];
    let savedProfile = null;

    handler.config = {
        getActiveProfile: () => ({
            name: TEST_PROFILE_NAME,
            config: { ...profileConfig }
        }),
        setProfile: (name, config) => { savedProfile = config; }
    };

    handler._getCallerAccount = () => callerAccount;

    handler._provisionModules = async (ordered) => {
        const moduleOutputs = {};
        for (const m of ordered) {
            modulesProvisioned.push(m);
            moduleOutputs[m] = profileConfig.moduleOutputs?.[m] || {};
        }
        return moduleOutputs;
    };

    handler._runPostSetupChain = async () => {};
    handler._displayProgress = () => {};

    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    const restore = () => { console.log = origLog; };

    return {
        handler,
        logs,
        modulesProvisioned,
        getSavedProfile: () => savedProfile,
        restore
    };
}

describe('BootstrapCommandHandler._handleUpdate scoped module (BL102)', () => {
    let restoreFn;

    afterEach(() => {
        if (restoreFn) {
            restoreFn();
            restoreFn = null;
        }
    });

    describe('Scoped single-module deploy (Req 2)', () => {
        it('deploys only the named module when --module is supplied', async () => {
            const { handler, modulesProvisioned, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate({ module: 'registry' });

            assert.deepStrictEqual(modulesProvisioned, ['registry'],
                'should deploy only the named module');
        });

        it('does not deploy any other module stack when --module is supplied', async () => {
            const { handler, modulesProvisioned, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate({ module: 'benchmark' });

            assert.ok(!modulesProvisioned.includes('core'), 'should not deploy core');
            assert.ok(!modulesProvisioned.includes('registry'), 'should not deploy registry');
            assert.deepStrictEqual(modulesProvisioned, ['benchmark']);
        });
    });

    describe('Module name validation (Req 3)', () => {
        it('errors and deploys nothing when module is not provisioned', async () => {
            const { handler, modulesProvisioned, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate({ module: 'training' });

            assert.strictEqual(modulesProvisioned.length, 0,
                'should not deploy anything for an unprovisioned module');
            assert.ok(
                logs.some(l => l.includes('training') && l.includes('not provisioned')),
                'should report the module is not provisioned'
            );
        });

        it('lists available provisioned modules in the error output', async () => {
            const { handler, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate({ module: 'nope' });

            assert.ok(
                logs.some(l => l.includes('core') && l.includes('registry') && l.includes('benchmark')),
                'should list all provisioned modules'
            );
        });
    });

    describe('Profile preservation on scoped redeploy', () => {
        it('keeps the full provisioned module set after a scoped redeploy', async () => {
            const { handler, getSavedProfile, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate({ module: 'registry' });

            const saved = getSavedProfile();
            assert.ok(saved, 'should save the profile');
            assert.deepStrictEqual(
                saved.provisionedModules,
                ['core', 'registry', 'benchmark'],
                'should preserve all provisioned modules'
            );
        });

        it('merges scoped output without dropping other module outputs', async () => {
            const { handler, getSavedProfile, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate({ module: 'registry' });

            const saved = getSavedProfile();
            assert.ok(saved.moduleOutputs.core, 'core outputs preserved');
            assert.ok(saved.moduleOutputs.registry, 'registry outputs present');
            assert.ok(saved.moduleOutputs.benchmark, 'benchmark outputs preserved');
        });
    });

    describe('Default behavior unchanged (Req 4)', () => {
        it('deploys all provisioned modules when --module is absent', async () => {
            const { handler, modulesProvisioned, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate({});

            assert.ok(modulesProvisioned.includes('core'), 'should deploy core');
            assert.ok(modulesProvisioned.includes('registry'), 'should deploy registry');
            assert.ok(modulesProvisioned.includes('benchmark'), 'should deploy benchmark');
        });
    });
});

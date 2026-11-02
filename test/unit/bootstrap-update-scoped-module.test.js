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
 * 5. Comma-separated `--module a,b` deploys exactly those, in topological order.
 * 6. Bucket consolidation R1.5: the implicit bucket import runs inside the scoped
 *    path and never on another module; `--module x --dry-run` previews only x.
 */

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import { createRequire } from 'node:module';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';
import { loadModuleManifest } from '../../src/lib/bootstrap-module-selector.js';

const require = createRequire(import.meta.url);
const { CdkModuleRunner, CdkMultiStackModuleRunner } = require('../../infra/bootstrap-modules/module-runner.cjs');

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

    // Regression: `--module <name>` arrives in the passthrough `args` array (commander
    // stops option parsing at the `update` positional), so handle() must extract it into
    // options.module. Earlier the loop extracted --with but NOT --module, so the flag was
    // silently dropped and update diffed/redeployed every module. These tests drive the
    // full handle() → _handleUpdate wiring, not _handleUpdate directly, so they fail if
    // the extraction regresses.
    describe('handle() extracts --module from passthrough args (regression)', () => {
        it('scopes to the single module for `update --module <name>` (space form)', async () => {
            const { handler, modulesProvisioned, restore } = setupHandler();
            restoreFn = restore;

            await handler.handle(['update', '--module', 'benchmark'], {});

            assert.deepStrictEqual(modulesProvisioned, ['benchmark'],
                'only the --module target should be deployed');
        });

        it('scopes to the single module for `update --module=<name>` (equals form)', async () => {
            const { handler, modulesProvisioned, restore } = setupHandler();
            restoreFn = restore;

            await handler.handle(['update', '--module=benchmark'], {});

            assert.deepStrictEqual(modulesProvisioned, ['benchmark'],
                'only the --module= target should be deployed');
        });

        it('still deploys all modules for `update` with no --module', async () => {
            const { handler, modulesProvisioned, restore } = setupHandler();
            restoreFn = restore;

            await handler.handle(['update'], {});

            assert.ok(modulesProvisioned.includes('core'), 'should deploy core');
            assert.ok(modulesProvisioned.includes('registry'), 'should deploy registry');
            assert.ok(modulesProvisioned.includes('benchmark'), 'should deploy benchmark');
        });
    });

    describe('Comma-separated --module list', () => {
        it('deploys exactly the listed modules, in topological order', async () => {
            const { handler, modulesProvisioned, restore } = setupHandler();
            restoreFn = restore;

            await handler.handle(['update', '--module', 'benchmark,core'], {});

            assert.deepStrictEqual(modulesProvisioned, ['core', 'benchmark']);
        });

        it('rejects the whole list (deploys nothing) when any listed module is not provisioned', async () => {
            const { handler, modulesProvisioned, logs, restore } = setupHandler();
            restoreFn = restore;

            await handler._handleUpdate({ module: 'core,training' });

            assert.deepStrictEqual(modulesProvisioned, []);
            assert.ok(logs.some(l => l.includes('"training"') && l.includes('not provisioned')));
        });
    });

    // R1.5: the implicit import is a step of runner.provision(), so a scoped update
    // imports + deploys only the scoped module. These drive the REAL _provisionModules /
    // dry-run path with the runner's AWS seams stubbed on the prototypes.
    describe('Scoped update and the implicit bucket import (bucket consolidation R1.5)', () => {
        const ALL = ['core', 'training', 'benchmark', 'ci', 'eks', 'hyperpod'];
        const STUBBED = ['_cleanupUnupdatableStack', 'status', '_importUnownedBuckets', '_cdkDeploy', '_getStackOutputs',
            '_previewBucketImports', '_cdkDiff', '_computeAdoptFlags', '_aws'];
        let saved;
        let events;

        function stubRunners() {
            events = [];
            saved = { single: {}, multi: {} };
            for (const k of STUBBED) saved.single[k] = CdkModuleRunner.prototype[k];
            saved.multi.provision = CdkMultiStackModuleRunner.prototype.provision;
            saved.multi.diff = CdkMultiStackModuleRunner.prototype.diff;
            const P = CdkModuleRunner.prototype;
            P._cleanupUnupdatableStack = async function () {};
            P.status = async function () { return { state: 'provisioned' }; };
            P._importUnownedBuckets = function () { events.push(['import', this.stackNameSuffix]); return ['zz-bucket']; };
            P._cdkDeploy = function () { events.push(['deploy', this.stackNameSuffix]); };
            P._getStackOutputs = function () { return {}; };
            P._previewBucketImports = function () { events.push(['preview', this.stackNameSuffix]); return []; };
            P._cdkDiff = function () { events.push(['diff', this.stackNameSuffix]); };
            P._computeAdoptFlags = function () { return []; };
            P._aws = function (_p, args) { events.push(['aws', this.stackNameSuffix, args[1]]); return ''; };
            CdkMultiStackModuleRunner.prototype.provision = async function () { events.push(['multi-provision', this.name]); return {}; };
            CdkMultiStackModuleRunner.prototype.diff = async function () { events.push(['multi-diff', this.name]); };
        }

        afterEach(() => {
            if (!saved) return;
            for (const k of STUBBED) CdkModuleRunner.prototype[k] = saved.single[k];
            CdkMultiStackModuleRunner.prototype.provision = saved.multi.provision;
            CdkMultiStackModuleRunner.prototype.diff = saved.multi.diff;
            saved = null;
        });

        it('`update --module training` imports + deploys ONLY the training stack', async () => {
            const { handler, restore } = setupHandler();
            restoreFn = restore;
            stubRunners();
            handler._ensureModuleDeps = () => {};

            // _handleUpdate narrows to ['training'] (asserted by the tests above);
            // this is the REAL provision path it hands that list to (setupHandler
            // stubs the instance method, so call the prototype).
            const out = await BootstrapCommandHandler.prototype._provisionModules.call(handler, ['training'], loadModuleManifest(), TEST_PROFILE_NAME,
                TEST_ACCOUNT_ID, TEST_REGION, TEST_AWS_PROFILE, { forceDeploy: true });

            assert.ok(out && out.training, 'training outputs returned');
            assert.deepStrictEqual(events, [['import', 'training'], ['deploy', 'training']]);
        });

        it('a scoped update never invokes provision / import on any other module', async () => {
            const { handler, restore } = setupHandler({
                profileConfig: { awsProfile: TEST_AWS_PROFILE, awsRegion: TEST_REGION, accountId: TEST_ACCOUNT_ID, provisionedModules: ALL, moduleOutputs: {} }
            });
            restoreFn = restore;
            stubRunners();
            handler._ensureModuleDeps = () => {};
            let handedOff;
            const real = BootstrapCommandHandler.prototype._provisionModules;
            handler._provisionModules = async function (ordered, ...rest) {
                handedOff = ordered;
                return real.call(this, ordered, ...rest);
            };

            await handler._handleUpdate({ module: 'core' });

            assert.deepStrictEqual(handedOff, ['core']);
            const touched = new Set(events.map(e => e[1]));
            assert.deepStrictEqual([...touched], ['core'], `only core touched, got ${JSON.stringify(events)}`);
            assert.ok(!events.some(e => e[0].startsWith('multi-')), 'eks / hyperpod never provisioned');
        });

        it('`update --module training --dry-run` previews only training imports + cdk diff, read-only', async () => {
            const { handler, modulesProvisioned, getSavedProfile, logs, restore } = setupHandler({
                profileConfig: { awsProfile: TEST_AWS_PROFILE, awsRegion: TEST_REGION, accountId: TEST_ACCOUNT_ID, provisionedModules: ALL, moduleOutputs: {} }
            });
            restoreFn = restore;
            stubRunners();
            handler._ensureModuleDeps = () => {};

            await handler.handle(['update', '--module', 'training', '--dry-run'], {});

            assert.deepStrictEqual(events, [['preview', 'training'], ['diff', 'training']]);
            assert.deepStrictEqual(modulesProvisioned, [], 'nothing provisioned');
            assert.strictEqual(getSavedProfile(), null, 'profile not written');
            assert.ok(logs.some(l => l.includes('no change set is created')));
        });
    });
});

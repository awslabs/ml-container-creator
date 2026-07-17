// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Modular Provisioning Invariant Property-Based Tests
 *
 * Property 1: Module Provisioning Invariant
 *
 * After `_handleInteractiveSetup` completes in non-interactive mode,
 * `profile.provisionedModules` always contains 'core' and 'registry' (defaults),
 * plus any modules specified via --with. The profile always has moduleOutputs
 * and denormalized flat keys (roleArn, ecrRepositoryName, etc.).
 *
 * Feature: modular-bootstrap, Property 1: Module Provisioning Invariant
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';
import { PROPERTY_CONFIG_EJS } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

const arbProfileName = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
    .filter(s => s.length >= 2 && !s.endsWith('-'));

const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1',
    'ap-northeast-1', 'eu-central-1', 'sa-east-1'
);

const arbAccountId = fc.stringMatching(/^[0-9]{12}$/);

// Generate dependency-valid module subsets.
// Defaults are core + registry (always included). ci requires benchmark (in addition to core + registry).
// All others only depend on core which is always present.
const arbExtraModules = fc.subarray(
    ['benchmark', 'training', 'ci', 'sagemaker-domain', 'hyperpod-cluster'],
    { minLength: 0, maxLength: 3 }
).map(modules => {
    // Satisfy ci's dependency on benchmark
    if (modules.includes('ci') && !modules.includes('benchmark')) {
        modules.push('benchmark');
    }
    return modules;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function suppressConsole(fn) {
    const originalLog = console.log;
    console.log = () => {};
    try {
        return await fn();
    } finally {
        console.log = originalLog;
    }
}

function createMockHandler(configPath, { accountId, region }) {
    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
    handler.config = new BootstrapConfig(configPath);

    handler.provisioners = { _verifyCliV2: () => true, provisionAiRegistryHub: async () => {} };
    handler._displayProgress = () => {};
    handler._displaySummary = () => {};
    handler._validateCredentials = async () => ({ accountId, region });
    handler._selectProfile = async () => 'test-aws-profile';
    handler._runPostSetupChain = async () => {};
    handler._resourceExists = () => true; // CDK already bootstrapped
    handler._execAws = () => [];

    // Mock _provisionModules to return synthetic outputs
    handler._provisionModules = async (ordered, _manifest, _profileName, acctId, reg) => {
        const moduleOutputs = {};
        for (const m of ordered) {
            switch (m) {
            case 'core':
                moduleOutputs.core = {
                    RoleArn: `arn:aws:iam::${acctId}:role/mlcc-sagemaker-execution-role`,
                    EcrRepositoryName: 'ml-container-creator'
                };
                break;
            case 'registry':
                moduleOutputs.registry = { AiRegistryHubName: `mlcc-registry-${acctId}` };
                break;
            case 'benchmark':
                moduleOutputs.benchmark = { BenchmarkBucket: `mlcc-benchmark-results-${acctId}-${reg}`, GlueDatabase: 'mlcc_ci' };
                break;
            case 'training':
                moduleOutputs.training = { TrainingBucket: `mlcc-training-${acctId}-${reg}` };
                break;
            case 'hyperpod-cluster':
                moduleOutputs['hyperpod-cluster'] = {
                    HyperPodClusterArn: `arn:aws:sagemaker:${reg}:${acctId}:cluster/test-cluster`,
                    HyperPodClusterName: 'test-cluster'
                };
                break;
            default:
                moduleOutputs[m] = {};
            }
        }
        return moduleOutputs;
    };

    return handler;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: modular-bootstrap, Property 1: Module Provisioning Invariant', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-modular-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('provisionedModules always contains core+registry defaults and any --with modules', async function () {
        this.timeout(180000);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            arbExtraModules,
            async (profileName, region, accountId, extraModules) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                const handler = createMockHandler(configPath, { accountId, region });

                const withValue = extraModules.length > 0 ? extraModules.join(',') : undefined;

                await suppressConsole(async () => {
                    await handler._handleInteractiveSetup({
                        'non-interactive': true,
                        name: profileName,
                        profile: 'test-aws-profile',
                        region,
                        ...(withValue ? { with: withValue } : {})
                    });
                });

                const config = handler.config.read();
                assert.ok(config, 'Config should have been written');
                assert.ok(config.profiles, 'Config should have profiles');

                const savedProfile = config.profiles[profileName];
                assert.ok(savedProfile, `Profile "${profileName}" should exist`);

                // THE INVARIANT: provisionedModules always includes core + registry
                assert.ok(savedProfile.provisionedModules, 'should have provisionedModules');
                assert.ok(savedProfile.provisionedModules.includes('core'), 'core must always be provisioned');
                assert.ok(savedProfile.provisionedModules.includes('registry'), 'registry must always be provisioned (default)');

                // Extra modules from --with should also be present
                for (const m of extraModules) {
                    assert.ok(
                        savedProfile.provisionedModules.includes(m),
                        `--with module "${m}" should be in provisionedModules`
                    );
                }

                // Denormalization invariant: flat keys should be derived from moduleOutputs
                assert.ok(savedProfile.moduleOutputs, 'should have moduleOutputs');
                assert.ok(savedProfile.roleArn, 'roleArn should be denormalized from core');
                assert.strictEqual(savedProfile.ecrRepositoryName, 'ml-container-creator');
            }
        ), { ...PROPERTY_CONFIG_EJS });
    });
});

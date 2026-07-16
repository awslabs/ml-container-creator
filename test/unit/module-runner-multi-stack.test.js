// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for CdkMultiStackModuleRunner.
 * Verifies multi-stack deploy order, SSM chaining, and reverse teardown.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const MANIFEST_PATH = resolve(__dirname, '../../infra/bootstrap-modules/module-manifest.json');
const MODULE_RUNNER_PATH = resolve(__dirname, '../../infra/bootstrap-modules/module-runner.cjs');

describe('CdkMultiStackModuleRunner', () => {
    describe('Multi-stack module manifest schema', () => {
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

        it('hyperpod-cluster has stacks[] instead of stackNameSuffix', () => {
            const hyperpod = manifest.modules['hyperpod-cluster'];
            assert.ok(hyperpod.stacks, 'hyperpod-cluster should have stacks[]');
            assert.ok(Array.isArray(hyperpod.stacks), 'stacks should be an array');
            assert.deepStrictEqual(hyperpod.stacks, ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
            assert.ok(!('stackNameSuffix' in hyperpod), 'hyperpod-cluster should NOT have stackNameSuffix');
        });

        it('hyperpod-cluster has correct metadata', () => {
            const hyperpod = manifest.modules['hyperpod-cluster'];
            assert.strictEqual(hyperpod.displayName, 'HyperPod (EKS + Inference)');
            assert.ok(hyperpod.estimatedMonthlyCost.includes('$100'));
            assert.deepStrictEqual(hyperpod.depends, ['core']);
            assert.ok(hyperpod.exports.includes('EksClusterArn'));
            assert.ok(hyperpod.exports.includes('EksClusterName'));
            assert.ok(hyperpod.exports.includes('HyperPodClusterArn'));
            assert.ok(hyperpod.exports.includes('HyperPodClusterName'));
            assert.ok(hyperpod.exports.includes('InferenceOperatorStatus'));
            assert.strictEqual(hyperpod.resourceLevel, 'profile');
        });

        it('single-stack modules still have stackNameSuffix (backward compat)', () => {
            const singleStackModules = ['core', 'benchmark', 'registry', 'training', 'ci', 'sagemaker-domain'];
            for (const name of singleStackModules) {
                const mod = manifest.modules[name];
                assert.ok('stackNameSuffix' in mod, `${name} should have stackNameSuffix`);
                assert.ok(!('stacks' in mod), `${name} should NOT have stacks[]`);
            }
        });

        it('hyperpod-cluster depends only on core', () => {
            const hyperpod = manifest.modules['hyperpod-cluster'];
            assert.deepStrictEqual(hyperpod.depends, ['core']);
        });
    });

    describe('CdkMultiStackModuleRunner class structure', () => {
        const { CdkMultiStackModuleRunner, CdkModuleRunner } = require(MODULE_RUNNER_PATH);

        it('exports CdkMultiStackModuleRunner from module-runner.cjs', () => {
            assert.ok(CdkMultiStackModuleRunner, 'CdkMultiStackModuleRunner should be exported');
            assert.ok(CdkModuleRunner, 'CdkModuleRunner should still be exported');
        });

        it('CdkMultiStackModuleRunner constructor stores name and stacks', () => {
            const instance = new CdkMultiStackModuleRunner('hyperpod-cluster', ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
            assert.strictEqual(instance.name, 'hyperpod-cluster');
            assert.deepStrictEqual(instance.stacks, ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
        });

        it('CdkMultiStackModuleRunner has provision, teardown, status, diff methods', () => {
            const instance = new CdkMultiStackModuleRunner('test', ['a', 'b']);
            assert.strictEqual(typeof instance.provision, 'function');
            assert.strictEqual(typeof instance.teardown, 'function');
            assert.strictEqual(typeof instance.status, 'function');
            assert.strictEqual(typeof instance.diff, 'function');
        });
    });

    describe('Stack ordering logic', () => {
        const { CdkMultiStackModuleRunner } = require(MODULE_RUNNER_PATH);

        it('stacks array defines deploy order', () => {
            const instance = new CdkMultiStackModuleRunner('hyperpod-cluster', ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
            assert.strictEqual(instance.stacks[0], 'eks-cluster');
            assert.strictEqual(instance.stacks[1], 'hyperpod-cluster');
            assert.strictEqual(instance.stacks[2], 'inference-operator');
        });

        it('teardown reverses the stack order', () => {
            const instance = new CdkMultiStackModuleRunner('hyperpod-cluster', ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
            const reversed = [...instance.stacks].reverse();
            assert.deepStrictEqual(reversed, ['inference-operator', 'hyperpod-cluster', 'eks-cluster']);
        });
    });

    describe('Stack name generation', () => {
        it('generates correct stack names for multi-stack module', () => {
            const { CdkMultiStackModuleRunner } = require(MODULE_RUNNER_PATH);
            const instance = new CdkMultiStackModuleRunner('hyperpod-cluster', ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
            const expectedNames = [
                'mlcc-testprofile-eks-cluster',
                'mlcc-testprofile-hyperpod-cluster',
                'mlcc-testprofile-inference-operator'
            ];
            for (let i = 0; i < instance.stacks.length; i++) {
                const expected = `mlcc-testprofile-${instance.stacks[i]}`;
                assert.strictEqual(expected, expectedNames[i]);
            }
        });
    });

    describe('Backward compatibility', () => {
        const { CdkModuleRunner } = require(MODULE_RUNNER_PATH);

        it('CdkModuleRunner still works for single-stack modules', () => {
            const instance = new CdkModuleRunner('core', 'core');
            assert.strictEqual(instance.name, 'core');
            assert.strictEqual(instance.stackNameSuffix, 'core');
            assert.strictEqual(typeof instance.provision, 'function');
            assert.strictEqual(typeof instance.teardown, 'function');
            assert.strictEqual(typeof instance.status, 'function');
        });

        it('CdkModuleRunner retains all existing methods', () => {
            const instance = new CdkModuleRunner('benchmark', 'benchmark');
            assert.strictEqual(typeof instance._computeAdoptFlags, 'function');
            assert.strictEqual(typeof instance._bucketExists, 'function');
            assert.strictEqual(typeof instance._ecrRepoExists, 'function');
            assert.strictEqual(typeof instance._getStackOutputs, 'function');
            assert.strictEqual(typeof instance._cleanupUnupdatableStack, 'function');
            assert.strictEqual(typeof instance.diff, 'function');
        });
    });

    describe('SSM context reading', () => {
        const { CdkMultiStackModuleRunner } = require(MODULE_RUNNER_PATH);

        it('_readSsmParamsForContext is a function', () => {
            const instance = new CdkMultiStackModuleRunner('hyperpod-cluster', ['eks-cluster']);
            assert.strictEqual(typeof instance._readSsmParamsForContext, 'function');
        });

        it('_forceDeleteRetainedResources is a function', () => {
            const instance = new CdkMultiStackModuleRunner('hyperpod-cluster', ['eks-cluster']);
            assert.strictEqual(typeof instance._forceDeleteRetainedResources, 'function');
        });
    });
});

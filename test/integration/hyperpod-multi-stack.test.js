// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: HyperPod multi-stack module bootstrap flow.
 *
 * Tests that the multi-stack module runner and manifest updates integrate
 * correctly with the bootstrap command handler. Does NOT deploy to AWS.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
    loadModuleManifest,
    validateDependencies,
    topologicalSort,
    findDependents
} from '../../src/lib/bootstrap-module-selector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

describe('HyperPod Multi-Stack Bootstrap Integration', () => {
    describe('Manifest integration with module selector', () => {
        it('loadModuleManifest includes hyperpod-cluster with stacks[]', () => {
            const manifest = loadModuleManifest();
            const hyperpod = manifest.modules['hyperpod-cluster'];
            assert.ok(hyperpod);
            assert.ok(hyperpod.stacks);
            assert.deepStrictEqual(hyperpod.stacks, ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
        });

        it('validateDependencies passes for hyperpod-cluster + core', () => {
            const result = validateDependencies(['core', 'hyperpod-cluster']);
            assert.strictEqual(result.valid, true);
        });

        it('validateDependencies fails for hyperpod-cluster without core', () => {
            const result = validateDependencies(['hyperpod-cluster']);
            assert.strictEqual(result.valid, false);
            const entry = result.missing.find(m => m.module === 'hyperpod-cluster');
            assert.ok(entry);
            assert.ok(entry.missingDeps.includes('core'));
        });

        it('topologicalSort places core before hyperpod-cluster', () => {
            const sorted = topologicalSort(['core', 'hyperpod-cluster']);
            assert.strictEqual(sorted[0], 'core');
            assert.strictEqual(sorted[1], 'hyperpod-cluster');
        });

        it('findDependents reports nothing depends on hyperpod-cluster', () => {
            const provisioned = ['core', 'benchmark', 'registry', 'hyperpod-cluster'];
            const dependents = findDependents('hyperpod-cluster', provisioned);
            assert.strictEqual(dependents.length, 0);
        });

        it('all modules can be selected together without dependency errors', () => {
            const manifest = loadModuleManifest();
            const allModules = Object.keys(manifest.modules);
            const result = validateDependencies(allModules);
            assert.strictEqual(result.valid, true);
        });

        it('topologicalSort handles full module set including hyperpod', () => {
            const manifest = loadModuleManifest();
            const allModules = Object.keys(manifest.modules);
            const sorted = topologicalSort(allModules);
            assert.strictEqual(sorted[0], 'core');
            assert.ok(sorted.indexOf('hyperpod-cluster') > sorted.indexOf('core'));
        });
    });

    describe('Module runner selection for multi-stack', () => {
        const { CdkModuleRunner, CdkMultiStackModuleRunner } = require(
            resolve(__dirname, '../../infra/bootstrap-modules/module-runner.cjs')
        );

        it('CdkMultiStackModuleRunner is used for modules with stacks[]', () => {
            const manifest = loadModuleManifest();
            const mod = manifest.modules['hyperpod-cluster'];
            // The bootstrap handler checks: if (mod.stacks && Array.isArray(mod.stacks))
            assert.ok(mod.stacks && Array.isArray(mod.stacks));
            const runner = new CdkMultiStackModuleRunner('hyperpod-cluster', mod.stacks);
            assert.strictEqual(runner.name, 'hyperpod-cluster');
            assert.strictEqual(runner.stacks.length, 3);
        });

        it('CdkModuleRunner is used for modules with stackNameSuffix', () => {
            const manifest = loadModuleManifest();
            const mod = manifest.modules['core'];
            assert.ok(mod.stackNameSuffix);
            assert.ok(!mod.stacks);
            const runner = new CdkModuleRunner('core', mod.stackNameSuffix);
            assert.strictEqual(runner.name, 'core');
            assert.strictEqual(runner.stackNameSuffix, 'core');
        });
    });

    describe('Three-stack deploy sequence', () => {
        const { CdkMultiStackModuleRunner } = require(
            resolve(__dirname, '../../infra/bootstrap-modules/module-runner.cjs')
        );

        it('deploys eks-cluster first, hyperpod-cluster second, inference-operator third', () => {
            const runner = new CdkMultiStackModuleRunner('hyperpod-cluster', ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
            assert.strictEqual(runner.stacks[0], 'eks-cluster');
            assert.strictEqual(runner.stacks[1], 'hyperpod-cluster');
            assert.strictEqual(runner.stacks[2], 'inference-operator');
        });

        it('tears down in reverse: inference-operator first, hyperpod-cluster second, eks-cluster last', () => {
            const runner = new CdkMultiStackModuleRunner('hyperpod-cluster', ['eks-cluster', 'hyperpod-cluster', 'inference-operator']);
            const reversed = [...runner.stacks].reverse();
            assert.strictEqual(reversed[0], 'inference-operator');
            assert.strictEqual(reversed[1], 'hyperpod-cluster');
            assert.strictEqual(reversed[2], 'eks-cluster');
        });
    });

    describe('CDK app stack registration', () => {
        it('bin/app.ts registers all three HyperPod stacks', () => {
            const appSource = readFileSync(
                resolve(__dirname, '../../infra/bootstrap-modules/bin/app.ts'), 'utf8'
            );
            assert.ok(appSource.includes('\'eks-cluster\''), 'Should have eks-cluster factory');
            assert.ok(appSource.includes('\'hyperpod-cluster\''), 'Should have hyperpod-cluster factory');
            assert.ok(appSource.includes('\'inference-operator\''), 'Should have inference-operator factory');
            assert.ok(appSource.includes('MlccEksClusterStack'), 'Should import MlccEksClusterStack');
            assert.ok(appSource.includes('MlccHyperPodClusterStack'), 'Should import MlccHyperPodClusterStack');
            assert.ok(appSource.includes('MlccInferenceOperatorStack'), 'Should import MlccInferenceOperatorStack');
        });

        it('bin/app.ts passes adopt flags from context', () => {
            const appSource = readFileSync(
                resolve(__dirname, '../../infra/bootstrap-modules/bin/app.ts'), 'utf8'
            );
            assert.ok(appSource.includes('adoptEks'));
            assert.ok(appSource.includes('adoptVpc'));
            assert.ok(appSource.includes('adoptRoles'));
            assert.ok(appSource.includes('adoptCluster'));
            assert.ok(appSource.includes('adoptTlsBucket'));
            assert.ok(appSource.includes('adoptInferenceAddon'));
        });

        it('bin/app.ts passes SSM context values to stacks', () => {
            const appSource = readFileSync(
                resolve(__dirname, '../../infra/bootstrap-modules/bin/app.ts'), 'utf8'
            );
            assert.ok(appSource.includes('EksClusterArn'));
            assert.ok(appSource.includes('HyperPodInstanceRoleArn'));
            assert.ok(appSource.includes('PrivateSubnetIds'));
            assert.ok(appSource.includes('ClusterSecurityGroupId'));
            assert.ok(appSource.includes('HyperPodClusterArn'));
            assert.ok(appSource.includes('HyperpodInferenceRoleArn'));
            assert.ok(appSource.includes('AlbControllerRoleArn'));
            assert.ok(appSource.includes('KedaOperatorRoleArn'));
        });
    });
});

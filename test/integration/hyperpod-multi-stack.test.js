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
        // BL143: the combined hyperpod-cluster module was split into `eks` (owns
        // eks-cluster) + `hyperpod` (owns hyperpod-cluster + inference-operator,
        // depends on eks).

        it('loadModuleManifest includes eks + hyperpod with stacks[], no combined module', () => {
            const manifest = loadModuleManifest();
            assert.ok(!manifest.modules['hyperpod-cluster'], 'combined module removed');
            assert.deepStrictEqual(manifest.modules.eks.stacks, ['eks-cluster']);
            assert.deepStrictEqual(manifest.modules.hyperpod.stacks,
                ['hyperpod-cluster', 'inference-operator']);
        });

        it('validateDependencies passes for eks + core, and hyperpod + eks + core', () => {
            assert.strictEqual(validateDependencies(['core', 'eks']).valid, true);
            assert.strictEqual(validateDependencies(['core', 'eks', 'hyperpod']).valid, true);
        });

        it('validateDependencies fails for eks without core, and hyperpod without eks', () => {
            const eksNoCore = validateDependencies(['eks']);
            assert.strictEqual(eksNoCore.valid, false);
            assert.ok(eksNoCore.missing.find(m => m.module === 'eks').missingDeps.includes('core'));

            const hpNoEks = validateDependencies(['core', 'hyperpod']);
            assert.strictEqual(hpNoEks.valid, false);
            assert.ok(hpNoEks.missing.find(m => m.module === 'hyperpod').missingDeps.includes('eks'));
        });

        it('topologicalSort orders core → eks → hyperpod', () => {
            const sorted = topologicalSort(['core', 'eks', 'hyperpod']);
            assert.ok(sorted.indexOf('core') < sorted.indexOf('eks'));
            assert.ok(sorted.indexOf('eks') < sorted.indexOf('hyperpod'));
        });

        it('findDependents reports hyperpod depends on eks', () => {
            const provisioned = ['core', 'eks', 'hyperpod'];
            const dependents = findDependents('eks', provisioned);
            assert.ok(dependents.includes('hyperpod'), 'hyperpod depends on eks');
        });

        it('all modules can be selected together without dependency errors', () => {
            const manifest = loadModuleManifest();
            const allModules = Object.keys(manifest.modules);
            const result = validateDependencies(allModules);
            assert.strictEqual(result.valid, true);
        });

        it('topologicalSort handles full module set (eks before hyperpod, core first)', () => {
            const manifest = loadModuleManifest();
            const allModules = Object.keys(manifest.modules);
            const sorted = topologicalSort(allModules);
            assert.strictEqual(sorted[0], 'core');
            assert.ok(sorted.indexOf('eks') > sorted.indexOf('core'));
            assert.ok(sorted.indexOf('hyperpod') > sorted.indexOf('eks'));
        });
    });

    describe('Module runner selection for multi-stack', () => {
        const { CdkModuleRunner, CdkMultiStackModuleRunner } = require(
            resolve(__dirname, '../../infra/bootstrap-modules/module-runner.cjs')
        );

        it('CdkMultiStackModuleRunner is used for the hyperpod module (2 stacks)', () => {
            const manifest = loadModuleManifest();
            const mod = manifest.modules.hyperpod;
            assert.ok(mod.stacks && Array.isArray(mod.stacks));
            const runner = new CdkMultiStackModuleRunner('hyperpod', mod.stacks);
            assert.strictEqual(runner.name, 'hyperpod');
            assert.strictEqual(runner.stacks.length, 2);
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

        it('bin/app.ts: eks drops adoptEks/adoptVpc, keeps adoptRoles (Option 1)', () => {
            const appSource = readFileSync(
                resolve(__dirname, '../../infra/bootstrap-modules/bin/app.ts'), 'utf8'
            );
            // Cluster + VPC always create (no adoptEks/adoptVpc). RETAIN'd service roles
            // are adopted on re-provision, so adoptRoles is still passed from context.
            assert.ok(!appSource.includes('adoptEks'), 'adoptEks removed');
            assert.ok(!appSource.includes('adoptVpc'), 'adoptVpc removed');
            assert.ok(appSource.includes('adoptRoles'), 'adoptRoles kept for RETAINed service roles');
            // The inference-operator still adopts its TLS bucket + addon (unchanged).
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

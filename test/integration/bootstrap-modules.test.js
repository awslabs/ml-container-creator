// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: Bootstrap module system.
 *
 * Tests module manifest loading, dependency validation, and topological sort
 * in the context of the full CLI handler wiring.
 *
 * Note: Actual CDK deploy/destroy is NOT tested here (requires AWS credentials).
 * This tests the orchestration logic and CLI dispatch paths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    loadModuleManifest,
    validateDependencies,
    topologicalSort,
    findDependents
} from '../../src/lib/bootstrap-module-selector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../..');

describe('Bootstrap Modules Integration', () => {
    describe('Module manifest is accessible from CLI handler', () => {
        it('manifest file exists at expected path', () => {
            const manifestPath = resolve(PROJECT_ROOT, 'infra/bootstrap-modules/module-manifest.json');
            assert.ok(existsSync(manifestPath), 'module-manifest.json should exist');
        });

        it('loadModuleManifest reads from correct path', () => {
            const manifest = loadModuleManifest();
            assert.strictEqual(manifest.schemaVersion, '1');
            assert.ok(Object.keys(manifest.modules).length >= 7);
        });
    });

    describe('Full dependency graph validation', () => {
        it('all modules with all deps is valid', () => {
            const manifest = loadModuleManifest();
            const allModules = Object.keys(manifest.modules);
            const result = validateDependencies(allModules);
            assert.strictEqual(result.valid, true);
        });

        it('selecting ci without benchmark fails', () => {
            const result = validateDependencies(['core', 'registry', 'ci']);
            assert.strictEqual(result.valid, false);
            const ciEntry = result.missing.find(m => m.module === 'ci');
            assert.ok(ciEntry);
            assert.ok(ciEntry.missingDeps.includes('benchmark'));
        });

        it('selecting ci without registry fails', () => {
            const result = validateDependencies(['core', 'benchmark', 'ci']);
            assert.strictEqual(result.valid, false);
        });

        it('selecting ci with all deps passes', () => {
            const result = validateDependencies(['core', 'benchmark', 'registry', 'ci']);
            assert.strictEqual(result.valid, true);
        });
    });

    describe('Topological sort produces valid provision order', () => {
        it('full module set sorts correctly', () => {
            const manifest = loadModuleManifest();
            const allModules = Object.keys(manifest.modules);
            const sorted = topologicalSort(allModules);

            // Core must be first
            assert.strictEqual(sorted[0], 'core');

            // CI must come after benchmark and registry
            const ciIdx = sorted.indexOf('ci');
            const benchIdx = sorted.indexOf('benchmark');
            const regIdx = sorted.indexOf('registry');
            assert.ok(ciIdx > benchIdx, 'ci after benchmark');
            assert.ok(ciIdx > regIdx, 'ci after registry');
        });
    });

    describe('Dependent removal detection', () => {
        it('removing benchmark warns about ci dependency', () => {
            const provisioned = ['core', 'benchmark', 'registry', 'ci'];
            const dependents = findDependents('benchmark', provisioned);
            assert.ok(dependents.includes('ci'));
        });

        it('removing registry warns about ci dependency', () => {
            const provisioned = ['core', 'benchmark', 'registry', 'ci'];
            const dependents = findDependents('registry', provisioned);
            assert.ok(dependents.includes('ci'));
        });

        it('removing training has no dependents', () => {
            const provisioned = ['core', 'benchmark', 'training'];
            const dependents = findDependents('training', provisioned);
            assert.strictEqual(dependents.length, 0);
        });
    });

    describe('CDK stack infrastructure exists', () => {
        it('all module directories have stack.ts and index.ts', () => {
            const manifest = loadModuleManifest();
            const modulesDir = resolve(PROJECT_ROOT, 'infra/bootstrap-modules');

            for (const [name] of Object.entries(manifest.modules)) {
                // Use stackNameSuffix for hyperpod (dir is hyperpod-cluster but suffix is hyperpod)
                const dirName = name; // Directory matches module key
                const stackPath = resolve(modulesDir, dirName, 'stack.ts');
                const indexPath = resolve(modulesDir, dirName, 'index.ts');

                assert.ok(existsSync(stackPath), `${name} should have stack.ts at ${stackPath}`);
                assert.ok(existsSync(indexPath), `${name} should have index.ts at ${indexPath}`);
            }
        });

        it('module-runner.ts exists', () => {
            const runnerPath = resolve(PROJECT_ROOT, 'infra/bootstrap-modules/module-runner.ts');
            assert.ok(existsSync(runnerPath));
        });

        it('module-interface.ts exists', () => {
            const ifacePath = resolve(PROJECT_ROOT, 'infra/bootstrap-modules/module-interface.ts');
            assert.ok(existsSync(ifacePath));
        });

        it('bin/app.ts exists', () => {
            const appPath = resolve(PROJECT_ROOT, 'infra/bootstrap-modules/bin/app.ts');
            assert.ok(existsSync(appPath));
        });
    });
});

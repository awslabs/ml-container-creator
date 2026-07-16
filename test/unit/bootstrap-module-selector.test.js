// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for src/lib/bootstrap-module-selector.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    loadModuleManifest,
    validateDependencies,
    findDependents,
    topologicalSort
} from '../../src/lib/bootstrap-module-selector.js';

describe('Bootstrap Module Selector', () => {
    describe('loadModuleManifest', () => {
        it('loads and parses the module manifest', () => {
            const manifest = loadModuleManifest();
            assert.ok(manifest.schemaVersion);
            assert.ok(manifest.modules);
            assert.ok(manifest.modules.core);
        });

        it('core module is required', () => {
            const manifest = loadModuleManifest();
            assert.strictEqual(manifest.modules.core.required, true);
        });

        it('all modules have required fields', () => {
            const manifest = loadModuleManifest();
            const requiredFields = ['displayName', 'description', 'estimatedMonthlyCost', 'required', 'depends', 'exports'];

            for (const [name, config] of Object.entries(manifest.modules)) {
                for (const field of requiredFields) {
                    assert.ok(
                        field in config,
                        `Module "${name}" missing field: ${field}`
                    );
                }
                // Must have either stackNameSuffix or stacks[]
                assert.ok(
                    ('stackNameSuffix' in config) || ('stacks' in config),
                    `Module "${name}" must have either "stackNameSuffix" or "stacks[]"`
                );
            }
        });

        it('dependency references exist in manifest', () => {
            const manifest = loadModuleManifest();
            const moduleNames = Object.keys(manifest.modules);

            for (const [name, config] of Object.entries(manifest.modules)) {
                for (const dep of config.depends) {
                    assert.ok(
                        moduleNames.includes(dep),
                        `Module "${name}" depends on "${dep}" which is not in the manifest`
                    );
                }
            }
        });
    });

    describe('validateDependencies', () => {
        it('returns valid when all deps are satisfied', () => {
            const result = validateDependencies(['core', 'benchmark']);
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.missing.length, 0);
        });

        it('catches missing dependencies', () => {
            // ci depends on core + benchmark + registry
            const result = validateDependencies(['core', 'ci']);
            assert.strictEqual(result.valid, false);
            const ciMissing = result.missing.find(m => m.module === 'ci');
            assert.ok(ciMissing);
            assert.ok(ciMissing.missingDeps.includes('benchmark'));
            assert.ok(ciMissing.missingDeps.includes('registry'));
        });

        it('core alone is valid (no deps)', () => {
            const result = validateDependencies(['core']);
            assert.strictEqual(result.valid, true);
        });
    });

    describe('findDependents', () => {
        it('finds modules that depend on benchmark', () => {
            const provisioned = ['core', 'benchmark', 'registry', 'ci'];
            const dependents = findDependents('benchmark', provisioned);
            assert.ok(dependents.includes('ci'));
        });

        it('returns empty for core (everything depends on core but not tested here)', () => {
            // findDependents checks specific module — core's dependents are all non-core modules
            const provisioned = ['core', 'benchmark'];
            const dependents = findDependents('benchmark', provisioned);
            // benchmark has no dependents in this set (ci not provisioned)
            assert.strictEqual(dependents.length, 0);
        });

        it('returns empty when no dependents exist', () => {
            const provisioned = ['core', 'training'];
            const dependents = findDependents('training', provisioned);
            assert.strictEqual(dependents.length, 0);
        });
    });

    describe('topologicalSort', () => {
        it('sorts core before its dependents', () => {
            const sorted = topologicalSort(['benchmark', 'core']);
            assert.strictEqual(sorted[0], 'core');
            assert.strictEqual(sorted[1], 'benchmark');
        });

        it('respects multi-level dependencies', () => {
            // ci depends on core + benchmark + registry
            const sorted = topologicalSort(['ci', 'registry', 'benchmark', 'core']);
            const coreIdx = sorted.indexOf('core');
            const benchIdx = sorted.indexOf('benchmark');
            const regIdx = sorted.indexOf('registry');
            const ciIdx = sorted.indexOf('ci');

            assert.ok(coreIdx < benchIdx, 'core before benchmark');
            assert.ok(coreIdx < regIdx, 'core before registry');
            assert.ok(benchIdx < ciIdx, 'benchmark before ci');
            assert.ok(regIdx < ciIdx, 'registry before ci');
        });

        it('handles single module', () => {
            const sorted = topologicalSort(['core']);
            assert.deepStrictEqual(sorted, ['core']);
        });

        it('handles independent modules in any order', () => {
            const sorted = topologicalSort(['core', 'training', 'benchmark']);
            assert.strictEqual(sorted[0], 'core');
            // training and benchmark are independent — both just depend on core
            assert.ok(sorted.includes('training'));
            assert.ok(sorted.includes('benchmark'));
        });
    });
});

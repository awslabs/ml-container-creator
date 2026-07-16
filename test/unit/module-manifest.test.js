// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for infra/bootstrap-modules/module-manifest.json schema validation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_PATH = resolve(__dirname, '../../infra/bootstrap-modules/module-manifest.json');

describe('Module Manifest Schema', () => {
    let manifest;

    it('loads as valid JSON', () => {
        const raw = readFileSync(MANIFEST_PATH, 'utf8');
        manifest = JSON.parse(raw);
        assert.ok(manifest);
    });

    it('has schemaVersion field', () => {
        assert.ok(manifest.schemaVersion);
    });

    it('has modules object', () => {
        assert.ok(manifest.modules);
        assert.strictEqual(typeof manifest.modules, 'object');
    });

    it('all modules have required fields', () => {
        const requiredFields = [
            'displayName', 'description', 'estimatedMonthlyCost',
            'required', 'depends', 'exports'
        ];

        for (const [name, config] of Object.entries(manifest.modules)) {
            for (const field of requiredFields) {
                assert.ok(
                    field in config,
                    `Module "${name}" is missing required field "${field}"`
                );
            }
            // Type checks
            assert.strictEqual(typeof config.displayName, 'string', `${name}.displayName must be string`);
            assert.strictEqual(typeof config.description, 'string', `${name}.description must be string`);
            assert.strictEqual(typeof config.required, 'boolean', `${name}.required must be boolean`);
            assert.ok(Array.isArray(config.depends), `${name}.depends must be array`);
            assert.ok(Array.isArray(config.exports), `${name}.exports must be array`);

            // Must have either stackNameSuffix OR stacks[] (mutually exclusive)
            const hasStackNameSuffix = 'stackNameSuffix' in config;
            const hasStacks = 'stacks' in config && Array.isArray(config.stacks);
            assert.ok(
                hasStackNameSuffix || hasStacks,
                `Module "${name}" must have either "stackNameSuffix" or "stacks[]"`
            );
            if (hasStacks) {
                assert.ok(!hasStackNameSuffix, `Module "${name}" has both "stackNameSuffix" and "stacks[]" — use one or the other`);
                assert.ok(config.stacks.length > 0, `Module "${name}" stacks[] must not be empty`);
            } else {
                assert.strictEqual(typeof config.stackNameSuffix, 'string', `${name}.stackNameSuffix must be string`);
            }
        }
    });

    it('dependency references exist in manifest', () => {
        const moduleNames = new Set(Object.keys(manifest.modules));

        for (const [name, config] of Object.entries(manifest.modules)) {
            for (const dep of config.depends) {
                assert.ok(
                    moduleNames.has(dep),
                    `Module "${name}" depends on "${dep}" which does not exist in the manifest`
                );
            }
        }
    });

    it('has no circular dependencies', () => {
        const modules = manifest.modules;
        const visited = new Set();
        const inStack = new Set();

        function hasCycle(name) {
            if (inStack.has(name)) return true;
            if (visited.has(name)) return false;

            visited.add(name);
            inStack.add(name);

            const config = modules[name];
            if (config) {
                for (const dep of config.depends) {
                    if (hasCycle(dep)) return true;
                }
            }

            inStack.delete(name);
            return false;
        }

        for (const name of Object.keys(modules)) {
            assert.ok(!hasCycle(name), `Circular dependency detected involving module: ${name}`);
        }
    });

    it('exactly one required module (core)', () => {
        const requiredModules = Object.entries(manifest.modules)
            .filter(([, config]) => config.required)
            .map(([name]) => name);

        assert.deepStrictEqual(requiredModules, ['core']);
    });

    it('core has no dependencies', () => {
        assert.deepStrictEqual(manifest.modules.core.depends, []);
    });
});

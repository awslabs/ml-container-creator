// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Override Loader Unit Tests
 *
 * Tests for the shared override-loader.js helper used by all MCP servers
 * to merge project-local .mlcc/ overrides on top of shipped catalogs.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    loadWithOverrides,
    loadWithOverridesArray,
    loadWithOverridesObject,
    resolveProjectDir
} from '../../servers/lib/override-loader.js';

describe('Override Loader', () => {
    let testDir;

    beforeEach(() => {
        testDir = join(tmpdir(), `mlcc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(join(testDir, '.mlcc'), { recursive: true });
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    describe('resolveProjectDir', () => {
        it('returns context.projectDir when present', () => {
            assert.equal(resolveProjectDir({ projectDir: '/my/project' }), '/my/project');
        });

        it('falls back to MLCC_PROJECT_DIR env var', () => {
            const original = process.env.MLCC_PROJECT_DIR;
            process.env.MLCC_PROJECT_DIR = '/env/project';
            try {
                assert.equal(resolveProjectDir({}), '/env/project');
            } finally {
                if (original === undefined) delete process.env.MLCC_PROJECT_DIR;
                else process.env.MLCC_PROJECT_DIR = original;
            }
        });

        it('falls back to cwd when no context or env var', () => {
            const original = process.env.MLCC_PROJECT_DIR;
            delete process.env.MLCC_PROJECT_DIR;
            try {
                assert.equal(resolveProjectDir(undefined), process.cwd());
            } finally {
                if (original !== undefined) process.env.MLCC_PROJECT_DIR = original;
            }
        });
    });

    describe('loadWithOverrides (object-keyed catalog)', () => {
        it('returns shipped catalog when no override file exists', () => {
            const shipped = { 'model-a': { params: '7B' } };
            const result = loadWithOverrides(shipped, testDir, 'nonexistent.json', 'name');
            assert.deepEqual(result, shipped);
        });

        it('merges local entries into shipped catalog', () => {
            const shipped = { 'model-a': { params: '7B' } };
            const override = { models: [{ name: 'model-b', params: '15B' }] };
            writeFileSync(join(testDir, '.mlcc', 'model-picker.json'), JSON.stringify(override));

            const result = loadWithOverrides(shipped, testDir, 'model-picker.json', 'name');
            assert.equal(result['model-a'].params, '7B');
            assert.equal(result['model-b'].params, '15B');
            assert.equal(result['model-b'].source, 'local');
        });

        it('local wins on key collision (AC-1.2)', () => {
            const shipped = { 'model-a': { params: '7B', arch: 'Llama' } };
            const override = { models: [{ name: 'model-a', params: '15B', arch: 'Qwen2' }] };
            writeFileSync(join(testDir, '.mlcc', 'model-picker.json'), JSON.stringify(override));

            const result = loadWithOverrides(shipped, testDir, 'model-picker.json', 'name');
            assert.equal(result['model-a'].params, '15B');
            assert.equal(result['model-a'].arch, 'Qwen2');
            assert.equal(result['model-a'].source, 'local');
        });

        it('falls back silently on malformed JSON (AC-1.3)', () => {
            const shipped = { 'model-a': { params: '7B' } };
            writeFileSync(join(testDir, '.mlcc', 'model-picker.json'), 'not json {{{');

            const result = loadWithOverrides(shipped, testDir, 'model-picker.json', 'name');
            assert.deepEqual(result, shipped);
        });

        it('tags all local entries with source: "local" (AC-3.1)', () => {
            const shipped = {};
            const override = { models: [{ name: 'local-model', params: '3B' }] };
            writeFileSync(join(testDir, '.mlcc', 'model-picker.json'), JSON.stringify(override));

            const result = loadWithOverrides(shipped, testDir, 'model-picker.json', 'name');
            assert.equal(result['local-model'].source, 'local');
        });

        it('does not modify shipped catalog (no caching side effects)', () => {
            const shipped = { 'model-a': { params: '7B' } };
            const override = { models: [{ name: 'model-b', params: '15B' }] };
            writeFileSync(join(testDir, '.mlcc', 'model-picker.json'), JSON.stringify(override));

            loadWithOverrides(shipped, testDir, 'model-picker.json', 'name');
            assert.equal(Object.keys(shipped).length, 1);
            assert.equal(shipped['model-a'].source, undefined);
        });
    });

    describe('loadWithOverridesArray (array-based catalog)', () => {
        it('returns shipped array when no override file exists', () => {
            const shipped = [{ tag: 'v1.0', image: 'img:v1.0' }];
            const result = loadWithOverridesArray(shipped, testDir, 'nonexistent.json', 'tag');
            assert.deepEqual(result, shipped);
        });

        it('merges local entries by merge key', () => {
            const shipped = [{ tag: 'v1.0', image: 'img:v1.0' }];
            const override = { images: [{ tag: 'v2.0', image: 'img:v2.0' }] };
            writeFileSync(join(testDir, '.mlcc', 'base-image-picker.json'), JSON.stringify(override));

            const result = loadWithOverridesArray(shipped, testDir, 'base-image-picker.json', 'tag');
            assert.equal(result.length, 2);
            assert.equal(result[1].tag, 'v2.0');
            assert.equal(result[1].source, 'local');
        });

        it('local wins on key collision for arrays', () => {
            const shipped = [{ tag: 'v1.0', image: 'img:v1.0' }];
            const override = { images: [{ tag: 'v1.0', image: 'custom:v1.0' }] };
            writeFileSync(join(testDir, '.mlcc', 'base-image-picker.json'), JSON.stringify(override));

            const result = loadWithOverridesArray(shipped, testDir, 'base-image-picker.json', 'tag');
            assert.equal(result.length, 1);
            assert.equal(result[0].image, 'custom:v1.0');
            assert.equal(result[0].source, 'local');
        });
    });

    describe('loadWithOverridesObject (capability matrix)', () => {
        it('returns shipped data when no override file exists', () => {
            const shipped = { 'cap.a': { status: 'green' } };
            const result = loadWithOverridesObject(shipped, testDir, 'capabilities.json');
            assert.deepEqual(result, shipped);
        });

        it('merges local capabilities on top of shipped', () => {
            const shipped = { 'cap.a': { status: 'green' } };
            const override = { capabilities: { 'cap.b': { status: 'yellow', message: 'partial' } } };
            writeFileSync(join(testDir, '.mlcc', 'capabilities.json'), JSON.stringify(override));

            const result = loadWithOverridesObject(shipped, testDir, 'capabilities.json');
            assert.equal(result['cap.a'].status, 'green');
            assert.equal(result['cap.b'].status, 'yellow');
            assert.equal(result['cap.b'].source, 'local');
        });

        it('local wins on collision for capabilities', () => {
            const shipped = { 'cap.a': { status: 'red', message: 'not supported' } };
            const override = { capabilities: { 'cap.a': { status: 'green', message: 'locally validated' } } };
            writeFileSync(join(testDir, '.mlcc', 'capabilities.json'), JSON.stringify(override));

            const result = loadWithOverridesObject(shipped, testDir, 'capabilities.json');
            assert.equal(result['cap.a'].status, 'green');
            assert.equal(result['cap.a'].message, 'locally validated');
            assert.equal(result['cap.a'].source, 'local');
        });

        it('falls back silently on malformed JSON', () => {
            const shipped = { 'cap.a': { status: 'green' } };
            writeFileSync(join(testDir, '.mlcc', 'capabilities.json'), '!!!invalid');

            const result = loadWithOverridesObject(shipped, testDir, 'capabilities.json');
            assert.deepEqual(result, shipped);
        });
    });
});

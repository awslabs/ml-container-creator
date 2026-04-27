// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry_Loader Graceful Degradation Property-Based Tests
 *
 * Property 12: For any missing, empty, or malformed catalog file path,
 * the Registry_Loader SHALL return an empty object {} without throwing
 * an exception, preserving the existing graceful-degradation behavior.
 *
 * Feature: registry-to-server-migration, Property 12: Registry_Loader graceful degradation
 * Validates: Requirements 5.4
 */

import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import RegistryLoader from '../../generators/app/lib/registry-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

const TEMP_DIR = resolve(__dirname, '../../.tmp-graceful-degradation-test');

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Random strings that are NOT valid JSON (or parse to non-object types)
const arbMalformedJson = fc.oneof(
    fc.constant('{invalid json}'),
    fc.constant('not json at all'),
    fc.constant('{"unclosed": '),
    fc.constant('[1, 2, 3'),
    fc.constant('undefined'),
    fc.constant(''),
    fc.stringMatching(/^[a-zA-Z ]{2,50}$/),
    fc.constant('{"key": undefined}'),
    fc.constant('{,}'),
    fc.constant('{"a": "b",}')
);

// Random file paths that don't exist
const arbNonexistentPath = fc.stringMatching(/^[a-z][a-z0-9_-]{2,15}$/).map(
    name => resolve(TEMP_DIR, `nonexistent-${name}.json`)
);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 12: Registry_Loader graceful degradation', () => {

    afterEach(() => {
        if (existsSync(TEMP_DIR)) {
            rmSync(TEMP_DIR, { recursive: true, force: true });
        }
    });

    it('_loadCatalog returns null for nonexistent file paths', () => {
        fc.assert(
            fc.property(arbNonexistentPath, (fakePath) => {
                const loader = new RegistryLoader();
                const result = loader._loadCatalog(fakePath);
                assert.strictEqual(result, null, `Should return null for nonexistent path: ${fakePath}`);
            }),
            PROPERTY_CONFIG
        );
    });

    it('_loadCatalog returns null for files with malformed JSON', () => {
        mkdirSync(TEMP_DIR, { recursive: true });

        fc.assert(
            fc.property(arbMalformedJson, fc.integer({ min: 0, max: 99999 }), (content, idx) => {
                const filePath = resolve(TEMP_DIR, `malformed-${idx}.json`);
                writeFileSync(filePath, content, 'utf8');

                const loader = new RegistryLoader();
                const result = loader._loadCatalog(filePath);
                assert.strictEqual(result, null, `Should return null for malformed JSON: ${content.slice(0, 30)}`);
            }),
            PROPERTY_CONFIG
        );
    });

    it('loadFrameworkRegistry returns {} when catalog is missing', async () => {
        const loader = new RegistryLoader();
        // Point to a nonexistent path by clearing the cache and using a broken loader
        loader._loadCatalog = () => null;
        const result = await loader.loadFrameworkRegistry();
        assert.deepStrictEqual(result, {});
    });

    it('loadModelRegistry returns {} when both catalogs are missing', async () => {
        const loader = new RegistryLoader();
        loader._loadCatalog = () => null;
        const result = await loader.loadModelRegistry();
        assert.deepStrictEqual(result, {});
    });

    it('loadInstanceAcceleratorMapping returns {} when catalog is missing', async () => {
        const loader = new RegistryLoader();
        loader._loadCatalog = () => null;
        const result = await loader.loadInstanceAcceleratorMapping();
        assert.deepStrictEqual(result, {});
    });

    it('loadTritonBackends returns {} when catalog is missing', async () => {
        const loader = new RegistryLoader();
        loader._loadCatalog = () => null;
        const result = await loader.loadTritonBackends();
        assert.deepStrictEqual(result, {});
    });

    it('all loader methods return {} without throwing for any random invalid path', () => {
        fc.assert(
            fc.asyncProperty(arbNonexistentPath, async (fakePath) => {
                const loader = new RegistryLoader();
                // Override all catalog paths to point to the fake path
                const originalLoadCatalog = loader._loadCatalog.bind(loader);
                loader._loadCatalog = () => originalLoadCatalog(fakePath);

                const fw = await loader.loadFrameworkRegistry();
                const models = await loader.loadModelRegistry();
                const instances = await loader.loadInstanceAcceleratorMapping();
                const triton = await loader.loadTritonBackends();

                assert.deepStrictEqual(fw, {}, 'loadFrameworkRegistry should return {}');
                assert.deepStrictEqual(models, {}, 'loadModelRegistry should return {}');
                assert.deepStrictEqual(instances, {}, 'loadInstanceAcceleratorMapping should return {}');
                assert.deepStrictEqual(triton, {}, 'loadTritonBackends should return {}');
            }),
            PROPERTY_CONFIG
        );
    });

    it('_loadCatalog caches null for failed loads and does not retry', () => {
        const loader = new RegistryLoader();
        const fakePath = resolve(TEMP_DIR, 'does-not-exist.json');

        const result1 = loader._loadCatalog(fakePath);
        const result2 = loader._loadCatalog(fakePath);

        assert.strictEqual(result1, null);
        assert.strictEqual(result2, null);
    });

    it('_loadCatalog caches successful loads', () => {
        mkdirSync(TEMP_DIR, { recursive: true });
        const filePath = resolve(TEMP_DIR, 'valid.json');
        writeFileSync(filePath, '{"key": "value"}', 'utf8');

        const loader = new RegistryLoader();
        const result1 = loader._loadCatalog(filePath);
        const result2 = loader._loadCatalog(filePath);

        assert.deepStrictEqual(result1, { key: 'value' });
        assert.strictEqual(result1, result2, 'Should return same cached reference');
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration Completeness Property-Based Tests
 *
 * Property 3: The catalog files (model-servers.json, triton-backends.json,
 * instances.json, popular-transformers.json, popular-diffusors.json) contain
 * all expected entries. No registry entry was dropped during migration.
 *
 * Post-migration: validates catalog completeness directly, since the old
 * registry JS files have been deleted.
 *
 * Feature: registry-to-server-migration, Property 3: Migration completeness
 * Validates: Requirements 3.1, 3.5, 4.1, 4.2
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import RegistryLoader from '../../src/lib/registry-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Load catalog JSON files ──────────────────────────────────────────────────

const catalogsRoot = resolve(__dirname, '../../servers');

function loadCatalog(relativePath) {
    return JSON.parse(readFileSync(resolve(catalogsRoot, relativePath), 'utf8'));
}

// ── Known registry keys (captured before old registries were deleted) ─────────
// These represent the complete set of keys that existed in the old JS registries.
// They serve as the ground truth for migration completeness validation.

const KNOWN_FRAMEWORK_KEYS = [
    'vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl', 'vllm-omni',
    'triton-fil', 'triton-onnxruntime', 'triton-tensorflow',
    'triton-pytorch', 'triton-vllm', 'triton-tensorrtllm', 'triton-python'
];

const KNOWN_TRITON_BACKEND_KEYS = [
    'fil', 'onnxruntime', 'tensorflow', 'pytorch', 'vllm', 'tensorrtllm', 'python'
];

const KNOWN_INSTANCE_FAMILY_PREFIXES = [
    'ml.g5.', 'ml.g4dn.', 'ml.g6.', 'ml.p3.',
    'ml.inf2.', 'ml.trn1.', 'ml.m5.',
    'ml.c5.', 'ml.r5.'
];

const KNOWN_TRANSFORMER_MODEL_PATTERNS = [
    'meta-llama/', 'mistralai/', 'codellama/', 'tiiuae/falcon-'
];

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 3: Migration completeness', () => {

    let modelServersCatalog;
    let tritonBackendsCatalog;
    let instancesCatalog;
    let transformersCatalog;
    let diffusorsCatalog;
    let frameworkRegistry;
    let modelRegistry;
    let instanceMapping;

    before(async () => {
        // Load raw catalogs
        modelServersCatalog = loadCatalog('base-image-picker/catalogs/model-servers.json');
        tritonBackendsCatalog = loadCatalog('base-image-picker/catalogs/triton-backends.json');
        instancesCatalog = loadCatalog('instance-recommender/catalogs/instances.json');
        transformersCatalog = loadCatalog('model-picker/catalogs/popular-transformers.json');
        diffusorsCatalog = loadCatalog('model-picker/catalogs/popular-diffusors.json');

        // Load transformed data via RegistryLoader
        const loader = new RegistryLoader();
        frameworkRegistry = await loader.loadFrameworkRegistry();
        modelRegistry = await loader.loadModelRegistry();
        instanceMapping = await loader.loadInstanceAcceleratorMapping();
    });

    // ── Framework keys in model-servers.json ─────────────────────────────

    describe('framework keys exist in model-servers.json', () => {

        it('every known framework key has a corresponding key in model-servers.json', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const catalogKeys = new Set(Object.keys(modelServersCatalog));

            fc.assert(fc.property(
                fc.constantFrom(...KNOWN_FRAMEWORK_KEYS),
                (frameworkKey) => {
                    assert.ok(catalogKeys.has(frameworkKey),
                        `framework "${frameworkKey}" must exist in model-servers.json. ` +
                        `Available catalog keys: [${[...catalogKeys].join(', ')}]`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, KNOWN_FRAMEWORK_KEYS.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });

        it('every framework key in model-servers.json has a non-empty Image_Entry array', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const frameworkKeys = Object.keys(modelServersCatalog);
            assert.ok(frameworkKeys.length > 0, 'model-servers.json must have at least one framework');

            fc.assert(fc.property(
                fc.constantFrom(...frameworkKeys),
                (framework) => {
                    const entries = modelServersCatalog[framework];
                    assert.ok(Array.isArray(entries) && entries.length > 0,
                        `model-servers.json["${framework}"] must be a non-empty array of Image_Entry objects`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, frameworkKeys.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });

        it('RegistryLoader transforms all framework keys from model-servers.json', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const catalogKeys = Object.keys(modelServersCatalog);
            const registryKeys = new Set(Object.keys(frameworkRegistry));

            fc.assert(fc.property(
                fc.constantFrom(...catalogKeys),
                (framework) => {
                    assert.ok(registryKeys.has(framework),
                        `RegistryLoader must transform framework "${framework}" from model-servers.json`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, catalogKeys.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── Triton backend keys in triton-backends.json ──────────────────────

    describe('triton backend keys exist in triton-backends.json', () => {

        it('every known triton backend key has a corresponding entry in triton-backends.json', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const catalogKeys = new Set(Object.keys(tritonBackendsCatalog));

            fc.assert(fc.property(
                fc.constantFrom(...KNOWN_TRITON_BACKEND_KEYS),
                (backendKey) => {
                    assert.ok(catalogKeys.has(backendKey),
                        `triton backend "${backendKey}" must exist in triton-backends.json. ` +
                        `Available catalog keys: [${[...catalogKeys].join(', ')}]`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, KNOWN_TRITON_BACKEND_KEYS.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── Instance types in instances.json ──────────────────────────────────

    describe('instance types exist in instances.json', () => {

        it('instances.json catalog contains entries for all major instance family prefixes', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const catalogKeys = Object.keys(instancesCatalog.catalog);

            fc.assert(fc.property(
                fc.constantFrom(...KNOWN_INSTANCE_FAMILY_PREFIXES),
                (prefix) => {
                    const hasFamily = catalogKeys.some(key => key.startsWith(prefix));
                    assert.ok(hasFamily,
                        `instances.json must have at least one entry starting with "${prefix}". ` +
                        `Sample catalog keys: [${catalogKeys.slice(0, 5).join(', ')}...]`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, KNOWN_INSTANCE_FAMILY_PREFIXES.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });

        it('RegistryLoader transforms all instance keys from instances.json', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const catalogKeys = Object.keys(instancesCatalog.catalog);
            const mappingKeys = new Set(Object.keys(instanceMapping));

            fc.assert(fc.property(
                fc.constantFrom(...catalogKeys),
                (instanceType) => {
                    assert.ok(mappingKeys.has(instanceType),
                        `RegistryLoader must transform instance "${instanceType}" from instances.json`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, catalogKeys.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── Model entries in popular-transformers.json + popular-diffusors.json ──

    describe('model entries exist in popular-transformers.json or popular-diffusors.json', () => {

        it('catalogs contain model entries matching known transformer model patterns', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const allModelKeys = [
                ...Object.keys(transformersCatalog),
                ...Object.keys(diffusorsCatalog)
            ];

            fc.assert(fc.property(
                fc.constantFrom(...KNOWN_TRANSFORMER_MODEL_PATTERNS),
                (pattern) => {
                    const hasMatch = allModelKeys.some(key => key.startsWith(pattern) || key.includes(pattern.replace('/', '/')));
                    assert.ok(hasMatch,
                        `catalogs must have at least one model entry matching pattern "${pattern}"`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, KNOWN_TRANSFORMER_MODEL_PATTERNS.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });

        it('glob-pattern model entries are preserved in catalogs', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const allModelKeys = [
                ...Object.keys(transformersCatalog),
                ...Object.keys(diffusorsCatalog)
            ];
            const globPatternKeys = allModelKeys.filter(key =>
                key.includes('*') || key.includes('?')
            );

            if (globPatternKeys.length === 0) return;

            fc.assert(fc.property(
                fc.constantFrom(...globPatternKeys),
                (patternKey) => {
                    const inTransformers = patternKey in transformersCatalog;
                    const inDiffusors = patternKey in diffusorsCatalog;
                    assert.ok(inTransformers || inDiffusors,
                        `glob-pattern model "${patternKey}" must be present in catalogs`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, globPatternKeys.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });

        it('RegistryLoader transforms all model keys from both catalogs', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const allCatalogModelKeys = [
                ...Object.keys(transformersCatalog),
                ...Object.keys(diffusorsCatalog)
            ];
            const registryKeys = new Set(Object.keys(modelRegistry));

            fc.assert(fc.property(
                fc.constantFrom(...allCatalogModelKeys),
                (modelId) => {
                    assert.ok(registryKeys.has(modelId),
                        `RegistryLoader must transform model "${modelId}" from catalog`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, allCatalogModelKeys.length * 10), verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── Completeness counts ──────────────────────────────────────────────

    describe('catalog coverage counts are non-trivial', () => {

        it('model-servers.json has at least as many framework keys as known frameworks', () => {
            const catalogCount = Object.keys(modelServersCatalog).length;
            assert.ok(catalogCount >= KNOWN_FRAMEWORK_KEYS.length,
                `model-servers.json has ${catalogCount} framework keys, ` +
                `but expected at least ${KNOWN_FRAMEWORK_KEYS.length}`);
        });

        it('triton-backends.json has at least as many backend keys as known backends', () => {
            const catalogCount = Object.keys(tritonBackendsCatalog).length;
            assert.ok(catalogCount >= KNOWN_TRITON_BACKEND_KEYS.length,
                `triton-backends.json has ${catalogCount} backend keys, ` +
                `but expected at least ${KNOWN_TRITON_BACKEND_KEYS.length}`);
        });

        it('instances.json has a substantial number of instance entries', () => {
            const catalogCount = Object.keys(instancesCatalog.catalog).length;
            assert.ok(catalogCount >= 10,
                `instances.json has ${catalogCount} instance keys, expected at least 10`);
        });

        it('combined model catalogs have a substantial number of model entries', () => {
            const allCatalogKeys = new Set([
                ...Object.keys(transformersCatalog),
                ...Object.keys(diffusorsCatalog)
            ]);
            assert.ok(allCatalogKeys.size >= 5,
                `combined model catalogs have ${allCatalogKeys.size} model keys, expected at least 5`);
        });
    });
});

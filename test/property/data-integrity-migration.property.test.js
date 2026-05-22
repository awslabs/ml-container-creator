// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Data Integrity Across Migration Property-Based Tests
 *
 * Property 9: Validates that catalog data and RegistryLoader transformations
 * maintain internal consistency. For any framework entry in model-servers.json,
 * the RegistryLoader transformation SHALL produce equivalent data. For any model
 * entry in the catalogs, the RegistryLoader transformation SHALL preserve family,
 * chatTemplate, frameworkCompatibility, validationLevel, and notes. For any
 * instance entry, the transformation SHALL preserve accelerator metadata.
 *
 * Post-migration: validates catalog-to-RegistryLoader transformation integrity
 * directly, since the old registry JS files have been deleted.
 *
 * Feature: registry-to-server-migration, Property 9: Data integrity across migration
 * Validates: Requirements 13.1, 13.2, 13.3, 13.4, 4.4
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

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Load catalog JSON files ──────────────────────────────────────────────────

const catalogsRoot = resolve(__dirname, '../../servers');

function loadCatalog(relativePath) {
    return JSON.parse(readFileSync(resolve(catalogsRoot, relativePath), 'utf8'));
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 9: Data integrity across migration', () => {

    let modelServersCatalog;
    let transformersCatalog;
    let diffusorsCatalog;
    let instancesCatalog;
    let catalogFrameworkRegistry;
    let catalogModelRegistry;
    let catalogInstanceMapping;

    before(async () => {
        // Load raw catalogs
        modelServersCatalog = loadCatalog('lib/catalogs/model-servers.json');
        transformersCatalog = loadCatalog('lib/catalogs/popular-transformers.json');
        diffusorsCatalog = loadCatalog('lib/catalogs/popular-diffusors.json');
        instancesCatalog = loadCatalog('lib/catalogs/instances.json');

        // Load transformed catalog data via RegistryLoader
        const loader = new RegistryLoader();
        catalogFrameworkRegistry = await loader.loadFrameworkRegistry();
        catalogModelRegistry = await loader.loadModelRegistry();
        catalogInstanceMapping = await loader.loadInstanceAcceleratorMapping();
    });

    // ── Framework data integrity (Requirement 13.1) ──────────────────────

    describe('framework entries: catalog vs RegistryLoader transformation (Requirement 13.1)', () => {

        it('for every framework-version in model-servers.json, the RegistryLoader transformation contains equivalent operational metadata', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            // Build list of framework-version pairs from the catalog
            const pairs = [];
            for (const [framework, entries] of Object.entries(modelServersCatalog)) {
                if (!Array.isArray(entries)) continue;
                for (const entry of entries) {
                    const version = entry.labels?.framework_version;
                    if (!version) continue;
                    pairs.push({ framework, version, entry });
                }
            }
            assert.ok(pairs.length > 0, 'model-servers.json must have at least one framework-version pair');

            fc.assert(fc.property(
                fc.constantFrom(...pairs),
                ({ framework, version, entry }) => {
                    const transformed = catalogFrameworkRegistry[framework]?.[version];
                    assert.ok(transformed,
                        `RegistryLoader must produce entry for ${framework}@${version}`);

                    // baseImage equivalence
                    assert.strictEqual(transformed.baseImage, entry.image,
                        `baseImage mismatch for ${framework}@${version}`);

                    // envVars equivalence
                    assert.deepStrictEqual(
                        transformed.envVars,
                        entry.defaults?.envVars || {},
                        `envVars mismatch for ${framework}@${version}`);

                    // accelerator equivalence
                    if (entry.accelerator) {
                        assert.strictEqual(transformed.accelerator.type, entry.accelerator.type,
                            `accelerator.type mismatch for ${framework}@${version}`);
                        assert.strictEqual(transformed.accelerator.version, entry.accelerator.version,
                            `accelerator.version mismatch for ${framework}@${version}`);
                    }

                    // inferenceAmiVersion equivalence
                    assert.strictEqual(
                        transformed.inferenceAmiVersion,
                        entry.defaults?.inferenceAmiVersion || '',
                        `inferenceAmiVersion mismatch for ${framework}@${version}`);

                    // recommendedInstanceTypes equivalence
                    assert.deepStrictEqual(
                        transformed.recommendedInstanceTypes,
                        entry.defaults?.recommendedInstanceTypes || [],
                        `recommendedInstanceTypes mismatch for ${framework}@${version}`);

                    // validationLevel equivalence
                    assert.strictEqual(
                        transformed.validationLevel,
                        entry.validationLevel || 'untested',
                        `validationLevel mismatch for ${framework}@${version}`);

                    // notes equivalence
                    assert.strictEqual(
                        transformed.notes,
                        entry.notes || '',
                        `notes mismatch for ${framework}@${version}`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, pairs.length * 5), verbose: PROPERTY_CONFIG.verbose });
        });

        it('for every framework-version with profiles, the RegistryLoader preserves profile data', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const pairsWithProfiles = [];
            for (const [framework, entries] of Object.entries(modelServersCatalog)) {
                if (!Array.isArray(entries)) continue;
                for (const entry of entries) {
                    const version = entry.labels?.framework_version;
                    if (!version) continue;
                    if (entry.profiles && Object.keys(entry.profiles).length > 0) {
                        pairsWithProfiles.push({ framework, version, profiles: entry.profiles });
                    }
                }
            }

            if (pairsWithProfiles.length === 0) return;

            fc.assert(fc.property(
                fc.constantFrom(...pairsWithProfiles),
                ({ framework, version, profiles }) => {
                    const transformed = catalogFrameworkRegistry[framework]?.[version];
                    assert.ok(transformed,
                        `RegistryLoader must produce entry for ${framework}@${version}`);
                    assert.ok(transformed.profiles,
                        `profiles must exist in transformed entry for ${framework}@${version}`);

                    for (const [profileName, profileConfig] of Object.entries(profiles)) {
                        assert.ok(transformed.profiles[profileName],
                            `profile "${profileName}" must exist in transformed entry for ${framework}@${version}`);

                        const transformedProfile = transformed.profiles[profileName];
                        assert.strictEqual(transformedProfile.displayName, profileConfig.displayName,
                            `profile "${profileName}" displayName mismatch for ${framework}@${version}`);
                        assert.strictEqual(transformedProfile.description, profileConfig.description,
                            `profile "${profileName}" description mismatch for ${framework}@${version}`);
                        assert.deepStrictEqual(transformedProfile.envVars || {}, profileConfig.envVars || {},
                            `profile "${profileName}" envVars mismatch for ${framework}@${version}`);
                    }
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, pairsWithProfiles.length * 5), verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── Model data integrity (Requirements 13.2, 4.4) ────────────────────

    describe('model entries: catalog vs RegistryLoader transformation (Requirements 13.2, 4.4)', () => {

        it('for every model in catalogs, the RegistryLoader transformation contains equivalent fields', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const allCatalogModels = { ...transformersCatalog, ...diffusorsCatalog };
            const modelEntries = Object.entries(allCatalogModels).map(([modelId, entry]) => ({
                modelId, entry
            }));
            assert.ok(modelEntries.length > 0, 'catalogs must have at least one model entry');

            fc.assert(fc.property(
                fc.constantFrom(...modelEntries),
                ({ modelId, entry }) => {
                    const transformed = catalogModelRegistry[modelId];
                    assert.ok(transformed,
                        `RegistryLoader must produce entry for model "${modelId}"`);

                    // family equivalence
                    assert.strictEqual(transformed.family, entry.family || '',
                        `family mismatch for model "${modelId}"`);

                    // chatTemplate equivalence (catalog uses snake_case, loader maps to camelCase)
                    assert.strictEqual(
                        transformed.chatTemplate ?? null,
                        entry.chat_template ?? null,
                        `chatTemplate mismatch for model "${modelId}"`);

                    // frameworkCompatibility equivalence
                    assert.deepStrictEqual(
                        transformed.frameworkCompatibility,
                        entry.framework_compatibility || {},
                        `frameworkCompatibility mismatch for model "${modelId}"`);

                    // validationLevel equivalence
                    assert.strictEqual(
                        transformed.validationLevel,
                        entry.validation_level || 'experimental',
                        `validationLevel mismatch for model "${modelId}"`);

                    // notes equivalence
                    assert.strictEqual(
                        transformed.notes,
                        entry.notes || '',
                        `notes mismatch for model "${modelId}"`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, modelEntries.length * 5), verbose: PROPERTY_CONFIG.verbose });
        });

        it('for every model with profiles, the RegistryLoader preserves profile data (Requirement 4.4)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const allCatalogModels = { ...transformersCatalog, ...diffusorsCatalog };
            const modelsWithProfiles = Object.entries(allCatalogModels)
                .filter(([, entry]) => entry.profiles && Object.keys(entry.profiles).length > 0)
                .map(([modelId, entry]) => ({ modelId, profiles: entry.profiles }));

            if (modelsWithProfiles.length === 0) return;

            fc.assert(fc.property(
                fc.constantFrom(...modelsWithProfiles),
                ({ modelId, profiles }) => {
                    const transformed = catalogModelRegistry[modelId];
                    assert.ok(transformed, `RegistryLoader must produce entry for model "${modelId}"`);
                    assert.ok(transformed.profiles,
                        `profiles must exist in transformed entry for model "${modelId}"`);

                    for (const [profileName, profileConfig] of Object.entries(profiles)) {
                        assert.ok(transformed.profiles[profileName],
                            `profile "${profileName}" must exist in transformed entry for model "${modelId}"`);

                        const transformedProfile = transformed.profiles[profileName];
                        assert.strictEqual(transformedProfile.displayName, profileConfig.displayName,
                            `profile "${profileName}" displayName mismatch for model "${modelId}"`);
                        assert.deepStrictEqual(transformedProfile.envVars || {}, profileConfig.envVars || {},
                            `profile "${profileName}" envVars mismatch for model "${modelId}"`);

                        if (profileConfig.recommendedInstanceTypes) {
                            assert.deepStrictEqual(
                                transformedProfile.recommendedInstanceTypes,
                                profileConfig.recommendedInstanceTypes,
                                `profile "${profileName}" recommendedInstanceTypes mismatch for model "${modelId}"`);
                        }
                    }
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, modelsWithProfiles.length * 5), verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── Instance data integrity (Requirements 13.3, 13.4) ────────────────

    describe('instance entries: catalog vs RegistryLoader transformation (Requirements 13.3, 13.4)', () => {

        it('for every instance in instances.json, the RegistryLoader transformation contains equivalent accelerator data', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const instanceEntries = Object.entries(instancesCatalog.catalog).map(
                ([instanceType, entry]) => ({ instanceType, entry })
            );
            assert.ok(instanceEntries.length > 0,
                'instances.json must have at least one entry');

            fc.assert(fc.property(
                fc.constantFrom(...instanceEntries),
                ({ instanceType, entry }) => {
                    const transformed = catalogInstanceMapping[instanceType];
                    assert.ok(transformed,
                        `RegistryLoader must produce entry for instance "${instanceType}"`);

                    // family equivalence
                    assert.strictEqual(transformed.family, entry.family || '',
                        `family mismatch for instance "${instanceType}"`);

                    // acceleratorType equivalence
                    assert.strictEqual(transformed.accelerator.type, entry.acceleratorType || 'cpu',
                        `accelerator.type mismatch for instance "${instanceType}"`);

                    // hardware equivalence
                    assert.strictEqual(transformed.accelerator.hardware, entry.hardware || 'None',
                        `accelerator.hardware mismatch for instance "${instanceType}"`);

                    // gpuArchitecture equivalence
                    assert.strictEqual(transformed.accelerator.architecture, entry.gpuArchitecture || 'None',
                        `accelerator.architecture mismatch for instance "${instanceType}"`);

                    // cudaVersions / versions equivalence
                    assert.deepStrictEqual(
                        transformed.accelerator.versions,
                        entry.cudaVersions || null,
                        `accelerator.versions mismatch for instance "${instanceType}"`);

                    // defaultCudaVersion / default equivalence
                    assert.strictEqual(
                        transformed.accelerator.default,
                        entry.defaultCudaVersion || null,
                        `accelerator.default mismatch for instance "${instanceType}"`);

                    // vcpus equivalence
                    assert.strictEqual(transformed.vcpus, entry.vcpus || 0,
                        `vcpus mismatch for instance "${instanceType}"`);

                    // notes equivalence
                    assert.strictEqual(
                        transformed.notes,
                        entry.notes || '',
                        `notes mismatch for instance "${instanceType}"`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, instanceEntries.length * 5), verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // ── RegistryLoader model transformation integrity ────────────────────

    describe('RegistryLoader model transformation preserves data', () => {

        it('for every model in catalogs, the RegistryLoader-transformed entry has consistent fields', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const allCatalogModels = { ...transformersCatalog, ...diffusorsCatalog };
            const modelEntries = Object.entries(allCatalogModels).map(([modelId, entry]) => ({
                modelId, entry
            }));

            fc.assert(fc.property(
                fc.constantFrom(...modelEntries),
                ({ modelId, entry }) => {
                    const transformed = catalogModelRegistry[modelId];
                    assert.ok(transformed,
                        `model "${modelId}" must exist in transformed catalog model registry`);

                    // RegistryLoader maps snake_case → camelCase
                    assert.strictEqual(transformed.family, entry.family || '',
                        `transformed family mismatch for model "${modelId}"`);
                    assert.strictEqual(transformed.chatTemplate ?? null, entry.chat_template ?? null,
                        `transformed chatTemplate mismatch for model "${modelId}"`);
                    assert.deepStrictEqual(
                        transformed.frameworkCompatibility,
                        entry.framework_compatibility || {},
                        `transformed frameworkCompatibility mismatch for model "${modelId}"`);
                    assert.strictEqual(
                        transformed.validationLevel,
                        entry.validation_level || 'experimental',
                        `transformed validationLevel mismatch for model "${modelId}"`);
                    assert.strictEqual(transformed.notes, entry.notes || '',
                        `transformed notes mismatch for model "${modelId}"`);
                }
            ), { numRuns: Math.min(PROPERTY_CONFIG.numRuns, modelEntries.length * 5), verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

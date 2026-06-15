// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration_Matcher Equivalence Property-Based Tests
 *
 * Property 10: For any framework name and version pair in the catalog,
 * Configuration_Matcher.matchFramework() with catalog-sourced data SHALL
 * return consistent baseImage, envVars, accelerator, and validationLevel.
 * For any model ID in the catalogs, Configuration_Matcher.matchModel()
 * with catalog-sourced data SHALL return consistent family, chatTemplate,
 * and frameworkCompatibility.
 *
 * Post-migration: validates Configuration_Matcher behavior with catalog-sourced
 * data directly, since the old registry JS files have been deleted.
 *
 * Feature: registry-to-server-migration, Property 10: Configuration_Matcher equivalence
 * Validates: Requirements 13.5, 13.6
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import { fileURLToPath } from 'node:url';
import ConfigurationMatcher from '../../src/lib/configuration-matcher.js';
import RegistryLoader from '../../src/lib/registry-loader.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

const __filename = fileURLToPath(import.meta.url); // eslint-disable-line no-unused-vars

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 10: Configuration_Matcher equivalence', () => {

    let catalogFrameworkRegistry;
    let catalogModelRegistry;

    before(async () => {
        // Load catalog-sourced data via Registry_Loader
        const loader = new RegistryLoader();
        catalogFrameworkRegistry = await loader.loadFrameworkRegistry();
        catalogModelRegistry = await loader.loadModelRegistry();
    });

    // ── Framework matching ───────────────────────────────────────────────

    describe('matchFramework() returns consistent results for catalog data', () => {

        it('for every framework-version pair in catalog, matchFramework returns an exact match with expected fields', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            // Build list of all framework-version pairs from catalog
            const allPairs = [];
            for (const [framework, versions] of Object.entries(catalogFrameworkRegistry)) {
                for (const version of Object.keys(versions)) {
                    allPairs.push({ framework, version });
                }
            }

            if (allPairs.length === 0) return;

            /**
             * Validates: Requirements 13.5
             */
            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            fc.assert(fc.property(
                fc.constantFrom(...allPairs),
                ({ framework, version }) => {
                    const result = matcher.matchFramework(framework, version);

                    // Must find a match
                    assert.ok(result !== null,
                        `matcher must find framework "${framework}" version "${version}"`);

                    // Should be an exact match for a known version
                    assert.strictEqual(result.matchType, 'exact',
                        `matcher should exact-match known version ${framework}@${version}`);

                    // baseImage must be present
                    assert.ok(result.baseImage,
                        `baseImage must be present for ${framework}@${version}`);

                    // envVars must be an object
                    assert.strictEqual(typeof result.envVars, 'object',
                        `envVars must be an object for ${framework}@${version}`);

                    // accelerator must be present
                    assert.ok(result.accelerator,
                        `accelerator must be present for ${framework}@${version}`);
                    assert.ok(result.accelerator.type,
                        `accelerator.type must be present for ${framework}@${version}`);

                    // validationLevel must be present
                    assert.ok(result.validationLevel,
                        `validationLevel must be present for ${framework}@${version}`);
                }
            ), {
                numRuns: Math.min(PROPERTY_CONFIG.numRuns, allPairs.length * 10),
                verbose: PROPERTY_CONFIG.verbose
            });
        });

        it('matchFramework is idempotent: calling twice returns identical results', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const allPairs = [];
            for (const [framework, versions] of Object.entries(catalogFrameworkRegistry)) {
                for (const version of Object.keys(versions)) {
                    allPairs.push({ framework, version });
                }
            }

            if (allPairs.length === 0) return;

            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            fc.assert(fc.property(
                fc.constantFrom(...allPairs),
                ({ framework, version }) => {
                    const result1 = matcher.matchFramework(framework, version);
                    const result2 = matcher.matchFramework(framework, version);

                    assert.deepStrictEqual(result1, result2,
                        `matchFramework must be idempotent for ${framework}@${version}`);
                }
            ), {
                numRuns: Math.min(PROPERTY_CONFIG.numRuns, allPairs.length * 10),
                verbose: PROPERTY_CONFIG.verbose
            });
        });
    });

    describe('every catalog framework key is accessible via matcher', () => {

        it('all framework names in catalog are matchable', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const frameworkKeys = Object.keys(catalogFrameworkRegistry);
            assert.ok(frameworkKeys.length > 0,
                'catalog must have at least one framework');

            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            fc.assert(fc.property(
                fc.constantFrom(...frameworkKeys),
                (framework) => {
                    // Get first available version for this framework
                    const versions = Object.keys(catalogFrameworkRegistry[framework]);
                    assert.ok(versions.length > 0,
                        `framework "${framework}" must have at least one version`);

                    const result = matcher.matchFramework(framework, versions[0]);
                    assert.ok(result !== null,
                        `matcher must find framework "${framework}" with version "${versions[0]}"`);
                }
            ), {
                numRuns: Math.min(PROPERTY_CONFIG.numRuns, frameworkKeys.length * 10),
                verbose: PROPERTY_CONFIG.verbose
            });
        });
    });

    // ── Model matching ───────────────────────────────────────────────────

    describe('matchModel() returns consistent results for catalog data', () => {

        it('for every model ID in catalog, matchModel returns consistent family, chatTemplate, and frameworkCompatibility', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const modelIds = Object.keys(catalogModelRegistry);
            assert.ok(modelIds.length > 0,
                'catalog must have at least one model entry');

            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            /**
             * Validates: Requirements 13.6
             */
            fc.assert(fc.property(
                fc.constantFrom(...modelIds),
                (modelId) => {
                    const result = matcher.matchModel(modelId);

                    // Must find a match
                    assert.ok(result !== null,
                        `matcher must find model "${modelId}"`);

                    // family must be present
                    assert.ok(result.family !== undefined,
                        `family must be present for model "${modelId}"`);

                    // chatTemplate must be defined (can be null)
                    assert.ok(result.chatTemplate !== undefined,
                        `chatTemplate must be defined for model "${modelId}"`);

                    // frameworkCompatibility must be an object
                    assert.strictEqual(typeof result.frameworkCompatibility, 'object',
                        `frameworkCompatibility must be an object for model "${modelId}"`);
                }
            ), {
                numRuns: Math.min(PROPERTY_CONFIG.numRuns, modelIds.length * 10),
                verbose: PROPERTY_CONFIG.verbose
            });
        });

        it('matchModel returns same matchType for exact model ID lookups', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            // Exact model IDs (no glob patterns)
            const exactModelIds = Object.keys(catalogModelRegistry).filter(
                id => !id.includes('*') && !id.includes('?')
            );

            if (exactModelIds.length === 0) return;

            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            fc.assert(fc.property(
                fc.constantFrom(...exactModelIds),
                (modelId) => {
                    const result = matcher.matchModel(modelId);

                    assert.ok(result !== null,
                        `matcher must find model "${modelId}"`);
                    assert.strictEqual(result.matchType, 'exact',
                        `matchType must be 'exact' for exact model ID "${modelId}"`);
                }
            ), {
                numRuns: Math.min(PROPERTY_CONFIG.numRuns, exactModelIds.length * 10),
                verbose: PROPERTY_CONFIG.verbose
            });
        });

        it('matchModel is idempotent: calling twice returns identical results', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const modelIds = Object.keys(catalogModelRegistry);

            if (modelIds.length === 0) return;

            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            fc.assert(fc.property(
                fc.constantFrom(...modelIds),
                (modelId) => {
                    const result1 = matcher.matchModel(modelId);
                    const result2 = matcher.matchModel(modelId);

                    assert.deepStrictEqual(result1, result2,
                        `matchModel must be idempotent for model "${modelId}"`);
                }
            ), {
                numRuns: Math.min(PROPERTY_CONFIG.numRuns, modelIds.length * 10),
                verbose: PROPERTY_CONFIG.verbose
            });
        });

        it('glob-pattern model entries produce consistent results', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const globPatternIds = Object.keys(catalogModelRegistry).filter(
                id => id.includes('*') || id.includes('?')
            );

            if (globPatternIds.length === 0) return;

            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            fc.assert(fc.property(
                fc.constantFrom(...globPatternIds),
                (patternId) => {
                    const result = matcher.matchModel(patternId);

                    assert.ok(result !== null,
                        `matcher must find glob pattern "${patternId}"`);
                    assert.ok(result.family,
                        `family must be present for glob pattern "${patternId}"`);
                    assert.strictEqual(typeof result.frameworkCompatibility, 'object',
                        `frameworkCompatibility must be an object for glob pattern "${patternId}"`);
                }
            ), {
                numRuns: Math.min(PROPERTY_CONFIG.numRuns, globPatternIds.length * 10),
                verbose: PROPERTY_CONFIG.verbose
            });
        });
    });

    // ── Non-existent entries return null ──────────────────────────────────

    describe('non-existent entries return null', () => {

        it('matchFramework returns null for non-existent framework', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            const nonExistentFrameworks = [
                'nonexistent-framework',
                'pytorch-vanilla',
                'jax-serving',
                'onnx-runtime-standalone'
            ];

            fc.assert(fc.property(
                fc.constantFrom(...nonExistentFrameworks),
                (framework) => {
                    const result = matcher.matchFramework(framework, '1.0.0');
                    assert.strictEqual(result, null,
                        `matcher should return null for non-existent framework "${framework}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('matchModel returns null for non-existent model', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const matcher = new ConfigurationMatcher(catalogFrameworkRegistry, catalogModelRegistry);

            const nonExistentModels = [
                'nonexistent-org/nonexistent-model',
                'google/gemma-99b',
                'openai/gpt-5-turbo',
                'anthropic/claude-v99'
            ];

            fc.assert(fc.property(
                fc.constantFrom(...nonExistentModels),
                (modelId) => {
                    const result = matcher.matchModel(modelId);
                    assert.strictEqual(result, null,
                        `matcher should return null for non-existent model "${modelId}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

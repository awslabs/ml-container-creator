// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Diffusion Model Registry Property-Based Tests
 *
 * Property 4: Diffusion Model Registry Entry Completeness
 * Validates: Requirements 7.2, 7.3, 7.4
 *
 * Feature: vllm-omni-diffusors
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __testFilename = fileURLToPath(import.meta.url);
const __testDir = dirname(__testFilename);
const modelsCatalogPath = resolve(__testDir, '../../servers/lib/catalogs/popular-diffusors.json');
const transformersCatalogPath = resolve(__testDir, '../../servers/lib/catalogs/popular-transformers.json');

function loadModelRegistryFromCatalogs() {
    const transformers = JSON.parse(readFileSync(transformersCatalogPath, 'utf8'));
    const diffusors = JSON.parse(readFileSync(modelsCatalogPath, 'utf8'));
    const allModels = { ...transformers, ...diffusors };
    const registry = {};
    for (const [modelId, entry] of Object.entries(allModels)) {
        registry[modelId] = {
            family: entry.family || '',
            chatTemplate: entry.chat_template ?? null,
            requiresTemplate: entry.chat_template !== null && entry.chat_template !== undefined && entry.chat_template !== '',
            validationLevel: entry.validation_level || 'experimental',
            frameworkCompatibility: entry.framework_compatibility || {},
            profiles: entry.profiles || {},
            notes: entry.notes || ''
        };
    }
    return registry;
}

const modelRegistry = loadModelRegistryFromCatalogs();

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * All model registry keys whose frameworkCompatibility includes 'vllm-omni'.
 * These are diffusion model entries.
 */
const DIFFUSION_MODEL_KEYS = Object.keys(modelRegistry).filter(
    (key) => modelRegistry[key].frameworkCompatibility &&
             'vllm-omni' in modelRegistry[key].frameworkCompatibility
);

// ── Property 4: Diffusion Model Registry Entry Completeness ─────────────────

describe('Diffusion Model Registry Property-Based Tests', () => {

    before(() => {
        console.log('\n🚀 Starting Diffusion Model Registry Property Tests');
        console.log('📋 Testing: Diffusion model registry entry completeness');
        console.log(`🔧 Configuration: ${FAST_PROPERTY_CONFIG.numRuns} iterations per property`);
        console.log(`📦 Diffusion model entries: ${DIFFUSION_MODEL_KEYS.length} (${DIFFUSION_MODEL_KEYS.join(', ')})\n`);
    });

    /**
     * Property 4: Diffusion Model Registry Entry Completeness
     *
     * **Validates: Requirements 7.2, 7.3, 7.4**
     *
     * For any model registry entry whose frameworkCompatibility includes
     * 'vllm-omni', the entry should have:
     * - chatTemplate set to null
     * - requiresTemplate set to false
     * - a valid frameworkCompatibility['vllm-omni'] version range string
     * - a non-empty profiles object where each profile has recommendedInstanceTypes
     */
    describe('Property 4: Diffusion Model Registry Entry Completeness', () => {
        it('at least one diffusion model entry exists in the registry', () => {
            assert.ok(
                DIFFUSION_MODEL_KEYS.length > 0,
                'Expected at least one diffusion model entry with vllm-omni in frameworkCompatibility'
            );
        });

        it('all diffusion model entries have chatTemplate set to null and requiresTemplate set to false', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...DIFFUSION_MODEL_KEYS),
                (modelKey) => {
                    const entry = modelRegistry[modelKey];

                    // chatTemplate must be null (Requirement 7.2)
                    assert.strictEqual(
                        entry.chatTemplate,
                        null,
                        `Diffusion model '${modelKey}' must have chatTemplate set to null, got '${entry.chatTemplate}'`
                    );

                    // requiresTemplate must be false (Requirement 7.2)
                    assert.strictEqual(
                        entry.requiresTemplate,
                        false,
                        `Diffusion model '${modelKey}' must have requiresTemplate set to false, got '${entry.requiresTemplate}'`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('all diffusion model entries have a valid vllm-omni version range in frameworkCompatibility', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.constantFrom(...DIFFUSION_MODEL_KEYS),
                (modelKey) => {
                    const entry = modelRegistry[modelKey];

                    // frameworkCompatibility must exist and contain vllm-omni (Requirement 7.3)
                    assert.ok(
                        entry.frameworkCompatibility,
                        `Diffusion model '${modelKey}' must have frameworkCompatibility`
                    );
                    assert.ok(
                        'vllm-omni' in entry.frameworkCompatibility,
                        `Diffusion model '${modelKey}' must have 'vllm-omni' in frameworkCompatibility`
                    );

                    // vllm-omni version range must be a non-empty string matching semver range pattern
                    const versionRange = entry.frameworkCompatibility['vllm-omni'];
                    assert.strictEqual(
                        typeof versionRange,
                        'string',
                        `frameworkCompatibility['vllm-omni'] for '${modelKey}' must be a string, got ${typeof versionRange}`
                    );
                    assert.ok(
                        versionRange.length > 0,
                        `frameworkCompatibility['vllm-omni'] for '${modelKey}' must be non-empty`
                    );
                    assert.ok(
                        /^[><=~^0-9]/.test(versionRange),
                        `frameworkCompatibility['vllm-omni'] for '${modelKey}' must start with a version range operator or digit, got '${versionRange}'`
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('all diffusion model entries with profiles have non-empty profiles with displayName', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            const keysWithProfiles = DIFFUSION_MODEL_KEYS.filter(
                key => modelRegistry[key].profiles && Object.keys(modelRegistry[key].profiles).length > 0
            );
            if (keysWithProfiles.length === 0) {
                return; // no diffusion models with profiles to test
            }

            fc.assert(fc.property(
                fc.constantFrom(...keysWithProfiles),
                (modelKey) => {
                    const entry = modelRegistry[modelKey];

                    // profiles must exist and be a non-empty object (Requirement 7.4)
                    assert.ok(
                        entry.profiles && typeof entry.profiles === 'object',
                        `Diffusion model '${modelKey}' must have a profiles object`
                    );

                    const profileNames = Object.keys(entry.profiles);
                    assert.ok(
                        profileNames.length > 0,
                        `Diffusion model '${modelKey}' must have at least one profile`
                    );

                    // Each profile must have a displayName (recommendedInstanceTypes removed per mcp-catalog-consolidation)
                    for (const profileName of profileNames) {
                        const profile = entry.profiles[profileName];

                        assert.ok(
                            typeof profile.displayName === 'string',
                            `Profile '${profileName}' in '${modelKey}' must have a displayName string`
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});

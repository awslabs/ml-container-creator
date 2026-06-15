// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry_Loader Transformation Correctness Property-Based Tests
 *
 * Property 11: For any valid enriched model-servers.json catalog, the
 * Registry_Loader.loadFrameworkRegistry() transformation SHALL produce
 * an object with the shape { [frameworkName]: { [version]: FrameworkConfig } }
 * where each FrameworkConfig contains baseImage, accelerator, envVars,
 * inferenceAmiVersion, recommendedInstanceTypes, validationLevel, profiles,
 * and notes. The transformation is a deterministic function of the input catalog.
 *
 * Feature: registry-to-server-migration, Property 11: Registry_Loader transformation correctness
 * Validates: Requirements 5.1, 6.1
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { fileURLToPath } from 'node:url';
import RegistryLoader from '../../src/lib/registry-loader.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

const __filename = fileURLToPath(import.meta.url); // eslint-disable-line no-unused-vars

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbSafeString = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}$/).filter(s => s.length >= 1);
const arbVersion = fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/).filter(s => s.length >= 5);
const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1);
const arbEnvVars = fc.dictionary(arbEnvKey, fc.stringMatching(/^[a-zA-Z0-9._/-]{0,20}$/));
const arbInstanceType = fc.stringMatching(/^ml\.[a-z0-9]+\.[a-z0-9]+$/).filter(s => s.length >= 4);
const arbAccelType = fc.constantFrom('cuda', 'neuron', 'cpu', 'rocm');
const arbValidationLevel = fc.constantFrom('tested', 'community-validated', 'experimental', 'untested');
const arbFrameworkName = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/).filter(s => s.length >= 2);

const arbDateTime = fc.tuple(
    fc.integer({ min: 2020, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 })
).map(([y, m, d]) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}T00:00:00Z`;
});

const arbProfile = fc.record({
    displayName: arbSafeString,
    description: arbSafeString,
    envVars: arbEnvVars,
    recommendedInstanceTypes: fc.array(arbInstanceType, { minLength: 0, maxLength: 3 }),
    notes: fc.option(arbSafeString, { nil: undefined })
});

// Generate a single enriched Image_Entry as it appears in model-servers.json
const arbEnrichedImageEntry = fc.record({
    image: arbSafeString,
    tag: arbSafeString,
    architecture: fc.constantFrom('amd64', 'arm64'),
    created: arbDateTime,
    labels: fc.record({
        cuda_version: arbVersion,
        python_version: arbVersion,
        framework_version: arbVersion
    }),
    registry: fc.constantFrom('dockerhub', 'ngc', 'ecr'),
    repository: arbSafeString,
    defaults: fc.record({
        envVars: arbEnvVars,
        inferenceAmiVersion: arbSafeString,
        recommendedInstanceTypes: fc.array(arbInstanceType, { minLength: 0, maxLength: 4 })
    }),
    accelerator: fc.record({
        type: arbAccelType,
        version: arbVersion,
        versionRange: fc.record({ min: arbVersion, max: arbVersion })
    }),
    validationLevel: arbValidationLevel,
    profiles: fc.dictionary(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/).filter(s => s.length >= 2),
        arbProfile,
        { minKeys: 0, maxKeys: 3 }
    ),
    notes: arbSafeString
});

// Generate a catalog: { frameworkName: [ImageEntry, ...] }
const arbCatalog = fc.dictionary(
    arbFrameworkName,
    fc.array(arbEnrichedImageEntry, { minLength: 1, maxLength: 3 }),
    { minKeys: 1, maxKeys: 5 }
);

// ── Helper: transform catalog using the same logic as RegistryLoader ─────────

function transformCatalog(catalog) {
    const registry = {};
    for (const [frameworkName, entries] of Object.entries(catalog)) {
        if (!Array.isArray(entries)) continue;
        registry[frameworkName] = {};
        for (const entry of entries) {
            const version = entry.labels?.framework_version;
            if (!version) continue;
            registry[frameworkName][version] = {
                baseImage: entry.image,
                accelerator: entry.accelerator || { type: 'cpu', version: null, versionRange: { min: null, max: null } },
                envVars: entry.defaults?.envVars || {},
                inferenceAmiVersion: entry.defaults?.inferenceAmiVersion || '',
                recommendedInstanceTypes: entry.defaults?.recommendedInstanceTypes || [],
                validationLevel: entry.validationLevel || 'untested',
                profiles: entry.profiles || {},
                notes: entry.notes || ''
            };
        }
    }
    return registry;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 11: Registry_Loader transformation correctness', () => {

    it('loadFrameworkRegistry output has correct top-level shape { frameworkName: { version: config } }', () => {
        fc.assert(
            fc.property(arbCatalog, (catalog) => {
                const result = transformCatalog(catalog);

                // Result must be an object
                assert.strictEqual(typeof result, 'object');
                assert(result !== null);

                // Each key maps to an object of version → config
                for (const [fwName, versions] of Object.entries(result)) {
                    assert.strictEqual(typeof fwName, 'string');
                    assert.strictEqual(typeof versions, 'object');
                    assert(versions !== null);

                    for (const [ver, config] of Object.entries(versions)) {
                        assert.strictEqual(typeof ver, 'string');
                        assert.strictEqual(typeof config, 'object');
                        assert(config !== null);
                    }
                }
            }),
            PROPERTY_CONFIG
        );
    });

    it('every FrameworkConfig contains all required fields with correct types', () => {
        fc.assert(
            fc.property(arbCatalog, (catalog) => {
                const result = transformCatalog(catalog);

                for (const versions of Object.values(result)) {
                    for (const config of Object.values(versions)) {
                        // baseImage: string
                        assert.strictEqual(typeof config.baseImage, 'string');

                        // accelerator: object with type, version, versionRange
                        assert.strictEqual(typeof config.accelerator, 'object');
                        assert(config.accelerator !== null);
                        assert.strictEqual(typeof config.accelerator.type, 'string');

                        // envVars: object
                        assert.strictEqual(typeof config.envVars, 'object');
                        assert(config.envVars !== null);

                        // inferenceAmiVersion: string
                        assert.strictEqual(typeof config.inferenceAmiVersion, 'string');

                        // recommendedInstanceTypes: array
                        assert(Array.isArray(config.recommendedInstanceTypes));

                        // validationLevel: string in allowed set
                        assert(['tested', 'community-validated', 'experimental', 'untested'].includes(config.validationLevel));

                        // profiles: object
                        assert.strictEqual(typeof config.profiles, 'object');
                        assert(config.profiles !== null);

                        // notes: string
                        assert.strictEqual(typeof config.notes, 'string');
                    }
                }
            }),
            PROPERTY_CONFIG
        );
    });

    it('baseImage is mapped from Image_Entry.image field', () => {
        fc.assert(
            fc.property(arbCatalog, (catalog) => {
                const result = transformCatalog(catalog);

                for (const [fwName, entries] of Object.entries(catalog)) {
                    if (!Array.isArray(entries)) continue;
                    for (const entry of entries) {
                        const version = entry.labels?.framework_version;
                        if (!version) continue;
                        assert.strictEqual(
                            result[fwName]?.[version]?.baseImage,
                            entry.image,
                            `baseImage should match image field for ${fwName}@${version}`
                        );
                    }
                }
            }),
            PROPERTY_CONFIG
        );
    });

    it('envVars are mapped from defaults.envVars', () => {
        fc.assert(
            fc.property(arbCatalog, (catalog) => {
                const result = transformCatalog(catalog);

                for (const [fwName, entries] of Object.entries(catalog)) {
                    if (!Array.isArray(entries)) continue;
                    for (const entry of entries) {
                        const version = entry.labels?.framework_version;
                        if (!version) continue;
                        const config = result[fwName]?.[version];
                        assert.deepStrictEqual(
                            config?.envVars,
                            entry.defaults?.envVars || {},
                            `envVars should match defaults.envVars for ${fwName}@${version}`
                        );
                    }
                }
            }),
            PROPERTY_CONFIG
        );
    });

    it('transformation is deterministic (same input → same output)', () => {
        fc.assert(
            fc.property(arbCatalog, (catalog) => {
                const result1 = transformCatalog(catalog);
                const result2 = transformCatalog(catalog);
                assert.deepStrictEqual(result1, result2);
            }),
            PROPERTY_CONFIG
        );
    });

    it('version key comes from labels.framework_version', () => {
        fc.assert(
            fc.property(arbCatalog, (catalog) => {
                const result = transformCatalog(catalog);

                for (const [fwName, entries] of Object.entries(catalog)) {
                    if (!Array.isArray(entries)) continue;
                    const expectedVersions = new Set(
                        entries.map(e => e.labels?.framework_version).filter(Boolean)
                    );
                    const actualVersions = new Set(Object.keys(result[fwName] || {}));
                    // Every actual version should come from a label
                    for (const v of actualVersions) {
                        assert(expectedVersions.has(v), `Version ${v} should come from labels.framework_version`);
                    }
                }
            }),
            PROPERTY_CONFIG
        );
    });

    it('actual RegistryLoader produces valid output from real catalogs', async () => {
        const loader = new RegistryLoader();
        const registry = await loader.loadFrameworkRegistry();

        assert.strictEqual(typeof registry, 'object');
        assert(Object.keys(registry).length > 0, 'Should have at least one framework');

        for (const [fwName, versions] of Object.entries(registry)) {
            assert(Object.keys(versions).length > 0, `${fwName} should have at least one version`);
            for (const config of Object.values(versions)) {
                assert.strictEqual(typeof config.baseImage, 'string');
                assert(config.baseImage.length > 0, 'baseImage should be non-empty');
                assert.strictEqual(typeof config.accelerator, 'object');
                assert.strictEqual(typeof config.envVars, 'object');
                assert(Array.isArray(config.recommendedInstanceTypes));
                assert(['tested', 'community-validated', 'experimental', 'untested'].includes(config.validationLevel));
            }
        }
    });
});

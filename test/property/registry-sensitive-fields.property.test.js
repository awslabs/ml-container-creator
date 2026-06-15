// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Sensitive Field Stripping Property-Based Tests
 *
 * Property 2: Sensitive field stripping completeness and safety
 *
 * For any Deployment Entry containing sensitive fields (roleArn, region
 * in infrastructure; HF_TOKEN, NGC_API_KEY in configuration.parameters),
 * calling _stripSensitiveFields should return a copy where none of the
 * sensitive fields are present, all non-sensitive fields are preserved
 * in their original form, and the original entry object is not mutated.
 *
 * Feature: deployment-registry, Property 2: Sensitive field stripping completeness and safety
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import DeploymentRegistry from '../../src/lib/deployment-registry.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

const arbHexId = fc.stringMatching(/^[0-9a-f]{8}$/);

const arbTimestamp = fc.tuple(
    fc.integer({ min: 2020, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 })
).map(([y, m, d, h, min, s]) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}Z`;
});

const arbNonEmptyString = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}$/)
    .filter(s => s.length >= 1);

const arbNullableString = fc.oneof(
    fc.constant(null),
    arbNonEmptyString
);

const ARCHITECTURES = ['http', 'transformers', 'triton'];
const STATUSES = ['success', 'partial', 'failed'];
const SOURCES = ['local', 'imported', 'community'];

const SENSITIVE_PARAM_KEYS = ['HF_TOKEN', 'NGC_API_KEY'];

/**
 * Generate non-sensitive parameter keys (uppercase, not HF_TOKEN or NGC_API_KEY).
 */
const arbNonSensitiveParamKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/)
    .filter(s => s.length >= 1 && !SENSITIVE_PARAM_KEYS.includes(s));

/**
 * Generate a parameters dict that always includes both sensitive keys
 * plus some non-sensitive keys.
 */
const arbParametersWithSensitive = fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.dictionary(
        arbNonSensitiveParamKey,
        fc.string({ minLength: 0, maxLength: 20 })
    )
).map(([hfToken, ngcKey, rest]) => ({
    ...rest,
    HF_TOKEN: hfToken,
    NGC_API_KEY: ngcKey
}));

/**
 * Generate a parameters dict with only non-sensitive keys (no HF_TOKEN, no NGC_API_KEY).
 */
const arbParametersWithoutSensitive = fc.dictionary(
    arbNonSensitiveParamKey,
    fc.string({ minLength: 0, maxLength: 20 })
);

/**
 * Generate a deployment entry that always has sensitive fields populated:
 * - infrastructure.roleArn and infrastructure.region are non-null strings
 * - configuration.parameters includes HF_TOKEN and NGC_API_KEY
 */
const arbEntryWithSensitiveFields = fc.record({
    id: arbHexId,
    timestamp: arbTimestamp,
    status: fc.constantFrom(...STATUSES),
    deployment: fc.record({
        deploymentConfig: arbNonEmptyString,
        architecture: fc.constantFrom(...ARCHITECTURES),
        backend: arbNonEmptyString,
        baseImage: arbNullableString,
        deploymentTarget: arbNullableString,
        buildTarget: arbNullableString
    }),
    model: fc.record({
        modelName: arbNonEmptyString,
        modelFormat: arbNullableString
    }),
    infrastructure: fc.record({
        instanceType: arbNullableString,
        region: arbNonEmptyString,
        roleArn: arbNonEmptyString
    }),
    configuration: fc.record({
        parameters: arbParametersWithSensitive
    }),
    outcome: fc.record({
        notes: arbNullableString
    }),
    metadata: fc.record({
        generatorVersion: arbNonEmptyString,
        source: fc.constantFrom(...SOURCES),
        importedFrom: arbNullableString
    })
});

/**
 * Generate a deployment entry with no sensitive fields:
 * - infrastructure.roleArn and infrastructure.region are null
 * - configuration.parameters has no HF_TOKEN or NGC_API_KEY
 */
const arbEntryWithoutSensitiveFields = fc.record({
    id: arbHexId,
    timestamp: arbTimestamp,
    status: fc.constantFrom(...STATUSES),
    deployment: fc.record({
        deploymentConfig: arbNonEmptyString,
        architecture: fc.constantFrom(...ARCHITECTURES),
        backend: arbNonEmptyString,
        baseImage: arbNullableString,
        deploymentTarget: arbNullableString,
        buildTarget: arbNullableString
    }),
    model: fc.record({
        modelName: arbNonEmptyString,
        modelFormat: arbNullableString
    }),
    infrastructure: fc.record({
        instanceType: arbNullableString,
        region: fc.constant(null),
        roleArn: fc.constant(null)
    }),
    configuration: fc.record({
        parameters: arbParametersWithoutSensitive
    }),
    outcome: fc.record({
        notes: arbNullableString
    }),
    metadata: fc.record({
        generatorVersion: arbNonEmptyString,
        source: fc.constantFrom(...SOURCES),
        importedFrom: arbNullableString
    })
});

// ── Property 2: Sensitive field stripping completeness and safety ─────────────

describe('Feature: deployment-registry, Property 2: Sensitive field stripping completeness and safety', () => {

    let tmpDir;
    let registryPath;
    let registry;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-sensitive-p2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        registryPath = join(tmpDir, 'registry.json');
        registry = new DeploymentRegistry(registryPath);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 7.4
     */

    it('strips all sensitive fields from entries that contain them', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbEntryWithSensitiveFields,
            (entry) => {
                const stripped = registry._stripSensitiveFields(entry);

                // Sensitive infrastructure fields must be absent
                assert.strictEqual(
                    'roleArn' in stripped.infrastructure,
                    false,
                    'roleArn should be stripped from infrastructure'
                );
                assert.strictEqual(
                    'region' in stripped.infrastructure,
                    false,
                    'region should be stripped from infrastructure'
                );

                // Sensitive parameter keys must be absent
                assert.strictEqual(
                    'HF_TOKEN' in stripped.configuration.parameters,
                    false,
                    'HF_TOKEN should be stripped from configuration.parameters'
                );
                assert.strictEqual(
                    'NGC_API_KEY' in stripped.configuration.parameters,
                    false,
                    'NGC_API_KEY should be stripped from configuration.parameters'
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('preserves all non-sensitive fields in their original form', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        // Helper to normalize objects through JSON round-trip so prototype
        // differences (e.g. null-prototype from fc.dictionary) don't cause
        // false negatives with deepStrictEqual.
        const normalize = (obj) => JSON.parse(JSON.stringify(obj));

        fc.assert(fc.property(
            arbEntryWithSensitiveFields,
            (entry) => {
                const stripped = registry._stripSensitiveFields(entry);

                // Top-level non-infrastructure/configuration fields preserved
                assert.strictEqual(stripped.id, entry.id);
                assert.strictEqual(stripped.timestamp, entry.timestamp);
                assert.strictEqual(stripped.status, entry.status);
                assert.deepStrictEqual(normalize(stripped.deployment), normalize(entry.deployment));
                assert.deepStrictEqual(normalize(stripped.model), normalize(entry.model));
                assert.deepStrictEqual(normalize(stripped.outcome), normalize(entry.outcome));
                assert.deepStrictEqual(normalize(stripped.metadata), normalize(entry.metadata));

                // Non-sensitive infrastructure fields preserved
                assert.strictEqual(
                    stripped.infrastructure.instanceType,
                    entry.infrastructure.instanceType
                );

                // Non-sensitive parameters preserved
                const nonSensitiveParams = Object.entries(entry.configuration.parameters)
                    .filter(([key]) => !SENSITIVE_PARAM_KEYS.includes(key));

                for (const [key, value] of nonSensitiveParams) {
                    assert.strictEqual(
                        stripped.configuration.parameters[key],
                        value,
                        `Non-sensitive parameter "${key}" should be preserved`
                    );
                }

                // No extra keys in stripped parameters
                const strippedParamKeys = Object.keys(stripped.configuration.parameters);
                for (const key of strippedParamKeys) {
                    assert.ok(
                        !SENSITIVE_PARAM_KEYS.includes(key),
                        `Sensitive key "${key}" should not be in stripped parameters`
                    );
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('does not mutate the original entry object', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        // Helper to normalize objects through JSON round-trip
        const normalize = (obj) => JSON.parse(JSON.stringify(obj));

        fc.assert(fc.property(
            arbEntryWithSensitiveFields,
            (entry) => {
                // Snapshot the original (normalized to avoid prototype diffs)
                const originalSnapshot = normalize(entry);

                registry._stripSensitiveFields(entry);

                // Original entry must be unchanged
                assert.deepStrictEqual(
                    normalize(entry),
                    originalSnapshot,
                    'Original entry should not be mutated by _stripSensitiveFields'
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('preserves entries without sensitive fields unchanged', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        // Helper to normalize objects through JSON round-trip
        const normalize = (obj) => JSON.parse(JSON.stringify(obj));

        fc.assert(fc.property(
            arbEntryWithoutSensitiveFields,
            (entry) => {
                const stripped = registry._stripSensitiveFields(entry);

                // All top-level fields preserved
                assert.strictEqual(stripped.id, entry.id);
                assert.strictEqual(stripped.timestamp, entry.timestamp);
                assert.strictEqual(stripped.status, entry.status);
                assert.deepStrictEqual(normalize(stripped.deployment), normalize(entry.deployment));
                assert.deepStrictEqual(normalize(stripped.model), normalize(entry.model));
                assert.deepStrictEqual(normalize(stripped.outcome), normalize(entry.outcome));
                assert.deepStrictEqual(normalize(stripped.metadata), normalize(entry.metadata));

                // Infrastructure: instanceType preserved, roleArn/region were null
                assert.strictEqual(
                    stripped.infrastructure.instanceType,
                    entry.infrastructure.instanceType
                );

                // All parameters preserved (none were sensitive)
                assert.deepStrictEqual(
                    normalize(stripped.configuration.parameters),
                    normalize(entry.configuration.parameters)
                );

                // Original not mutated
                const originalSnapshot = normalize(entry);
                registry._stripSensitiveFields(entry);
                assert.deepStrictEqual(normalize(entry), originalSnapshot);

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

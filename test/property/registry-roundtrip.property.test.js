// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Round-Trip Integrity Property-Based Tests
 *
 * Property 1: Registry round-trip integrity
 *
 * For any valid registry (a versioned JSON envelope containing schemaVersion
 * and an entries array of valid Deployment Entry objects), reading the registry
 * file and then writing it back should produce a file with byte-equivalent
 * content, preserving the schema version, entry order, 2-space indentation,
 * and all field values.
 *
 * Feature: deployment-registry, Property 1: Registry round-trip integrity
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import DeploymentRegistry from '../../src/lib/deployment-registry.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid 8-char hex ID.
 */
const arbHexId = fc.stringMatching(/^[0-9a-f]{8}$/);

/**
 * Generate a valid ISO 8601 timestamp.
 */
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

/**
 * Generate a non-empty alphanumeric string.
 */
const arbNonEmptyString = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}$/)
    .filter(s => s.length >= 1);

/**
 * Generate a nullable string (string or null).
 */
const arbNullableString = fc.oneof(
    fc.constant(null),
    arbNonEmptyString
);

/**
 * Generate a valid deployment entry matching the schema.
 */
const arbValidDeploymentEntry = fc.record({
    id: arbHexId,
    timestamp: arbTimestamp,
    status: fc.constantFrom('success', 'partial', 'failed'),
    deployment: fc.record({
        deploymentConfig: arbNonEmptyString,
        architecture: fc.constantFrom('http', 'transformers', 'triton'),
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
        region: arbNullableString,
        roleArn: arbNullableString
    }),
    configuration: fc.record({
        parameters: fc.dictionary(
            fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1),
            fc.string({ minLength: 0, maxLength: 20 })
        )
    }),
    outcome: fc.record({
        notes: arbNullableString
    }),
    metadata: fc.record({
        generatorVersion: arbNonEmptyString,
        source: fc.constantFrom('local', 'imported', 'community'),
        importedFrom: arbNullableString
    })
});

/**
 * Generate a valid registry: an array of 0-5 valid deployment entries.
 */
const arbValidRegistry = fc.array(arbValidDeploymentEntry, { minLength: 0, maxLength: 5 });

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 1: Registry round-trip integrity', () => {

    let tmpDir;
    let registryPath;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        registryPath = join(tmpDir, 'registry.json');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 16.2, 16.1, 16.3, 16.4
     */
    it('writing a registry then reading and writing again produces byte-equivalent files', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidRegistry,
            (entries) => {
                const registry = new DeploymentRegistry(registryPath);

                // First write
                registry._writeRegistry(entries);
                const firstContent = readFileSync(registryPath, 'utf8');

                // Read back
                const readEntries = registry._readRegistry();

                // Second write
                registry._writeRegistry(readEntries);
                const secondContent = readFileSync(registryPath, 'utf8');

                // Byte-equivalent content
                assert.strictEqual(
                    firstContent,
                    secondContent,
                    'Reading then writing should produce byte-equivalent file content'
                );

                // Verify 2-space indentation
                const parsed = JSON.parse(firstContent);
                const expectedJson = `${JSON.stringify(parsed, null, 2)  }\n`;
                assert.strictEqual(
                    firstContent,
                    expectedJson,
                    'Registry file should use 2-space indentation with trailing newline'
                );

                // Verify schema version is preserved
                assert.strictEqual(
                    parsed.schemaVersion,
                    '2026-03-20',
                    'Schema version should be preserved'
                );

                // Verify entry order and field values are preserved
                assert.strictEqual(
                    readEntries.length,
                    entries.length,
                    'Entry count should be preserved'
                );
                for (let i = 0; i < entries.length; i++) {
                    // Compare via JSON to normalize prototype differences
                    // from fast-check's dictionary generator
                    assert.deepStrictEqual(
                        JSON.parse(JSON.stringify(readEntries[i])),
                        JSON.parse(JSON.stringify(entries[i])),
                        `Entry at index ${i} should be preserved`
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

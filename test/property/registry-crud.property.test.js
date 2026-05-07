// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry CRUD Property-Based Tests
 *
 * Property 6: Add then get round-trip
 * Property 7: Remove then get yields null
 * Property 14: Entry ID format
 *
 * Feature: deployment-registry
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
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
 * Generate a valid deployment entry WITHOUT an id field.
 * Used for add() which generates the id internally.
 */
const arbValidEntryWithoutId = fc.record({
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

// ── Hex ID regex ─────────────────────────────────────────────────────────────

const HEX_ID_PATTERN = /^[0-9a-f]{8}$/;

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: deployment-registry, Property 14: Entry ID format', () => {

    let tmpDir;
    let registryPath;
    let registry;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-crud-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        registryPath = join(tmpDir, 'registry.json');
        registry = new DeploymentRegistry(registryPath);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 15.1, 15.2
     */
    it('_generateId always returns an 8-character hexadecimal string', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidDeploymentEntry,
            (entry) => {
                const id = registry._generateId(entry);

                // Must be a string
                assert.strictEqual(typeof id, 'string', 'ID should be a string');

                // Must be exactly 8 characters
                assert.strictEqual(id.length, 8, `ID should be 8 characters but got ${id.length}: "${id}"`);

                // Must consist only of hex characters (0-9, a-f)
                assert.ok(
                    HEX_ID_PATTERN.test(id),
                    `ID should match /^[0-9a-f]{8}$/ but got "${id}"`
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});


// ── Property 6: Add then get round-trip ──────────────────────────────────────

describe('Feature: deployment-registry, Property 6: Add then get round-trip', () => {

    let tmpDir;
    let registryPath;
    let registry;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-crud-p6-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        registryPath = join(tmpDir, 'registry.json');
        registry = new DeploymentRegistry(registryPath);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 4.1, 15.1
     *
     * For any valid Deployment Entry, adding it to the registry and then
     * getting it by the returned ID should yield an entry with equivalent
     * field values.
     */
    it('adding an entry and getting it by ID yields equivalent field values', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidEntryWithoutId,
            (entry) => {
                const id = registry.add(entry);

                // ID must be valid 8-char hex
                assert.ok(HEX_ID_PATTERN.test(id), `Returned ID should be 8-char hex but got "${id}"`);

                const retrieved = registry.get(id);

                // Must not be null
                assert.notStrictEqual(retrieved, null, 'get() should return the entry, not null');

                // Retrieved entry should have the same id
                assert.strictEqual(retrieved.id, id, 'Retrieved entry ID should match returned ID');

                // All original fields should be equivalent.
                // Use JSON round-trip for comparison since the registry
                // serializes to JSON and back, normalizing prototypes.
                const normalize = (obj) => JSON.parse(JSON.stringify(obj));

                assert.strictEqual(retrieved.timestamp, entry.timestamp);
                assert.strictEqual(retrieved.status, entry.status);
                assert.deepStrictEqual(retrieved.deployment, normalize(entry.deployment));
                assert.deepStrictEqual(retrieved.model, normalize(entry.model));
                assert.deepStrictEqual(retrieved.infrastructure, normalize(entry.infrastructure));
                assert.deepStrictEqual(retrieved.configuration, normalize(entry.configuration));
                assert.deepStrictEqual(retrieved.outcome, normalize(entry.outcome));
                assert.deepStrictEqual(retrieved.metadata, normalize(entry.metadata));

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

// ── Property 7: Remove then get yields null ──────────────────────────────────

describe('Feature: deployment-registry, Property 7: Remove then get yields null', () => {

    let tmpDir;
    let registryPath;
    let registry;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-crud-p7-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        registryPath = join(tmpDir, 'registry.json');
        registry = new DeploymentRegistry(registryPath);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 5.1, 15.1
     *
     * For any registry containing at least one entry, removing an entry
     * by its ID should cause a subsequent get for that ID to return null,
     * and the registry length should decrease by exactly one.
     */
    it('removing an entry causes get to return null and decreases length by one', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidEntryWithoutId,
            (entry) => {
                // Add the entry first
                const id = registry.add(entry);

                // Verify it exists
                const beforeRemove = registry.get(id);
                assert.notStrictEqual(beforeRemove, null, 'Entry should exist before removal');

                // Get length before removal
                const lengthBefore = registry._readRegistry().length;

                // Remove the entry
                const removed = registry.remove(id);
                assert.strictEqual(removed, true, 'remove() should return true for existing entry');

                // Get should now return null
                const afterRemove = registry.get(id);
                assert.strictEqual(afterRemove, null, 'get() should return null after removal');

                // Length should decrease by exactly one
                const lengthAfter = registry._readRegistry().length;
                assert.strictEqual(lengthAfter, lengthBefore - 1, 'Registry length should decrease by exactly one');

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

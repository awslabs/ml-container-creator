// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Filtering Property-Based Tests
 *
 * Property 3: Entry filtering correctness
 * Property 4: Glob-based model search
 *
 * Feature: deployment-registry
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { minimatch } from 'minimatch';
import DeploymentRegistry from '../../generators/app/lib/deployment-registry.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

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

const arbValidDeploymentEntry = fc.record({
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
        source: fc.constantFrom(...SOURCES),
        importedFrom: arbNullableString
    })
});

// ── Filter generators ────────────────────────────────────────────────────────

/**
 * Generate a random combination of filters. Each filter key is optionally
 * present, and when present its value is drawn from the corresponding
 * domain so that matches are possible.
 */
const arbFilters = (_entries) => {
    return fc.record({
        backend: fc.oneof(fc.constant(undefined), arbNonEmptyString),
        architecture: fc.oneof(fc.constant(undefined), fc.constantFrom(...ARCHITECTURES)),
        model: fc.oneof(fc.constant(undefined), arbNonEmptyString),
        'instance-type': fc.oneof(fc.constant(undefined), arbNonEmptyString),
        status: fc.oneof(fc.constant(undefined), fc.constantFrom(...STATUSES))
    });
};

/**
 * Reference implementation of _matchesFilters for verification.
 * Mirrors the AND-logic filtering from DeploymentRegistry.
 */
function referenceMatchesFilters(entry, filters) {
    if (!filters || typeof filters !== 'object') return true;

    for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === null) continue;

        switch (key) {
        case 'backend':
            if (entry.deployment?.backend !== value) return false;
            break;
        case 'architecture':
            if (entry.deployment?.architecture !== value) return false;
            break;
        case 'model':
            if (!entry.model?.modelName?.toLowerCase().includes(value.toLowerCase())) return false;
            break;
        case 'instance-type':
            if (entry.infrastructure?.instanceType !== value) return false;
            break;
        case 'status':
            if (entry.status !== value) return false;
            break;
        default:
            break;
        }
    }
    return true;
}

// ── Glob pattern generators ──────────────────────────────────────────────────

/**
 * Known model name segments for building realistic model names and patterns.
 */
const MODEL_ORGS = ['meta-llama', 'google', 'mistralai', 'microsoft', 'openai'];
const MODEL_NAMES = ['Llama-2-7b', 'gemma-2b', 'Mistral-7B', 'phi-2', 'gpt-neo'];
const MODEL_SUFFIXES = ['-chat-hf', '-instruct', '-base', '-v1.0', ''];

/**
 * Generate a structured model name like "meta-llama/Llama-2-7b-chat-hf".
 */
const arbModelName = fc.tuple(
    fc.constantFrom(...MODEL_ORGS),
    fc.constantFrom(...MODEL_NAMES),
    fc.constantFrom(...MODEL_SUFFIXES)
).map(([org, name, suffix]) => `${org}/${name}${suffix}`);

/**
 * Generate a glob pattern that can match model names.
 * Patterns include: org/*, *name*, exact match, etc.
 */
const arbGlobPattern = fc.oneof(
    // org/* — matches all models from an org
    fc.constantFrom(...MODEL_ORGS).map(org => `${org}/*`),
    // *substring* — matches models containing a substring
    fc.constantFrom(...MODEL_NAMES).map(name => `*${name}*`),
    // exact match — pick a full model name
    fc.tuple(
        fc.constantFrom(...MODEL_ORGS),
        fc.constantFrom(...MODEL_NAMES),
        fc.constantFrom(...MODEL_SUFFIXES)
    ).map(([org, name, suffix]) => `${org}/${name}${suffix}`),
    // wildcard everything
    fc.constant('*'),
    // org prefix with partial name
    fc.tuple(
        fc.constantFrom(...MODEL_ORGS),
        fc.constantFrom(...MODEL_NAMES)
    ).map(([org, name]) => `${org}/${name}*`)
);

/**
 * Generate a valid entry with a structured model name (for glob tests).
 */
const arbEntryWithModelName = fc.tuple(
    arbValidDeploymentEntry,
    arbModelName
).map(([entry, modelName]) => ({
    ...entry,
    model: { ...entry.model, modelName }
}));

// ── Property 3: Entry filtering correctness ──────────────────────────────────

describe('Feature: deployment-registry, Property 3: Entry filtering correctness', () => {

    let tmpDir;
    let registryPath;
    let registry;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-filter-p3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        registryPath = join(tmpDir, 'registry.json');
        registry = new DeploymentRegistry(registryPath);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 9.2, 9.3, 9.4, 9.5
     *
     * For any registry of entries and any combination of filters (backend,
     * architecture, model substring, instance-type, status), the list
     * operation should return exactly those entries that satisfy every
     * provided filter (AND logic).
     */
    it('list(filters) returns exactly the entries matching all filters (AND logic)', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbValidDeploymentEntry, { minLength: 0, maxLength: 10 }),
            arbFilters(),
            (entries, filters) => {
                // Write entries directly to the registry file
                registry._writeRegistry(entries);

                // Call list with the generated filters
                const result = registry.list(filters);

                // Compute expected result using reference implementation
                const expected = entries.filter(e => referenceMatchesFilters(e, filters));

                // Result should have the same length
                assert.strictEqual(
                    result.length,
                    expected.length,
                    `Expected ${expected.length} entries but got ${result.length} for filters ${JSON.stringify(filters)}`
                );

                // Each returned entry should match all filters
                for (const entry of result) {
                    assert.ok(
                        referenceMatchesFilters(entry, filters),
                        `Returned entry ${entry.id} does not match filters ${JSON.stringify(filters)}`
                    );
                }

                // Each expected entry should be in the result
                const resultIds = new Set(result.map(e => e.id));
                for (const entry of expected) {
                    assert.ok(
                        resultIds.has(entry.id),
                        `Expected entry ${entry.id} missing from results`
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

// ── Property 4: Glob-based model search ──────────────────────────────────────

describe('Feature: deployment-registry, Property 4: Glob-based model search', () => {

    let tmpDir;
    let registryPath;
    let registry;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `registry-filter-p4-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        registryPath = join(tmpDir, 'registry.json');
        registry = new DeploymentRegistry(registryPath);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 9.1
     *
     * For any registry of entries and any glob pattern, search with
     * --model should return exactly those entries whose modelName
     * matches the glob pattern.
     */
    it('search({model: pattern}) returns exactly entries whose modelName matches the glob', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.array(arbEntryWithModelName, { minLength: 0, maxLength: 10 }),
            arbGlobPattern,
            (entries, pattern) => {
                // Write entries directly to the registry file
                registry._writeRegistry(entries);

                // Call search with the glob pattern
                const result = registry.search({ model: pattern });

                // Compute expected result using minimatch
                const expected = entries.filter(e =>
                    e.model?.modelName && minimatch(e.model.modelName, pattern)
                );

                // Result should have the same length
                assert.strictEqual(
                    result.length,
                    expected.length,
                    `Expected ${expected.length} entries but got ${result.length} for pattern "${pattern}"`
                );

                // Each returned entry's modelName should match the glob
                for (const entry of result) {
                    assert.ok(
                        minimatch(entry.model.modelName, pattern),
                        `Returned entry model "${entry.model.modelName}" does not match glob "${pattern}"`
                    );
                }

                // Each expected entry should be in the result
                const resultIds = new Set(result.map(e => e.id));
                for (const entry of expected) {
                    assert.ok(
                        resultIds.has(entry.id),
                        `Expected entry ${entry.id} (model: "${entry.model.modelName}") missing from results for pattern "${pattern}"`
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

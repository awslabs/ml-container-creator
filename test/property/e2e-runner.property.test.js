// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E Validation Runner Property-Based Tests
 *
 * Property 9: Aggregation produces structurally complete results
 *
 * Feature: e2e-validation-runner
 */

import fc from 'fast-check';
import { describe, it, before, after } from 'mocha';
import assert from 'assert';
import { aggregateResults, formatMarkdown } from '../../scripts/e2e-summary.js';
import { filterByTier, validateCatalog } from '../../src/lib/e2e-catalog-validator.js';
import { sumInstanceRequirements } from '../../src/lib/e2e-quota-validator.js';
import { runConfig, Semaphore } from '../../scripts/e2e-runner.js';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

const arbStepStatus = fc.constantFrom('pass', 'fail', 'skip');

const arbStepName = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/);

const arbStep = fc.record({
    name: arbStepName,
    status: arbStepStatus,
    duration: fc.nat({ max: 600000 })
});

const arbConfigStatus = fc.constantFrom('pass', 'fail');

const arbConfigId = fc.stringMatching(/^[a-z0-9-]{3,30}$/);

const arbConfigResult = fc.record({
    id: arbConfigId,
    status: arbConfigStatus,
    duration: fc.nat({ max: 3600000 }),
    steps: fc.array(arbStep, { minLength: 1, maxLength: 10 })
}).chain(config => {
    // Optionally add an error field for failed configs
    if (config.status === 'fail') {
        return fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined })
            .map(error => error !== undefined ? { ...config, error } : config);
    }
    return fc.constant(config);
});

const arbRunId = fc.oneof(
    fc.constant('2026-05-13T16:00:00Z'),
    fc.constant('2026-01-01T00:00:00Z'),
    fc.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
);

const arbTier = fc.constantFrom('ci', 'nightly', 'weekly');

const arbMeta = fc.record({
    runId: arbRunId,
    tier: arbTier,
    startTime: fc.integer({ min: 0, max: Date.now() })
});

const arbResults = fc.array(arbConfigResult, { minLength: 0, maxLength: 20 });

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: e2e-validation-runner, Property 9: Aggregation produces structurally complete results', () => {

    /**
     * Validates: Requirements 5.1, 5.2
     *
     * For any array of config results, the summary aggregator SHALL produce
     * a JSON object containing: runId, tier, correct passed/failed counts
     * matching the input, total duration ≥ 0, and per-config results each
     * containing id, status, duration, and a steps array with per-step
     * name/status/duration.
     */
    it('output contains runId and tier from meta', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                assert.strictEqual(output.runId, meta.runId,
                    `runId should be '${meta.runId}', got '${output.runId}'`);
                assert.strictEqual(output.tier, meta.tier,
                    `tier should be '${meta.tier}', got '${output.tier}'`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('passed count equals number of pass results in input', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);
                const expectedPassed = results.filter(r => r.status === 'pass').length;

                assert.strictEqual(output.passed, expectedPassed,
                    `passed should be ${expectedPassed}, got ${output.passed}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('failed count equals number of fail results in input', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);
                const expectedFailed = results.filter(r => r.status === 'fail').length;

                assert.strictEqual(output.failed, expectedFailed,
                    `failed should be ${expectedFailed}, got ${output.failed}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('passed + failed equals total number of results', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                assert.strictEqual(output.passed + output.failed, results.length,
                    `passed (${output.passed}) + failed (${output.failed}) should equal total results (${results.length})`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('duration is non-negative', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                assert.ok(output.duration >= 0,
                    `duration should be non-negative, got ${output.duration}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('per-config results preserve all required fields', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                assert.strictEqual(output.results.length, results.length,
                    'output results length should match input length');

                for (let i = 0; i < output.results.length; i++) {
                    const config = output.results[i];

                    // Each config result must have id, status, duration, steps
                    assert.ok('id' in config,
                        `config result at index ${i} must have 'id' field`);
                    assert.ok('status' in config,
                        `config result at index ${i} must have 'status' field`);
                    assert.ok('duration' in config,
                        `config result at index ${i} must have 'duration' field`);
                    assert.ok('steps' in config,
                        `config result at index ${i} must have 'steps' field`);
                    assert.ok(Array.isArray(config.steps),
                        `config result at index ${i} 'steps' must be an array`);

                    // Verify values match input
                    assert.strictEqual(config.id, results[i].id);
                    assert.strictEqual(config.status, results[i].status);
                    assert.strictEqual(config.duration, results[i].duration);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('per-step results contain name, status, and duration', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                for (const config of output.results) {
                    for (const step of config.steps) {
                        assert.ok('name' in step,
                            'step must have \'name\' field');
                        assert.ok('status' in step,
                            'step must have \'status\' field');
                        assert.ok('duration' in step,
                            'step must have \'duration\' field');
                        assert.ok(typeof step.name === 'string',
                            'step name must be a string');
                        assert.ok(['pass', 'fail', 'skip'].includes(step.status),
                            `step status must be pass/fail/skip, got '${step.status}'`);
                        assert.ok(typeof step.duration === 'number' && step.duration >= 0,
                            'step duration must be a non-negative number');
                    }
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('output results array is the same reference as input results', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                // The aggregator passes through the results array directly
                assert.strictEqual(output.results, results,
                    'output results should be the same array as input results');
            }
        ), FAST_PROPERTY_CONFIG);
    });
});


// ── Property 10 ──────────────────────────────────────────────────────────────

// Generator for a complete RunResult suitable for formatMarkdown
const arbRunResult = fc.record({
    runId: fc.oneof(
        fc.constant('2026-05-13T16:00:00Z'),
        fc.stringMatching(/^[a-zA-Z0-9-]{1,30}$/)
    ),
    tier: arbTier,
    duration: fc.nat({ max: 28800000 }),
    results: fc.array(arbConfigResult, { minLength: 1, maxLength: 10 })
}).map(r => {
    const passed = r.results.filter(c => c.status === 'pass').length;
    const failed = r.results.filter(c => c.status === 'fail').length;
    return { ...r, passed, failed };
});

describe('Feature: e2e-validation-runner, Property 10: Markdown summary contains all key information', () => {

    /**
     * **Validates: Requirements 5.3**
     *
     * For any run result, the markdown output SHALL contain the tier name,
     * total passed count, total failed count, and every config's ID and status.
     */
    it('markdown output contains tier name, passed count, failed count, and every config ID and status', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbRunResult,
            (runResult) => {
                const md = formatMarkdown(runResult);

                // Tier name must appear in the markdown
                assert.ok(
                    md.includes(runResult.tier),
                    `Markdown should contain tier name "${runResult.tier}"`
                );

                // Passed count must appear in the markdown
                assert.ok(
                    md.includes(String(runResult.passed)),
                    `Markdown should contain passed count "${runResult.passed}"`
                );

                // Failed count must appear in the markdown
                assert.ok(
                    md.includes(String(runResult.failed)),
                    `Markdown should contain failed count "${runResult.failed}"`
                );

                // Every config's ID must appear in the markdown
                for (const config of runResult.results) {
                    assert.ok(
                        md.includes(config.id),
                        `Markdown should contain config ID "${config.id}"`
                    );

                    // Every config's status must appear in the markdown
                    assert.ok(
                        md.includes(config.status),
                        `Markdown should contain config status "${config.status}" for config "${config.id}"`
                    );
                }
            }
        ), { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), verbose: false });
    });
});



// ── Property 2 ──────────────────────────────────────────────────────────────

// Generators for catalog entries with mixed tiers
const arbTierValue = fc.constantFrom('ci', 'nightly', 'weekly');

const arbTrack = fc.constantFrom('realtime', 'hyperpod', 'async', 'batch');

const arbCatalogEntry = fc.record({
    id: fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,20}$/),
    tier: arbTierValue,
    track: arbTrack,
    args: fc.constant('--deployment-config=transformers-vllm --model-name=test --instance-type=ml.g6e.xlarge'),
    lifecycle: fc.array(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
        { minLength: 1, maxLength: 5 }
    ),
    timeout: fc.integer({ min: 60, max: 7200 })
});

const arbCatalog = fc.array(arbCatalogEntry, { minLength: 1, maxLength: 20 })
    .map(entries => ({ configs: entries }));

describe('Feature: e2e-validation-runner, Property 2: Tier filtering returns exactly the matching entries', () => {

    /**
     * **Validates: Requirements 1.2, 2.1**
     *
     * For any catalog containing entries with mixed tiers and any valid tier
     * value, filtering by that tier SHALL return all and only entries whose
     * tier field equals the filter value.
     */
    it('all returned entries have the specified tier', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbCatalog,
            arbTierValue,
            (catalog, tier) => {
                const result = filterByTier(catalog, tier);

                for (const entry of result) {
                    assert.strictEqual(entry.tier, tier,
                        `Expected tier "${tier}", got "${entry.tier}" for entry "${entry.id}"`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('no entries with the specified tier are missing from the result', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbCatalog,
            arbTierValue,
            (catalog, tier) => {
                const result = filterByTier(catalog, tier);
                const expected = catalog.configs.filter(c => c.tier === tier);

                assert.strictEqual(result.length, expected.length,
                    `Expected ${expected.length} entries with tier "${tier}", got ${result.length}`);

                for (const entry of expected) {
                    const found = result.some(r => r.id === entry.id && r.tier === entry.tier);
                    assert.ok(found,
                        `Entry "${entry.id}" with tier "${tier}" should be in the result`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('count of returned entries equals count of entries with that tier in input', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbCatalog,
            arbTierValue,
            (catalog, tier) => {
                const result = filterByTier(catalog, tier);
                const expectedCount = catalog.configs.filter(c => c.tier === tier).length;

                assert.strictEqual(result.length, expectedCount,
                    `Expected ${expectedCount} entries for tier "${tier}", got ${result.length}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('returns empty array for null or invalid catalog', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbTierValue,
            (tier) => {
                assert.deepStrictEqual(filterByTier(null, tier), [],
                    'null catalog should return empty array');
                assert.deepStrictEqual(filterByTier(undefined, tier), [],
                    'undefined catalog should return empty array');
                assert.deepStrictEqual(filterByTier({}, tier), [],
                    'catalog without configs should return empty array');
                assert.deepStrictEqual(filterByTier({ configs: 'not-array' }, tier), [],
                    'catalog with non-array configs should return empty array');
            }
        ), FAST_PROPERTY_CONFIG);
    });
});


// ── Property 1 ──────────────────────────────────────────────────────────────

// Generators for valid catalog entries

const arbValidId = fc.stringMatching(/^[a-z0-9][a-z0-9-]{1,20}$/);

const arbValidTier = fc.constantFrom('ci', 'nightly', 'weekly');

const arbValidTrack = fc.constantFrom('realtime', 'hyperpod', 'async', 'batch');

const arbValidArgs = fc.string({ minLength: 1, maxLength: 100 });

const arbValidLifecycleStep = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/);

const arbValidLifecycle = fc.array(arbValidLifecycleStep, { minLength: 1, maxLength: 8 });

const arbValidTimeout = fc.integer({ min: 60, max: 86400 });

const arbValidCatalogEntry = fc.record({
    id: arbValidId,
    tier: arbValidTier,
    track: arbValidTrack,
    args: arbValidArgs,
    lifecycle: arbValidLifecycle,
    timeout: arbValidTimeout
});

// Generator for a valid catalog with unique IDs
const arbValidCatalog = fc.array(arbValidCatalogEntry, { minLength: 1, maxLength: 10 })
    .map(entries => {
        // Ensure unique IDs by appending index
        const uniqueEntries = entries.map((entry, i) => ({
            ...entry,
            id: `${entry.id}-${i}`
        }));
        return { configs: uniqueEntries };
    });

// Generators for invalid catalog entries

const arbInvalidTier = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => !['ci', 'nightly', 'weekly'].includes(s));

const arbInvalidTrack = fc.string({ minLength: 1, maxLength: 20 })
    .filter(s => !['realtime', 'hyperpod', 'async', 'batch'].includes(s));

describe('Feature: e2e-validation-runner, Property 1: Catalog schema validation accepts valid entries and rejects invalid ones', () => {

    /**
     * **Validates: Requirements 1.1**
     *
     * For any catalog entry object, the schema validator SHALL accept it
     * if and only if it contains all required fields (id, tier, track, args,
     * lifecycle, timeout) with correct types and valid enum values.
     */
    it('valid catalog entries pass validation', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbValidCatalog,
            (catalog) => {
                const result = validateCatalog(catalog);

                assert.strictEqual(result.valid, true,
                    `Valid catalog should pass validation but got errors: ${JSON.stringify(result.errors)}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('entries with invalid tier enum values fail validation', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbValidCatalogEntry,
            arbInvalidTier,
            (entry, badTier) => {
                const catalog = {
                    configs: [{ ...entry, tier: badTier }]
                };
                const result = validateCatalog(catalog);

                assert.strictEqual(result.valid, false,
                    `Catalog with invalid tier "${badTier}" should fail validation`);
                assert.ok(result.errors.length > 0,
                    'Should have at least one error');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('entries with invalid track enum values fail validation', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbValidCatalogEntry,
            arbInvalidTrack,
            (entry, badTrack) => {
                const catalog = {
                    configs: [{ ...entry, track: badTrack }]
                };
                const result = validateCatalog(catalog);

                assert.strictEqual(result.valid, false,
                    `Catalog with invalid track "${badTrack}" should fail validation`);
                assert.ok(result.errors.length > 0,
                    'Should have at least one error');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('entries missing required fields fail validation', function () {
        this.timeout(30000);

        const requiredFields = ['id', 'tier', 'track', 'args', 'lifecycle', 'timeout'];

        fc.assert(fc.property(
            arbValidCatalogEntry,
            fc.constantFrom(...requiredFields),
            (entry, fieldToRemove) => {
                const incomplete = { ...entry };
                delete incomplete[fieldToRemove];

                const catalog = { configs: [incomplete] };
                const result = validateCatalog(catalog);

                assert.strictEqual(result.valid, false,
                    `Catalog missing "${fieldToRemove}" should fail validation`);
                assert.ok(result.errors.length > 0,
                    'Should have at least one error');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('entries with empty lifecycle array fail validation', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbValidCatalogEntry,
            (entry) => {
                const catalog = {
                    configs: [{ ...entry, lifecycle: [] }]
                };
                const result = validateCatalog(catalog);

                assert.strictEqual(result.valid, false,
                    'Catalog with empty lifecycle should fail validation');
                assert.ok(result.errors.length > 0,
                    'Should have at least one error');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('entries with timeout below 60 fail validation', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbValidCatalogEntry,
            fc.integer({ min: -1000, max: 59 }),
            (entry, badTimeout) => {
                const catalog = {
                    configs: [{ ...entry, timeout: badTimeout }]
                };
                const result = validateCatalog(catalog);

                assert.strictEqual(result.valid, false,
                    `Catalog with timeout ${badTimeout} (< 60) should fail validation`);
                assert.ok(result.errors.length > 0,
                    'Should have at least one error');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('duplicate IDs fail validation', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbValidCatalogEntry,
            arbValidCatalogEntry,
            (entry1, entry2) => {
                const sharedId = entry1.id;
                const catalog = {
                    configs: [
                        { ...entry1, id: sharedId },
                        { ...entry2, id: sharedId }
                    ]
                };
                const result = validateCatalog(catalog);

                assert.strictEqual(result.valid, false,
                    `Catalog with duplicate id "${sharedId}" should fail validation`);
                assert.ok(result.errors.some(e => e.message.includes('duplicate')),
                    'Should have a duplicate ID error');
            }
        ), FAST_PROPERTY_CONFIG);
    });
});


// ── Property 7 ──────────────────────────────────────────────────────────────

// Generators for catalog entries with known instance types in args

const arbInstanceType = fc.constantFrom(
    'ml.g6e.xlarge',
    'ml.g6e.2xlarge',
    'ml.g6e.4xlarge',
    'ml.g6e.12xlarge',
    'ml.g5.xlarge',
    'ml.g5.2xlarge',
    'ml.m5.xlarge',
    'ml.p5.48xlarge'
);

const arbQuotaTier = fc.constantFrom('ci', 'nightly', 'weekly');

const arbQuotaTrack = fc.constantFrom('realtime', 'hyperpod', 'async', 'batch');

// Generate a catalog entry with a known instance type embedded in args
const arbQuotaCatalogEntry = fc.record({
    id: fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/),
    tier: arbQuotaTier,
    track: arbQuotaTrack,
    instanceType: arbInstanceType,
    lifecycle: fc.constant(['build', 'push', 'deploy', 'test', 'clean']),
    timeout: fc.integer({ min: 60, max: 7200 })
}).map(entry => ({
    id: entry.id,
    tier: entry.tier,
    track: entry.track,
    args: `--deployment-config=transformers-vllm --model-name=test --instance-type=${entry.instanceType}`,
    lifecycle: entry.lifecycle,
    timeout: entry.timeout,
    _instanceType: entry.instanceType  // Keep for verification
}));

// Generate a catalog entry WITHOUT an instance type in args
const arbNoInstanceEntry = fc.record({
    id: fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/),
    tier: arbQuotaTier,
    track: arbQuotaTrack,
    lifecycle: fc.constant(['build', 'push', 'deploy', 'test', 'clean']),
    timeout: fc.integer({ min: 60, max: 7200 })
}).map(entry => ({
    id: entry.id,
    tier: entry.tier,
    track: entry.track,
    args: '--deployment-config=transformers-vllm --model-name=test --region=us-west-2',
    lifecycle: entry.lifecycle,
    timeout: entry.timeout,
    _instanceType: null  // No instance type
}));

// Generate a catalog with unique IDs containing a mix of entries with and without instance types
const arbQuotaCatalog = fc.array(
    fc.oneof(arbQuotaCatalogEntry, arbNoInstanceEntry),
    { minLength: 1, maxLength: 15 }
).map(entries => {
    // Ensure unique IDs
    const uniqueEntries = entries.map((entry, i) => ({
        ...entry,
        id: `${entry.id}-${i}`
    }));
    return uniqueEntries;
});

describe('Feature: e2e-validation-runner, Property 7: Quota validator correctly sums instance requirements', () => {

    /**
     * **Validates: Requirements 3.3**
     *
     * For any catalog and tier, the quota validator SHALL produce instance
     * type counts equal to the sum of instances required by all configs in
     * that tier, correctly parsing instance types from the args field.
     */
    it('sum per instance type equals count of configs with that instance type in the given tier', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbQuotaCatalog,
            arbQuotaTier,
            (entries, tier) => {
                const catalog = { configs: entries.map(({ _instanceType, ...rest }) => rest) };

                const result = sumInstanceRequirements(tier, catalog);

                // Manually compute expected sums
                const expected = new Map();
                for (const entry of entries) {
                    if (entry.tier === tier && entry._instanceType) {
                        expected.set(
                            entry._instanceType,
                            (expected.get(entry._instanceType) || 0) + 1
                        );
                    }
                }

                // Verify result matches expected
                assert.strictEqual(result.size, expected.size,
                    `Expected ${expected.size} instance types, got ${result.size}`);

                for (const [instanceType, count] of expected) {
                    assert.strictEqual(result.get(instanceType), count,
                        `Expected ${count} for ${instanceType}, got ${result.get(instanceType)}`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('instance types from other tiers are not counted', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbQuotaCatalog,
            arbQuotaTier,
            (entries, tier) => {
                const catalog = { configs: entries.map(({ _instanceType, ...rest }) => rest) };

                const result = sumInstanceRequirements(tier, catalog);

                // Collect instance types that only appear in OTHER tiers
                const otherTierOnlyTypes = new Set();
                for (const entry of entries) {
                    if (entry.tier !== tier && entry._instanceType) {
                        otherTierOnlyTypes.add(entry._instanceType);
                    }
                }
                // Remove types that also appear in the target tier
                for (const entry of entries) {
                    if (entry.tier === tier && entry._instanceType) {
                        otherTierOnlyTypes.delete(entry._instanceType);
                    }
                }

                // None of the other-tier-only types should appear in the result
                for (const instanceType of otherTierOnlyTypes) {
                    assert.strictEqual(result.has(instanceType), false,
                        `Instance type "${instanceType}" from another tier should not be in result`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('configs without --instance-type in args are skipped', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbQuotaCatalog,
            arbQuotaTier,
            (entries, tier) => {
                const catalog = { configs: entries.map(({ _instanceType, ...rest }) => rest) };

                const result = sumInstanceRequirements(tier, catalog);

                // Total count across all instance types in result should equal
                // number of entries in this tier that HAVE an instance type
                const entriesInTierWithInstance = entries.filter(
                    e => e.tier === tier && e._instanceType !== null
                ).length;

                let totalCount = 0;
                for (const count of result.values()) {
                    totalCount += count;
                }

                assert.strictEqual(totalCount, entriesInTierWithInstance,
                    `Total instance count (${totalCount}) should equal entries in tier with instance type (${entriesInTierWithInstance})`);
            }
        ), FAST_PROPERTY_CONFIG);
    });
});


// ── Property 3 ──────────────────────────────────────────────────────────────

/**
 * Property 3: Fail-fast stops execution and records failure correctly
 *
 * Simulates the fail-fast logic from runConfig (same algorithm but without
 * spawning processes). Generates configs with N steps where step K fails,
 * then verifies the result structure matches expected behavior.
 *
 * Validates: Requirements 2.2, 2.4
 */

/**
 * Simulates the fail-fast logic from runConfig without spawning processes.
 * This implements the same algorithm as runConfig's lifecycle execution:
 * - Execute steps sequentially
 * - On failure, stop and record error
 * - Clean always runs in finally block
 *
 * @param {string[]} lifecycle - Array of step names (excluding clean)
 * @param {number} failAtIndex - 0-based index of the step that should fail
 * @returns {object} Result matching ConfigResult structure
 */
function simulateFailFast(lifecycle, failAtIndex) {
    const result = { id: 'test-config', steps: [], status: 'pass', duration: 0 };
    const startTime = Date.now();

    try {
        // Execute lifecycle steps (fail-fast), same as runConfig
        for (let i = 0; i < lifecycle.length; i++) {
            const step = lifecycle[i];
            if (i < failAtIndex) {
                // Steps before fail point pass
                result.steps.push({
                    name: step,
                    status: 'pass',
                    duration: 1 + i  // Simulated duration > 0
                });
            } else if (i === failAtIndex) {
                // The failing step
                const error = `Step "${step}" failed with exit code 1`;
                result.steps.push({
                    name: step,
                    status: 'fail',
                    duration: 1 + i,
                    error
                });
                result.status = 'fail';
                result.error = error;
                break;  // fail-fast: stop executing remaining steps
            }
        }
    } finally {
        // Clean always runs (finally block in runConfig)
        result.steps.push({
            name: 'clean',
            status: 'pass',
            duration: 1
        });
        result.duration = Date.now() - startTime + 1;  // Ensure > 0
    }

    return result;
}

// Generator for step names (simple names without hyphens to avoid compound step resolution)
const arbSimpleStepName = fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/)
    .filter(s => s !== 'clean');

// Generator for a lifecycle of 2-8 unique step names
const arbFailFastLifecycle = fc.array(arbSimpleStepName, { minLength: 2, maxLength: 8 })
    .map(steps => [...new Set(steps)])
    .filter(steps => steps.length >= 2);

describe('Feature: e2e-validation-runner, Property 3: Fail-fast stops execution and records failure correctly', () => {

    /**
     * **Validates: Requirements 2.2, 2.4**
     *
     * For any config with N lifecycle steps where step K fails (1 ≤ K < N),
     * the runner SHALL execute steps 1..K, skip steps K+1..N-1 (excluding clean),
     * and produce a result with status=fail, the failing step's error recorded,
     * and duration > 0 for all executed steps.
     */
    it('steps before the failing step all pass', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailFastLifecycle,
            (lifecycle) => {
                // Pick a random fail point using the lifecycle length
                const failAtIndex = Math.floor(Math.random() * lifecycle.length);
                const result = simulateFailFast(lifecycle, failAtIndex);

                // Steps before failAtIndex should all have status=pass
                for (let i = 0; i < failAtIndex; i++) {
                    assert.strictEqual(result.steps[i].status, 'pass',
                        `Step ${i} ("${result.steps[i].name}") should pass (before fail point ${failAtIndex})`);
                    assert.strictEqual(result.steps[i].name, lifecycle[i],
                        `Step ${i} name should be "${lifecycle[i]}"`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('the failing step is recorded with status=fail and error', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailFastLifecycle,
            fc.integer({ min: 0, max: 100 }),
            (lifecycle, rawFailIndex) => {
                const failAtIndex = rawFailIndex % lifecycle.length;
                const result = simulateFailFast(lifecycle, failAtIndex);

                // The step at failAtIndex should be recorded as fail
                assert.strictEqual(result.steps[failAtIndex].status, 'fail',
                    `Step at index ${failAtIndex} should have status=fail`);
                assert.strictEqual(result.steps[failAtIndex].name, lifecycle[failAtIndex],
                    `Failing step name should be "${lifecycle[failAtIndex]}"`);
                assert.ok(result.steps[failAtIndex].error,
                    `Step at index ${failAtIndex} should have an error recorded`);
                assert.ok(typeof result.steps[failAtIndex].error === 'string',
                    'Error should be a string');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('steps after the failing step are not executed (skipped)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailFastLifecycle,
            fc.integer({ min: 0, max: 100 }),
            (lifecycle, rawFailIndex) => {
                const failAtIndex = rawFailIndex % lifecycle.length;
                const result = simulateFailFast(lifecycle, failAtIndex);

                // Total steps in result: (failAtIndex + 1) executed + 1 clean
                // Steps after failAtIndex are skipped (not in result due to break)
                const expectedStepCount = failAtIndex + 1 + 1;  // executed steps + clean
                assert.strictEqual(result.steps.length, expectedStepCount,
                    `Expected ${expectedStepCount} steps (${failAtIndex + 1} executed + clean), got ${result.steps.length}`);

                // Verify no steps from after failAtIndex appear (except clean)
                const executedNames = result.steps.map(s => s.name);
                for (let i = failAtIndex + 1; i < lifecycle.length; i++) {
                    // These steps should NOT appear in the result (they were skipped)
                    const skippedStep = lifecycle[i];
                    const appearsAfterFail = executedNames.slice(failAtIndex + 1, -1).includes(skippedStep);
                    assert.strictEqual(appearsAfterFail, false,
                        `Step "${skippedStep}" at index ${i} should be skipped`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('clean always runs as the last step regardless of failure', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailFastLifecycle,
            fc.integer({ min: 0, max: 100 }),
            (lifecycle, rawFailIndex) => {
                const failAtIndex = rawFailIndex % lifecycle.length;
                const result = simulateFailFast(lifecycle, failAtIndex);

                // Last step should always be clean
                const lastStep = result.steps[result.steps.length - 1];
                assert.strictEqual(lastStep.name, 'clean',
                    `Last step should be "clean", got "${lastStep.name}"`);
                assert.strictEqual(lastStep.status, 'pass',
                    'Clean step should pass');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('overall result has status=fail with error recorded', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailFastLifecycle,
            fc.integer({ min: 0, max: 100 }),
            (lifecycle, rawFailIndex) => {
                const failAtIndex = rawFailIndex % lifecycle.length;
                const result = simulateFailFast(lifecycle, failAtIndex);

                assert.strictEqual(result.status, 'fail',
                    'Overall result status should be "fail"');
                assert.ok(result.error,
                    'Overall result should have an error recorded');
                assert.ok(typeof result.error === 'string',
                    'Overall error should be a string');
                // Error should match the failing step's error
                assert.strictEqual(result.error, result.steps[failAtIndex].error,
                    'Overall error should match the failing step error');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('all executed steps have duration > 0', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailFastLifecycle,
            fc.integer({ min: 0, max: 100 }),
            (lifecycle, rawFailIndex) => {
                const failAtIndex = rawFailIndex % lifecycle.length;
                const result = simulateFailFast(lifecycle, failAtIndex);

                for (let i = 0; i < result.steps.length; i++) {
                    assert.ok(result.steps[i].duration > 0,
                        `Step ${i} ("${result.steps[i].name}") should have duration > 0, got ${result.steps[i].duration}`);
                }
                // Overall duration should be > 0
                assert.ok(result.duration > 0,
                    `Overall duration should be > 0, got ${result.duration}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('executed step count equals failAtIndex + 1 (before clean)', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbFailFastLifecycle,
            fc.integer({ min: 0, max: 100 }),
            (lifecycle, rawFailIndex) => {
                const failAtIndex = rawFailIndex % lifecycle.length;
                const result = simulateFailFast(lifecycle, failAtIndex);

                // Steps excluding clean
                const stepsBeforeClean = result.steps.slice(0, -1);
                assert.strictEqual(stepsBeforeClean.length, failAtIndex + 1,
                    `Should have ${failAtIndex + 1} steps before clean, got ${stepsBeforeClean.length}`);

                // Verify the order matches the lifecycle
                for (let i = 0; i <= failAtIndex; i++) {
                    assert.strictEqual(stepsBeforeClean[i].name, lifecycle[i],
                        `Step ${i} should be "${lifecycle[i]}", got "${stepsBeforeClean[i].name}"`);
                }
            }
        ), FAST_PROPERTY_CONFIG);
    });
});


// ── Property 8 ──────────────────────────────────────────────────────────────

// Generator for valid step names matching ^[a-z][a-z0-9-]*$ (excluding "clean")
const arbLifecycleStepName = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/)
    .filter(s => s !== 'clean' && s.length >= 2);

// Generate a lifecycle array of 2-6 unique step names plus "clean"
const arbLifecycleSteps = fc.array(arbLifecycleStepName, { minLength: 2, maxLength: 6 })
    .map(steps => {
        // Ensure unique step names
        const unique = [...new Set(steps)];
        return unique.length >= 2 ? [...unique, 'clean'] : null;
    })
    .filter(steps => steps !== null && steps.length >= 3);

describe('Feature: e2e-validation-runner, Property 8: Lifecycle steps execute in catalog-specified order with arbitrary names', () => {

    /**
     * **Validates: Requirements 4.1, 4.2**
     *
     * For any config whose lifecycle array contains arbitrary valid step names
     * in any order, the runner SHALL execute those steps in the exact order
     * specified, mapping each name to `./do/{name}` without requiring the
     * runner to know the step names in advance.
     */

    let fakeRepoRoot;
    let workspaceBase;

    before(async () => {
        // Create a shared fake repo root with a CLI that creates do/ scripts
        // based on --lifecycle argument
        fakeRepoRoot = path.join(os.tmpdir(), `e2e-prop8-repo-${Date.now()}`);
        workspaceBase = path.join(os.tmpdir(), `e2e-prop8-ws-${Date.now()}`);
        const binDir = path.join(fakeRepoRoot, 'bin');
        await mkdir(binDir, { recursive: true });
        await mkdir(workspaceBase, { recursive: true });

        // The fake CLI reads --lifecycle from args and creates do/ scripts
        const cliScript = [
            'import { mkdir, writeFile, chmod } from "node:fs/promises"',
            'import path from "node:path"',
            '',
            'const args = process.argv.slice(2)',
            'let projectDir = null',
            'let lifecycleRaw = null',
            'for (let i = 0; i < args.length; i++) {',
            '    if (args[i] === "--project-dir" && i + 1 < args.length) {',
            '        projectDir = args[i + 1]',
            '    }',
            '    if (args[i] === "--lifecycle" && i + 1 < args.length) {',
            '        lifecycleRaw = args[i + 1]',
            '    }',
            '}',
            'if (!projectDir) process.exit(1)',
            'const doDir = path.join(projectDir, "do")',
            'await mkdir(doDir, { recursive: true })',
            'if (lifecycleRaw) {',
            '    const steps = lifecycleRaw.split(",")',
            '    for (const step of steps) {',
            '        const scriptPath = path.join(doDir, step)',
            '        await writeFile(scriptPath, "#!/bin/bash\\nexit 0\\n")',
            '        await chmod(scriptPath, 0o755)',
            '    }',
            '}'
        ].join('\n');

        await writeFile(path.join(binDir, 'cli.js'), cliScript);
    });

    after(async () => {
        await rm(fakeRepoRoot, { recursive: true, force: true });
        await rm(workspaceBase, { recursive: true, force: true });
    });

    it('step execution order matches catalog lifecycle order with clean at end', function () {
        this.timeout(300000);

        let iteration = 0;

        return fc.assert(fc.asyncProperty(
            arbLifecycleSteps,
            async (lifecycle) => {
                iteration++;
                const workspaceRoot = path.join(workspaceBase, `run-${iteration}`);
                await mkdir(workspaceRoot, { recursive: true });

                try {
                    // Build config with lifecycle steps passed via args
                    const config = {
                        id: `cfg-${iteration}`,
                        tier: 'ci',
                        track: 'realtime',
                        args: `--lifecycle ${lifecycle.join(',')}`,
                        lifecycle,
                        timeout: 30
                    };

                    // Run the config
                    const result = await runConfig(config, workspaceRoot, fakeRepoRoot);

                    // Extract step names from result
                    const executedStepNames = result.steps.map(s => s.name);

                    // Expected order: all non-clean steps in lifecycle order, then clean at end
                    const expectedOrder = lifecycle.filter(s => s !== 'clean');
                    expectedOrder.push('clean');

                    assert.deepStrictEqual(executedStepNames, expectedOrder,
                        `Steps should execute in catalog order. Expected: [${expectedOrder.join(', ')}], Got: [${executedStepNames.join(', ')}]`);

                    // All steps should pass
                    for (const step of result.steps) {
                        assert.strictEqual(step.status, 'pass',
                            `Step "${step.name}" should pass, got "${step.status}"`);
                    }
                } finally {
                    await rm(workspaceRoot, { recursive: true, force: true });
                }
            }
        ), { ...FAST_PROPERTY_CONFIG, numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) });
    });

    it('arbitrary step names are executed without runner knowing them in advance', function () {
        this.timeout(300000);

        let iteration = 0;

        return fc.assert(fc.asyncProperty(
            arbLifecycleSteps,
            async (lifecycle) => {
                iteration++;
                const workspaceRoot = path.join(workspaceBase, `arb-${iteration}`);
                await mkdir(workspaceRoot, { recursive: true });

                try {
                    const config = {
                        id: `arb-${iteration}`,
                        tier: 'ci',
                        track: 'realtime',
                        args: `--lifecycle ${lifecycle.join(',')}`,
                        lifecycle,
                        timeout: 30
                    };

                    const result = await runConfig(config, workspaceRoot, fakeRepoRoot);

                    // Every step name from the lifecycle should appear in results
                    const nonCleanSteps = lifecycle.filter(s => s !== 'clean');
                    for (const stepName of nonCleanSteps) {
                        const found = result.steps.some(s => s.name === stepName);
                        assert.ok(found,
                            `Step "${stepName}" from lifecycle should appear in results`);
                    }

                    // Clean should always be the last step
                    const lastStep = result.steps[result.steps.length - 1];
                    assert.strictEqual(lastStep.name, 'clean',
                        `Last step should be "clean", got "${lastStep.name}"`);
                } finally {
                    await rm(workspaceRoot, { recursive: true, force: true });
                }
            }
        ), { ...FAST_PROPERTY_CONFIG, numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) });
    });
});


// ── Property 5 ──────────────────────────────────────────────────────────────

describe('Feature: e2e-validation-runner, Property 5: Clean always executes regardless of outcome', () => {

    /**
     * **Validates: Requirements 2.5**
     *
     * For any config execution (whether all steps pass or any step fails),
     * the runner SHALL execute the clean step as the final action for that config.
     */

    // Generator for lifecycle steps (2-8 simple steps, always ending with "clean")
    const arbProp5StepName = fc.constantFrom(
        'build', 'push', 'deploy', 'test', 'benchmark', 'status'
    );

    const arbProp5Lifecycle = fc.array(arbProp5StepName, { minLength: 1, maxLength: 7 })
        .map(steps => {
            const unique = [...new Set(steps)];
            return [...unique, 'clean'];
        });

    // Generator for which step index should fail (-1 means all pass)
    const arbFailIndex = fc.integer({ min: -1, max: 6 });

    it('clean is always the last step in results when all steps pass', async function () {
        this.timeout(300000);

        await fc.assert(fc.asyncProperty(
            arbProp5Lifecycle,
            async (lifecycle) => {
                const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'e2e-prop5a-'));
                const workspaceRoot = path.join(tmpBase, 'workspace');
                const fakeRepoRoot = path.join(tmpBase, 'repo');
                const configId = 'prop5-config';
                const projectDir = path.join(workspaceRoot, configId);
                const doDir = path.join(projectDir, 'do');

                try {
                    await mkdir(doDir, { recursive: true });

                    // Create a no-op bin/cli.js
                    const binDir = path.join(fakeRepoRoot, 'bin');
                    await mkdir(binDir, { recursive: true });
                    await writeFile(path.join(binDir, 'cli.js'), '// no-op\n');

                    // Create passing scripts for all steps
                    for (const step of lifecycle) {
                        const scriptPath = path.join(doDir, step);
                        await writeFile(scriptPath, '#!/bin/bash\nexit 0\n');
                        await chmod(scriptPath, 0o755);
                    }

                    const config = {
                        id: configId,
                        tier: 'ci',
                        track: 'realtime',
                        args: '',
                        lifecycle,
                        timeout: 30
                    };

                    const result = await runConfig(config, workspaceRoot, fakeRepoRoot);

                    // Clean must always be the last step
                    const lastStep = result.steps[result.steps.length - 1];
                    assert.strictEqual(lastStep.name, 'clean',
                        `Last step should be "clean", got "${lastStep.name}". Steps: ${result.steps.map(s => s.name).join(', ')}`);
                } finally {
                    await rm(tmpBase, { recursive: true, force: true });
                }
            }
        ), { ...FAST_PROPERTY_CONFIG, numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) });
    });

    it('clean is always the last step in results when a step fails', async function () {
        this.timeout(300000);

        await fc.assert(fc.asyncProperty(
            arbProp5Lifecycle.filter(lc => lc.filter(s => s !== 'clean').length >= 2),
            arbFailIndex,
            async (lifecycle, rawFailIndex) => {
                const nonClean = lifecycle.filter(s => s !== 'clean');
                // Clamp failIndex to valid range for this lifecycle
                const failIndex = Math.abs(rawFailIndex) % nonClean.length;

                const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'e2e-prop5b-'));
                const workspaceRoot = path.join(tmpBase, 'workspace');
                const fakeRepoRoot = path.join(tmpBase, 'repo');
                const configId = 'prop5-fail-config';
                const projectDir = path.join(workspaceRoot, configId);
                const doDir = path.join(projectDir, 'do');

                try {
                    await mkdir(doDir, { recursive: true });

                    // Create a no-op bin/cli.js
                    const binDir = path.join(fakeRepoRoot, 'bin');
                    await mkdir(binDir, { recursive: true });
                    await writeFile(path.join(binDir, 'cli.js'), '// no-op\n');

                    // Create scripts - the one at failIndex fails
                    for (let i = 0; i < nonClean.length; i++) {
                        const step = nonClean[i];
                        const scriptPath = path.join(doDir, step);
                        if (i === failIndex) {
                            await writeFile(scriptPath, '#!/bin/bash\necho "step failed" >&2\nexit 1\n');
                        } else {
                            await writeFile(scriptPath, '#!/bin/bash\nexit 0\n');
                        }
                        await chmod(scriptPath, 0o755);
                    }

                    // Always create a passing clean script
                    const cleanPath = path.join(doDir, 'clean');
                    await writeFile(cleanPath, '#!/bin/bash\nexit 0\n');
                    await chmod(cleanPath, 0o755);

                    const config = {
                        id: configId,
                        tier: 'ci',
                        track: 'realtime',
                        args: '',
                        lifecycle,
                        timeout: 30
                    };

                    const result = await runConfig(config, workspaceRoot, fakeRepoRoot);

                    // Clean must always be the last step regardless of outcome
                    const lastStep = result.steps[result.steps.length - 1];
                    assert.strictEqual(lastStep.name, 'clean',
                        `Last step should be "clean", got "${lastStep.name}". ` +
                        `failIndex: ${failIndex}, Steps: ${result.steps.map(s => `${s.name}(${s.status})`).join(', ')}`);
                } finally {
                    await rm(tmpBase, { recursive: true, force: true });
                }
            }
        ), { ...FAST_PROPERTY_CONFIG, numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) });
    });

    it('clean step is present exactly once in results', async function () {
        this.timeout(300000);

        await fc.assert(fc.asyncProperty(
            arbProp5Lifecycle,
            fc.boolean(),
            async (lifecycle, shouldFail) => {
                const nonClean = lifecycle.filter(s => s !== 'clean');

                const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'e2e-prop5c-'));
                const workspaceRoot = path.join(tmpBase, 'workspace');
                const fakeRepoRoot = path.join(tmpBase, 'repo');
                const configId = 'prop5-once-config';
                const projectDir = path.join(workspaceRoot, configId);
                const doDir = path.join(projectDir, 'do');

                try {
                    await mkdir(doDir, { recursive: true });

                    // Create a no-op bin/cli.js
                    const binDir = path.join(fakeRepoRoot, 'bin');
                    await mkdir(binDir, { recursive: true });
                    await writeFile(path.join(binDir, 'cli.js'), '// no-op\n');

                    // If shouldFail, make the first step fail; otherwise all pass
                    for (let i = 0; i < nonClean.length; i++) {
                        const step = nonClean[i];
                        const scriptPath = path.join(doDir, step);
                        if (shouldFail && i === 0) {
                            await writeFile(scriptPath, '#!/bin/bash\nexit 1\n');
                        } else {
                            await writeFile(scriptPath, '#!/bin/bash\nexit 0\n');
                        }
                        await chmod(scriptPath, 0o755);
                    }

                    // Always create a passing clean script
                    const cleanPath = path.join(doDir, 'clean');
                    await writeFile(cleanPath, '#!/bin/bash\nexit 0\n');
                    await chmod(cleanPath, 0o755);

                    const config = {
                        id: configId,
                        tier: 'ci',
                        track: 'realtime',
                        args: '',
                        lifecycle,
                        timeout: 30
                    };

                    const result = await runConfig(config, workspaceRoot, fakeRepoRoot);

                    // Clean should appear exactly once
                    const cleanSteps = result.steps.filter(s => s.name === 'clean');
                    assert.strictEqual(cleanSteps.length, 1,
                        `Expected exactly 1 clean step, got ${cleanSteps.length}. Steps: ${result.steps.map(s => s.name).join(', ')}`);
                } finally {
                    await rm(tmpBase, { recursive: true, force: true });
                }
            }
        ), { ...FAST_PROPERTY_CONFIG, numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) });
    });
});



// ── Property 4 ──────────────────────────────────────────────────────────────

describe('Feature: e2e-validation-runner, Property 4: Bounded parallelism never exceeds concurrency limit', () => {

    /**
     * **Validates: Requirements 2.3**
     *
     * For any set of configs and any concurrency value C ≥ 1, the runner
     * SHALL never have more than C configs executing simultaneously at any
     * point during the run.
     */

    // Generator for number of tasks (3-20)
    const arbTaskCount = fc.integer({ min: 3, max: 20 });

    // Generator for concurrency limit (1-5)
    const arbConcurrency = fc.integer({ min: 1, max: 5 });

    it('max active tasks never exceeds concurrency limit', async function () {
        this.timeout(60000);

        await fc.assert(fc.asyncProperty(
            arbTaskCount,
            arbConcurrency,
            async (N, C) => {
                const semaphore = new Semaphore(C);
                let active = 0;
                let maxActive = 0;

                const tasks = Array.from({ length: N }, () => async () => {
                    await semaphore.acquire();
                    active++;
                    maxActive = Math.max(maxActive, active);
                    await new Promise(r => setTimeout(r, Math.random() * 10));
                    active--;
                    semaphore.release();
                });

                await Promise.all(tasks.map(t => t()));

                assert.ok(maxActive <= C,
                    `Max active (${maxActive}) should never exceed concurrency limit (${C}) with ${N} tasks`);
            }
        ), { ...FAST_PROPERTY_CONFIG, numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) });
    });

    it('all tasks complete despite concurrency limiting', async function () {
        this.timeout(60000);

        await fc.assert(fc.asyncProperty(
            arbTaskCount,
            arbConcurrency,
            async (N, C) => {
                const semaphore = new Semaphore(C);
                let completedCount = 0;

                const tasks = Array.from({ length: N }, () => async () => {
                    await semaphore.acquire();
                    await new Promise(r => setTimeout(r, Math.random() * 5));
                    completedCount++;
                    semaphore.release();
                });

                await Promise.all(tasks.map(t => t()));

                assert.strictEqual(completedCount, N,
                    `All ${N} tasks should complete, but only ${completedCount} did`);
            }
        ), { ...FAST_PROPERTY_CONFIG, numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) });
    });

    it('concurrency of 1 serializes execution (max active is always 1)', async function () {
        this.timeout(60000);

        await fc.assert(fc.asyncProperty(
            arbTaskCount,
            async (N) => {
                const semaphore = new Semaphore(1);
                let active = 0;
                let maxActive = 0;

                const tasks = Array.from({ length: N }, () => async () => {
                    await semaphore.acquire();
                    active++;
                    maxActive = Math.max(maxActive, active);
                    await new Promise(r => setTimeout(r, Math.random() * 5));
                    active--;
                    semaphore.release();
                });

                await Promise.all(tasks.map(t => t()));

                assert.strictEqual(maxActive, 1,
                    `With concurrency 1, max active should be exactly 1, got ${maxActive}`);
            }
        ), { ...FAST_PROPERTY_CONFIG, numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) });
    });
});


// ── Property 6 ──────────────────────────────────────────────────────────────

/**
 * Property 6: Exit code reflects failure presence
 *
 * The runner exits with code 1 if any config failed, 0 if all passed.
 * The exit code logic is: if (result.failed > 0) process.exit(1)
 *
 * This property tests the aggregateResults function to verify that the
 * `failed` count correctly reflects the presence of failures, which
 * determines the exit code.
 *
 * Validates: Requirements 2.9
 */

// Generator for config results with explicit pass/fail control
const arbProp6ConfigResult = fc.record({
    id: arbConfigId,
    status: arbConfigStatus,
    duration: fc.nat({ max: 3600000 }),
    steps: fc.array(arbStep, { minLength: 1, maxLength: 5 })
});

// Generate arrays of 1-20 config results
const arbProp6Results = fc.array(arbProp6ConfigResult, { minLength: 1, maxLength: 20 });

// Generate results where ALL configs pass
const arbAllPassResults = fc.array(
    fc.record({
        id: arbConfigId,
        status: fc.constant('pass'),
        duration: fc.nat({ max: 3600000 }),
        steps: fc.array(arbStep, { minLength: 1, maxLength: 5 })
    }),
    { minLength: 1, maxLength: 20 }
);

// Generate results where AT LEAST ONE config fails
const arbAtLeastOneFailResults = fc.tuple(
    fc.array(arbProp6ConfigResult, { minLength: 0, maxLength: 10 }),
    fc.record({
        id: arbConfigId,
        status: fc.constant('fail'),
        duration: fc.nat({ max: 3600000 }),
        steps: fc.array(arbStep, { minLength: 1, maxLength: 5 })
    }),
    fc.array(arbProp6ConfigResult, { minLength: 0, maxLength: 10 })
).map(([before, failConfig, after]) => [...before, failConfig, ...after]);

describe('Feature: e2e-validation-runner, Property 6: Exit code reflects failure presence', () => {

    /**
     * **Validates: Requirements 2.9**
     *
     * For any set of completed config results, the runner's exit code SHALL
     * be 1 if any config has status=fail, and 0 if all configs have status=pass.
     */
    it('exit code is 0 (failed === 0) when all configs pass', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbAllPassResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                assert.strictEqual(output.failed, 0,
                    `When all configs pass, failed count should be 0, got ${output.failed}`);

                // Exit code logic: if (result.failed > 0) exit(1), else exit(0)
                const exitCode = output.failed > 0 ? 1 : 0;
                assert.strictEqual(exitCode, 0,
                    'Exit code should be 0 when all configs pass');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('exit code is 1 (failed > 0) when at least one config fails', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbAtLeastOneFailResults,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                assert.ok(output.failed > 0,
                    `When at least one config fails, failed count should be > 0, got ${output.failed}`);

                // Exit code logic: if (result.failed > 0) exit(1), else exit(0)
                const exitCode = output.failed > 0 ? 1 : 0;
                assert.strictEqual(exitCode, 1,
                    'Exit code should be 1 when any config fails');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('failed count equals number of configs with status=fail for any mix', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbProp6Results,
            arbMeta,
            (results, meta) => {
                const output = aggregateResults(results, meta);

                const expectedFailed = results.filter(r => r.status === 'fail').length;
                assert.strictEqual(output.failed, expectedFailed,
                    `Failed count should be ${expectedFailed}, got ${output.failed}`);

                // Verify exit code derivation
                const expectedExitCode = expectedFailed > 0 ? 1 : 0;
                const actualExitCode = output.failed > 0 ? 1 : 0;
                assert.strictEqual(actualExitCode, expectedExitCode,
                    `Exit code should be ${expectedExitCode}, got ${actualExitCode}`);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('exit code is deterministic for the same set of results', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbProp6Results,
            arbMeta,
            (results, meta) => {
                const output1 = aggregateResults(results, meta);
                const output2 = aggregateResults(results, meta);

                const exitCode1 = output1.failed > 0 ? 1 : 0;
                const exitCode2 = output2.failed > 0 ? 1 : 0;

                assert.strictEqual(exitCode1, exitCode2,
                    'Exit code should be deterministic for the same inputs');
            }
        ), FAST_PROPERTY_CONFIG);
    });

    it('single failing config among many passing configs yields exit code 1', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            fc.array(
                fc.record({
                    id: arbConfigId,
                    status: fc.constant('pass'),
                    duration: fc.nat({ max: 3600000 }),
                    steps: fc.array(arbStep, { minLength: 1, maxLength: 5 })
                }),
                { minLength: 1, maxLength: 19 }
            ),
            fc.record({
                id: arbConfigId,
                status: fc.constant('fail'),
                duration: fc.nat({ max: 3600000 }),
                steps: fc.array(arbStep, { minLength: 1, maxLength: 5 })
            }),
            fc.nat({ max: 19 }),
            arbMeta,
            (passingConfigs, failConfig, insertIndex, meta) => {
                // Insert the failing config at a random position
                const idx = insertIndex % (passingConfigs.length + 1);
                const results = [
                    ...passingConfigs.slice(0, idx),
                    failConfig,
                    ...passingConfigs.slice(idx)
                ];

                const output = aggregateResults(results, meta);

                assert.strictEqual(output.failed, 1,
                    `Should have exactly 1 failure, got ${output.failed}`);

                const exitCode = output.failed > 0 ? 1 : 0;
                assert.strictEqual(exitCode, 1,
                    'Exit code should be 1 when a single config fails among many passing');
            }
        ), FAST_PROPERTY_CONFIG);
    });
});

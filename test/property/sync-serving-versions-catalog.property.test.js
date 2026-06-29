// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Serving Versions — Catalog Update Logic Property-Based Tests
 *
 * Verifies correctness of catalog update operations: nearest entry selection,
 * new entry construction, deep merge, and catalog pruning.
 *
 * Feature: sync-serving-versions
 * Property 3: Nearest entry minimizes semver distance
 * Property 4: New entry inherits all curated fields
 * Property 5: Deep merge preserves curated fields and updates registry fields
 * Property 6: Catalog pruning retains exactly target versions
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import {
    findNearestEntry,
    buildNewEntry,
    deepMergeEntry,
    updateServerEntries,
    semverDistance,
    parseSemver,
    SERVER_SOURCES
} from '../../scripts/sync-serving-versions.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a parsed semver object { major, minor, patch }.
 */
const arbParsedSemver = fc.record({
    major: fc.nat({ max: 99 }),
    minor: fc.nat({ max: 99 }),
    patch: fc.nat({ max: 99 })
});

/**
 * Generate a semver version string without 'v' prefix (as stored in labels.framework_version).
 */
const arbVersionString = arbParsedSemver.map(
    ({ major, minor, patch }) => `${major}.${minor}.${patch}`
);

/**
 * Generate a semver tag string with optional 'v' prefix (as discovered from registries).
 */
const arbTagName = fc.tuple(
    fc.boolean(),
    arbParsedSemver
).map(([hasV, { major, minor, patch }]) =>
    `${hasV ? 'v' : ''}${major}.${minor}.${patch}`
);

/**
 * Generate a realistic curated defaults object.
 * Uses tuple+map to produce standard JS objects (avoids null-prototype from fc.record).
 */
const arbDefaults = fc.tuple(
    fc.constantFrom('ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p4d.24xlarge', 'ml.g6.xlarge'),
    fc.nat({ max: 131072 }),
    fc.double({ min: 0.5, max: 0.99, noNaN: true })
).map(([instanceType, maxModelLen, gpuMemoryUtilization]) => ({
    instanceType,
    maxModelLen,
    gpuMemoryUtilization
}));

/**
 * Generate a realistic curated profiles object.
 * Uses a plain object for envVars to avoid null-prototype comparison issues.
 */
const arbProfiles = fc.tuple(
    fc.constantFrom('ml.g5.xlarge', 'ml.g5.2xlarge'),
    fc.array(
        fc.tuple(
            fc.stringMatching(/^[A-Z_]{3,15}$/),
            fc.stringMatching(/^[a-z0-9]{1,10}$/)
        ),
        { minLength: 0, maxLength: 3 }
    )
).map(([instanceType, kvPairs]) => {
    const envVars = {};
    for (const [k, v] of kvPairs) {
        envVars[k] = v;
    }
    return { default: { instanceType, envVars } };
});

/**
 * Generate a realistic accelerator object.
 * Uses tuple+map to produce standard JS objects (avoids null-prototype from fc.record).
 */
const arbAccelerator = fc.tuple(
    fc.constantFrom('gpu', 'neuron', 'inferentia'),
    fc.integer({ min: 1, max: 8 })
).map(([type, count]) => ({ type, count }));

/**
 * Generate a realistic catalog entry with curated fields.
 */
const arbCatalogEntry = fc.tuple(
    arbVersionString,
    fc.option(arbDefaults, { nil: undefined }),
    fc.option(arbProfiles, { nil: undefined }),
    fc.option(arbAccelerator, { nil: undefined }),
    fc.option(fc.stringMatching(/^[A-Za-z ]{5,30}$/), { nil: undefined }),
    fc.option(fc.constantFrom('validated', 'community', 'experimental'), { nil: undefined })
).map(([version, defaults, profiles, accelerator, notes, validationLevel]) => {
    const entry = {
        image: `vllm/vllm-openai:v${version}`,
        tag: `v${version}`,
        architecture: 'amd64',
        created: '2024-01-15T10:00:00Z',
        labels: { framework_version: version },
        registry: 'dockerhub',
        repository: 'vllm/vllm-openai'
    };
    if (defaults !== undefined) entry.defaults = defaults;
    if (profiles !== undefined) entry.profiles = profiles;
    if (accelerator !== undefined) entry.accelerator = accelerator;
    if (notes !== undefined) entry.notes = notes;
    if (validationLevel !== undefined) entry.validationLevel = validationLevel;
    return entry;
});

/**
 * Generate a non-empty array of catalog entries with unique versions.
 */
const arbCatalogEntries = fc.array(arbCatalogEntry, { minLength: 1, maxLength: 10 })
    .map(entries => {
        // Deduplicate by framework_version
        const seen = new Set();
        return entries.filter(e => {
            const v = e.labels.framework_version;
            if (seen.has(v)) return false;
            seen.add(v);
            return true;
        });
    })
    .filter(entries => entries.length > 0);

/**
 * Generate an ISO 8601 timestamp string for registry metadata.
 */
const arbIsoTimestamp = fc.integer({ min: 1672531200000, max: 1767225600000 })
    .map(ms => new Date(ms).toISOString());

/**
 * Generate a tag object (as returned by registry fetcher + selectTargetVersions).
 */
const arbTag = fc.tuple(arbTagName, arbIsoTimestamp)
    .map(([name, lastUpdated]) => ({
        name,
        lastUpdated,
        parsed: parseSemver(name)
    }));

/**
 * Generate a serverSource configuration.
 */
const arbServerSource = fc.constantFrom(
    SERVER_SOURCES.vllm,
    SERVER_SOURCES.sglang,
    SERVER_SOURCES['tensorrt-llm']
);

/**
 * Generate an array of unique target versions (1 to 3 entries, as selectTargetVersions produces).
 */
const arbTargetVersions = fc.array(arbTag, { minLength: 1, maxLength: 3 })
    .map(tags => {
        // Deduplicate by version string without v prefix
        const seen = new Set();
        return tags.filter(t => {
            const v = t.name.replace(/^v/, '');
            if (seen.has(v)) return false;
            seen.add(v);
            return true;
        });
    })
    .filter(tags => tags.length > 0);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Sync Serving Versions — Catalog Update Property-Based Tests', () => {

    describe('Property 3: Nearest entry minimizes semver distance', () => {

        /**
         * Validates: Requirements 4.1
         */

        it('returns the entry with minimal semver distance to the target', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCatalogEntries,
                arbParsedSemver,
                (entries, targetParsed) => {
                    const result = findNearestEntry(entries, targetParsed);

                    assert.ok(result !== null, 'findNearestEntry should not return null for non-empty entries');

                    // Compute the distance of the result
                    const resultVersion = result.labels?.framework_version;
                    if (!resultVersion) {
                        // If no entry has a framework_version label, the function
                        // falls back to entries[0], which is acceptable
                        return true;
                    }

                    const resultParsed = parseSemver(resultVersion);
                    const resultDist = semverDistance(targetParsed, resultParsed);

                    // Verify no other entry has a strictly smaller distance
                    for (const entry of entries) {
                        const entryVersion = entry.labels?.framework_version;
                        if (!entryVersion) continue;
                        const entryParsed = parseSemver(entryVersion);
                        const entryDist = semverDistance(targetParsed, entryParsed);

                        assert.ok(
                            resultDist <= entryDist,
                            `Found entry with distance ${entryDist} (version ${entryVersion}) ` +
                            `but result has distance ${resultDist} (version ${resultVersion}). ` +
                            `Target: ${targetParsed.major}.${targetParsed.minor}.${targetParsed.patch}`
                        );
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('returns null for empty entries array', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbParsedSemver,
                (targetParsed) => {
                    const result = findNearestEntry([], targetParsed);
                    assert.strictEqual(result, null, 'Should return null for empty entries');
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Property 4: New entry inherits all curated fields', () => {

        /**
         * Validates: Requirements 4.2, 4.3
         */

        it('cloned entry contains identical curated fields plus correct image/tag/labels', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerSource,
                arbTag,
                arbCatalogEntry,
                (serverSource, tag, nearestEntry) => {
                    const result = buildNewEntry(serverSource, tag, nearestEntry);

                    // Verify image, tag, and labels.framework_version
                    const expectedImage = `${serverSource.imagePrefix}:${tag.name}`;
                    const expectedVersion = tag.name.replace(/^v/, '');

                    assert.strictEqual(result.image, expectedImage,
                        `image should be "${expectedImage}" but got "${result.image}"`);
                    assert.strictEqual(result.tag, tag.name,
                        `tag should be "${tag.name}" but got "${result.tag}"`);
                    assert.strictEqual(result.labels.framework_version, expectedVersion,
                        `labels.framework_version should be "${expectedVersion}" but got "${result.labels.framework_version}"`);

                    // Verify curated fields are cloned identically
                    if (nearestEntry.defaults) {
                        assert.deepStrictEqual(result.defaults, nearestEntry.defaults,
                            'defaults should be cloned from nearest entry');
                    }
                    if (nearestEntry.profiles) {
                        assert.deepStrictEqual(result.profiles, nearestEntry.profiles,
                            'profiles should be cloned from nearest entry');
                    }
                    if (nearestEntry.accelerator) {
                        assert.deepStrictEqual(result.accelerator, nearestEntry.accelerator,
                            'accelerator should be cloned from nearest entry');
                    }
                    if (nearestEntry.notes) {
                        assert.strictEqual(result.notes, nearestEntry.notes,
                            'notes should be cloned from nearest entry');
                    }
                    if (nearestEntry.validationLevel) {
                        assert.strictEqual(result.validationLevel, nearestEntry.validationLevel,
                            'validationLevel should be cloned from nearest entry');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('cloned curated fields are deep copies (not references)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbServerSource,
                arbTag,
                arbCatalogEntry.filter(e => e.defaults !== undefined || e.profiles !== undefined),
                (serverSource, tag, nearestEntry) => {
                    const result = buildNewEntry(serverSource, tag, nearestEntry);

                    // Mutating the result should not affect the source
                    if (result.defaults && nearestEntry.defaults) {
                        assert.notStrictEqual(result.defaults, nearestEntry.defaults,
                            'defaults should be a deep copy, not a reference');
                    }
                    if (result.profiles && nearestEntry.profiles) {
                        assert.notStrictEqual(result.profiles, nearestEntry.profiles,
                            'profiles should be a deep copy, not a reference');
                    }
                    if (result.accelerator && nearestEntry.accelerator) {
                        assert.notStrictEqual(result.accelerator, nearestEntry.accelerator,
                            'accelerator should be a deep copy, not a reference');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Property 5: Deep merge preserves curated fields and updates registry fields', () => {

        /**
         * Validates: Requirements 5.1, 5.2
         */

        it('merged entry preserves profiles/defaults/notes/accelerator from original', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCatalogEntry,
                arbTag,
                arbServerSource,
                (existingEntry, tag, serverSource) => {
                    const result = deepMergeEntry(existingEntry, tag, serverSource);

                    // Curated fields must be preserved
                    if (existingEntry.profiles) {
                        assert.deepStrictEqual(result.profiles, existingEntry.profiles,
                            'profiles should be preserved after deep merge');
                    }
                    if (existingEntry.defaults) {
                        assert.deepStrictEqual(result.defaults, existingEntry.defaults,
                            'defaults should be preserved after deep merge');
                    }
                    if (existingEntry.notes) {
                        assert.strictEqual(result.notes, existingEntry.notes,
                            'notes should be preserved after deep merge');
                    }
                    if (existingEntry.accelerator) {
                        assert.deepStrictEqual(result.accelerator, existingEntry.accelerator,
                            'accelerator should be preserved after deep merge');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('merged entry updates image/tag/created/labels.framework_version from registry data', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCatalogEntry,
                arbTag,
                arbServerSource,
                (existingEntry, tag, serverSource) => {
                    const result = deepMergeEntry(existingEntry, tag, serverSource);

                    const expectedImage = `${serverSource.imagePrefix}:${tag.name}`;
                    const expectedVersion = tag.name.replace(/^v/, '');

                    assert.strictEqual(result.image, expectedImage,
                        `image should be updated to "${expectedImage}"`);
                    assert.strictEqual(result.tag, tag.name,
                        `tag should be updated to "${tag.name}"`);
                    assert.strictEqual(result.labels.framework_version, expectedVersion,
                        `labels.framework_version should be updated to "${expectedVersion}"`);

                    // created is updated from tag.lastUpdated (or existing if tag has no lastUpdated)
                    if (tag.lastUpdated) {
                        assert.strictEqual(result.created, tag.lastUpdated,
                            'created should be updated from tag.lastUpdated');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Property 6: Catalog pruning retains exactly target versions', () => {

        /**
         * Validates: Requirements 6.1, 6.2
         */

        it('after update, server array contains exactly one entry per target version', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCatalogEntries,
                arbTargetVersions,
                arbServerSource,
                (existingEntries, targetVersions, serverSource) => {
                    const { entries } = updateServerEntries(
                        'vllm', existingEntries, targetVersions, serverSource
                    );

                    // Result length must equal number of target versions
                    assert.strictEqual(entries.length, targetVersions.length,
                        `Expected ${targetVersions.length} entries but got ${entries.length}`);

                    // Each target version should appear exactly once
                    const targetVersionStrings = targetVersions.map(t => t.name.replace(/^v/, ''));
                    const resultVersions = entries.map(e => e.labels.framework_version);

                    for (const targetV of targetVersionStrings) {
                        const count = resultVersions.filter(v => v === targetV).length;
                        assert.strictEqual(count, 1,
                            `Target version "${targetV}" should appear exactly once but appeared ${count} times`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('no entries remain for versions not in the target set', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCatalogEntries,
                arbTargetVersions,
                arbServerSource,
                (existingEntries, targetVersions, serverSource) => {
                    const { entries } = updateServerEntries(
                        'vllm', existingEntries, targetVersions, serverSource
                    );

                    const targetVersionStrings = new Set(
                        targetVersions.map(t => t.name.replace(/^v/, ''))
                    );

                    // Every entry in the result must correspond to a target version
                    for (const entry of entries) {
                        assert.ok(
                            targetVersionStrings.has(entry.labels.framework_version),
                            `Entry with version "${entry.labels.framework_version}" should not be in result — ` +
                            `only target versions [${[...targetVersionStrings].join(', ')}] are allowed`
                        );
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('result length equals min(3, number of target versions)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbCatalogEntries,
                arbTargetVersions,
                arbServerSource,
                (existingEntries, targetVersions, serverSource) => {
                    const { entries } = updateServerEntries(
                        'vllm', existingEntries, targetVersions, serverSource
                    );

                    const expectedLen = Math.min(3, targetVersions.length);
                    assert.strictEqual(entries.length, expectedLen,
                        `Expected ${expectedLen} entries (min(3, ${targetVersions.length})) but got ${entries.length}`);

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Serving Versions — Semver Utilities Property-Based Tests
 *
 * Verifies correctness of semver validation and version selection logic
 * used by the sync-serving-versions script.
 *
 * Feature: sync-serving-versions
 * Property 1: Semver filter correctness
 * Property 2: Version selection produces sorted top-N
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { isValidSemver, selectTargetVersions } from '../../scripts/sync-serving-versions.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid semver string with optional 'v' prefix.
 * MAJOR, MINOR, PATCH are non-negative integers.
 */
const arbValidSemver = fc.tuple(
    fc.boolean(),                    // whether to include 'v' prefix
    fc.nat({ max: 999 }),            // major
    fc.nat({ max: 999 }),            // minor
    fc.nat({ max: 999 })             // patch
).map(([hasV, major, minor, patch]) =>
    `${hasV ? 'v' : ''}${major}.${minor}.${patch}`
);

/**
 * Generate strings that should NOT be valid semver.
 * Covers: pre-release suffixes, build metadata, non-numeric segments,
 * missing components, leading zeros edge cases, and random noise.
 */
const arbInvalidSemver = fc.oneof(
    // Pre-release suffix (e.g., "1.2.3-beta")
    fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/))
        .map(([maj, min, pat, pre]) => `${maj}.${min}.${pat}-${pre}`),
    // Build metadata (e.g., "1.2.3+build123")
    fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.stringMatching(/^[a-z0-9]{1,8}$/))
        .map(([maj, min, pat, build]) => `${maj}.${min}.${pat}+${build}`),
    // Only two components (e.g., "1.2")
    fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }))
        .map(([a, b]) => `${a}.${b}`),
    // Four components (e.g., "1.2.3.4")
    fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
        .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
    // Non-numeric segment (e.g., "1.abc.3")
    fc.tuple(fc.nat({ max: 99 }), fc.stringMatching(/^[a-z]{2,5}$/), fc.nat({ max: 99 }))
        .map(([a, b, c]) => `${a}.${b}.${c}`),
    // Empty string
    fc.constant(''),
    // Random alphanumeric noise
    fc.stringMatching(/^[a-z0-9]{1,15}$/).filter(s => !/^\d+\.\d+\.\d+$/.test(s) && !/^v\d+\.\d+\.\d+$/.test(s)),
    // Tag-like strings common in registries (e.g., "latest", "nightly-20240101")
    fc.constantFrom('latest', 'nightly', 'dev', 'rc1', 'alpha', 'main', 'sha-abc1234')
);

/**
 * Generate an array of tag objects with valid semver names (for version selection tests).
 */
const arbTagArray = fc.array(
    arbValidSemver.map(name => ({ name, lastUpdated: '2024-01-01T00:00:00Z' })),
    { minLength: 1, maxLength: 30 }
);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Sync Serving Versions — Semver Property-Based Tests', () => {

    describe('Property 1: Semver filter correctness', () => {

        /**
         * Validates: Requirements 1.3, 2.2
         */

        it('returns true for any valid v?MAJOR.MINOR.PATCH string', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbValidSemver,
                (tag) => {
                    const result = isValidSemver(tag);
                    assert.strictEqual(
                        result,
                        true,
                        `isValidSemver("${tag}") should return true for valid semver`
                    );
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('returns false for strings that do not match v?MAJOR.MINOR.PATCH', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbInvalidSemver,
                (tag) => {
                    const result = isValidSemver(tag);
                    assert.strictEqual(
                        result,
                        false,
                        `isValidSemver("${tag}") should return false for invalid semver`
                    );
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('accepts with or without v prefix equivalently', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.nat({ max: 999 }),
                fc.nat({ max: 999 }),
                fc.nat({ max: 999 }),
                (major, minor, patch) => {
                    const withV = `v${major}.${minor}.${patch}`;
                    const withoutV = `${major}.${minor}.${patch}`;

                    assert.strictEqual(isValidSemver(withV), true,
                        `"${withV}" should be valid`);
                    assert.strictEqual(isValidSemver(withoutV), true,
                        `"${withoutV}" should be valid`);

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Property 2: Version selection produces sorted top-N', () => {

        /**
         * Validates: Requirements 3.1, 3.2, 3.3
         */

        it('returns at most 3 elements for any non-empty tag array', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbTagArray,
                (tags) => {
                    const result = selectTargetVersions(tags);
                    assert.ok(
                        result.length <= 3,
                        `Expected at most 3 results but got ${result.length}`
                    );
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('returns elements in strictly descending semver order', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbTagArray,
                (tags) => {
                    const result = selectTargetVersions(tags);

                    for (let i = 0; i < result.length - 1; i++) {
                        const curr = result[i].parsed;
                        const next = result[i + 1].parsed;

                        // curr must be strictly greater than next
                        const currVal = curr.major * 1000000 + curr.minor * 1000 + curr.patch;
                        const nextVal = next.major * 1000000 + next.minor * 1000 + next.patch;

                        assert.ok(
                            currVal > nextVal,
                            `Result[${i}] (${curr.major}.${curr.minor}.${curr.patch}) should be ` +
                            `strictly greater than Result[${i + 1}] (${next.major}.${next.minor}.${next.patch})`
                        );
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('every returned version is >= every non-returned version', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbTagArray,
                (tags) => {
                    const result = selectTargetVersions(tags);

                    if (result.length === 0) return true;

                    // Get the minimum returned version
                    const minReturned = result[result.length - 1].parsed;
                    const minReturnedVal = minReturned.major * 1000000 + minReturned.minor * 1000 + minReturned.patch;

                    // Check that all non-returned valid semver tags are <= minimum returned
                    const returnedNames = new Set(result.map(r => r.name));
                    for (const tag of tags) {
                        if (returnedNames.has(tag.name)) continue;
                        if (!isValidSemver(tag.name)) continue;

                        // Parse the non-returned tag
                        const cleaned = tag.name.replace(/^v/, '');
                        const [major, minor, patch] = cleaned.split('.').map(Number);
                        const tagVal = major * 1000000 + minor * 1000 + patch;

                        assert.ok(
                            tagVal <= minReturnedVal,
                            `Non-returned tag "${tag.name}" (value ${tagVal}) should be <= ` +
                            `minimum returned version (value ${minReturnedVal})`
                        );
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('uses all discovered tags when fewer than 3 valid semver tags exist', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.integer({ min: 1, max: 2 }),
                fc.array(arbValidSemver, { minLength: 1, maxLength: 2 }),
                (count, semvers) => {
                    // Take exactly `count` unique semver tags
                    const uniqueSemvers = [...new Set(semvers)].slice(0, count);
                    const tags = uniqueSemvers.map(name => ({ name, lastUpdated: '2024-01-01T00:00:00Z' }));

                    const result = selectTargetVersions(tags);

                    assert.strictEqual(
                        result.length,
                        uniqueSemvers.length,
                        `With ${uniqueSemvers.length} valid semver tag(s), expected ${uniqueSemvers.length} results but got ${result.length}`
                    );
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('filters out non-semver tags before selecting', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.array(arbValidSemver, { minLength: 1, maxLength: 10 }),
                fc.array(
                    fc.constantFrom('latest', 'nightly', 'dev', 'sha-abc1234', 'rc1', '1.2.3-beta'),
                    { minLength: 0, maxLength: 10 }
                ),
                (validTags, invalidTags) => {
                    const allTags = [
                        ...validTags.map(name => ({ name, lastUpdated: '2024-01-01T00:00:00Z' })),
                        ...invalidTags.map(name => ({ name, lastUpdated: '2024-01-01T00:00:00Z' }))
                    ];

                    const result = selectTargetVersions(allTags);

                    // Every returned tag must be valid semver
                    for (const entry of result) {
                        assert.strictEqual(
                            isValidSemver(entry.name),
                            true,
                            `Returned tag "${entry.name}" should be valid semver`
                        );
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

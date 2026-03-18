// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discover Mode Merge Property-Based Tests
 *
 * Property-based tests verifying that mergeStaticAndDynamic preserves
 * static-first ordering, deduplicates by image field, and sorts net-new
 * dynamic entries by created date descending.
 *
 * Feature: mcp-server-externalization, Property 9: Discover mode merge preserves static-first ordering and deduplicates
 */

<<<<<<< HEAD
import fc from 'fast-check'
import { describe, it } from 'mocha'
import assert from 'assert'
import { mergeStaticAndDynamic } from '../../servers/base-image-picker/index.js'
=======
import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { mergeStaticAndDynamic } from '../../servers/base-image-picker/index.js';
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
<<<<<<< HEAD
}
=======
};
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random image entry with a unique-ish image identifier.
 * Uses a prefix to help control overlap between static and dynamic sets.
 */
const arbImageEntry = (prefix) => fc.record({
    image: fc.string({ minLength: 1, maxLength: 30 }).map(s => `${prefix}/${s.replace(/\//g, '-')}`),
    tag: fc.string({ minLength: 1, maxLength: 10 }),
    architecture: fc.constantFrom('amd64', 'arm64'),
    created: fc.integer({
        min: new Date('2020-01-01T00:00:00Z').getTime(),
        max: new Date('2025-12-31T23:59:59Z').getTime()
    }).map(ts => new Date(ts).toISOString()),
    labels: fc.constant({}),
    registry: fc.constantFrom('dockerhub', 'ecr'),
    repository: fc.string({ minLength: 1, maxLength: 20 })
<<<<<<< HEAD
})
=======
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

/**
 * Generate an array of image entries with unique `image` fields.
 * mergeStaticAndDynamic deduplicates dynamic vs static, but expects
 * each input array to have unique image identifiers internally.
 */
const arbUniqueImages = (prefix) => fc.array(arbImageEntry(prefix), { minLength: 0, maxLength: 10 })
    .map(entries => {
<<<<<<< HEAD
        const seen = new Set()
        return entries.filter(e => {
            if (seen.has(e.image)) return false
            seen.add(e.image)
            return true
        })
    })

const arbStaticImages = arbUniqueImages('static')
const arbDynamicImages = arbUniqueImages('dynamic')
=======
        const seen = new Set();
        return entries.filter(e => {
            if (seen.has(e.image)) return false;
            seen.add(e.image);
            return true;
        });
    });

const arbStaticImages = arbUniqueImages('static');
const arbDynamicImages = arbUniqueImages('dynamic');
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

// ── Property tests ───────────────────────────────────────────────────────────

describe('Discover Mode Merge Property-Based Tests', () => {

    // Feature: mcp-server-externalization, Property 9: Discover mode merge preserves static-first ordering and deduplicates
    describe('Property 9: Discover mode merge preserves static-first ordering and deduplicates', () => {

        /**
         * Validates: Requirements 9.3, 9.4, 9.5
         *
         * (a) Static entries come first in their original order.
         */
        it('static entries appear first in their original order', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbStaticImages,
                arbDynamicImages,
                (staticImages, dynamicImages) => {
<<<<<<< HEAD
                    const merged = mergeStaticAndDynamic(staticImages, dynamicImages)
=======
                    const merged = mergeStaticAndDynamic(staticImages, dynamicImages);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // The first N entries of merged must be the static entries in order
                    for (let i = 0; i < staticImages.length; i++) {
                        assert.strictEqual(
                            merged[i].image,
                            staticImages[i].image,
                            `Static entry at index ${i} should be preserved in order`
<<<<<<< HEAD
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * Validates: Requirements 9.3, 9.4, 9.5
         *
         * (b) No duplicate image identifiers (by `image` field).
         */
        it('merged result contains no duplicate image identifiers', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbStaticImages,
                arbDynamicImages,
                (staticImages, dynamicImages) => {
<<<<<<< HEAD
                    const merged = mergeStaticAndDynamic(staticImages, dynamicImages)

                    const seen = new Set()
=======
                    const merged = mergeStaticAndDynamic(staticImages, dynamicImages);

                    const seen = new Set();
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
                    for (const entry of merged) {
                        assert.ok(
                            !seen.has(entry.image),
                            `Duplicate image identifier found: ${entry.image}`
<<<<<<< HEAD
                        )
                        seen.add(entry.image)
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                        );
                        seen.add(entry.image);
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * Validates: Requirements 9.3, 9.4, 9.5
         *
         * (c) Net-new dynamic entries follow static entries, sorted by
         *     `created` date descending.
         */
        it('net-new dynamic entries follow static entries sorted by created desc', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbStaticImages,
                arbDynamicImages,
                (staticImages, dynamicImages) => {
<<<<<<< HEAD
                    const merged = mergeStaticAndDynamic(staticImages, dynamicImages)

                    // Extract the portion after static entries
                    const dynamicPortion = merged.slice(staticImages.length)

                    // These should all be net-new (not in static set)
                    const staticIds = new Set(staticImages.map(e => e.image))
=======
                    const merged = mergeStaticAndDynamic(staticImages, dynamicImages);

                    // Extract the portion after static entries
                    const dynamicPortion = merged.slice(staticImages.length);

                    // These should all be net-new (not in static set)
                    const staticIds = new Set(staticImages.map(e => e.image));
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
                    for (const entry of dynamicPortion) {
                        assert.ok(
                            !staticIds.has(entry.image),
                            `Dynamic portion should not contain static image: ${entry.image}`
<<<<<<< HEAD
                        )
=======
                        );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)
                    }

                    // Verify sorted by created date descending
                    for (let i = 1; i < dynamicPortion.length; i++) {
<<<<<<< HEAD
                        const prevDate = new Date(dynamicPortion[i - 1].created)
                        const currDate = new Date(dynamicPortion[i].created)
                        assert.ok(
                            prevDate >= currDate,
                            `Dynamic entries not sorted by created desc: ${dynamicPortion[i - 1].created} should be >= ${dynamicPortion[i].created}`
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
=======
                        const prevDate = new Date(dynamicPortion[i - 1].created);
                        const currDate = new Date(dynamicPortion[i].created);
                        assert.ok(
                            prevDate >= currDate,
                            `Dynamic entries not sorted by created desc: ${dynamicPortion[i - 1].created} should be >= ${dynamicPortion[i].created}`
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

        /**
         * Validates: Requirements 9.3, 9.4, 9.5
         *
         * (d) Static entries take precedence on collision — when the same
         *     `image` appears in both static and dynamic, the static entry
         *     is kept and the dynamic one is excluded.
         */
        it('static entries take precedence on collision', function () {
<<<<<<< HEAD
            this.timeout(FAST_PROPERTY_CONFIG.timeout)
=======
            this.timeout(FAST_PROPERTY_CONFIG.timeout);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

            fc.assert(fc.property(
                arbStaticImages.filter(arr => arr.length > 0),
                (staticImages) => {
                    // Create dynamic entries that overlap with static
                    const overlapping = staticImages.map(e => ({
                        ...e,
                        tag: 'dynamic-tag',
                        created: new Date().toISOString(),
                        registry: 'ecr'
<<<<<<< HEAD
                    }))

                    const merged = mergeStaticAndDynamic(staticImages, overlapping)
=======
                    }));

                    const merged = mergeStaticAndDynamic(staticImages, overlapping);
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // Merged should have exactly the static entries (all dynamic are duplicates)
                    assert.strictEqual(
                        merged.length,
                        staticImages.length,
                        'When all dynamic entries collide, merged length should equal static length'
<<<<<<< HEAD
                    )
=======
                    );
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

                    // Each merged entry should be the static version (not the dynamic one)
                    for (let i = 0; i < staticImages.length; i++) {
                        assert.strictEqual(
                            merged[i].tag,
                            staticImages[i].tag,
                            `Entry at index ${i} should be the static version, not dynamic`
<<<<<<< HEAD
                        )
                    }

                    return true
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
        })
    })
})
=======
                        );
                    }

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});
>>>>>>> bad17e2 (feat: add MCP server validation CI job and prune orphaned scripts)

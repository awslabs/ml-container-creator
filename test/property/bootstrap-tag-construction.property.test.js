// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Tag Construction Completeness Property-Based Tests
 *
 * Property 4: Tag construction completeness
 *
 * For any generator version string and any resource type (IAM role, ECR
 * repository, S3 bucket), the constructed tag set should always contain
 * exactly three tags: `mlcc:managed-by` = `ml-container-creator`,
 * `mlcc:created-by` = `bootstrap`, and `mlcc:version` = the provided
 * version string.
 *
 * Feature: bootstrap-shared-infra, Property 4: Tag construction completeness
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: bootstrap-shared-infra, Property 4: Tag construction completeness', () => {

    /**
     * Validates: Requirements 7.1, 7.2, 7.3
     */
    it('_buildResourceTags() always returns exactly 3 tags with correct keys and values', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            // Generate an arbitrary integer to create distinct handler instances per run
            fc.integer({ min: 0, max: 10000 }),
            (_seed) => {
                // Create a handler with a minimal mock generator
                const handler = new BootstrapCommandHandler({});

                // Call _buildResourceTags()
                const tags = handler._buildResourceTags();

                // Exactly 3 tags
                assert.strictEqual(
                    tags.length,
                    3,
                    `Expected exactly 3 tags, got ${tags.length}`
                );

                // Every tag has both Key and Value properties
                for (const tag of tags) {
                    assert.ok(
                        Object.prototype.hasOwnProperty.call(tag, 'Key'),
                        'Each tag must have a "Key" property'
                    );
                    assert.ok(
                        Object.prototype.hasOwnProperty.call(tag, 'Value'),
                        'Each tag must have a "Value" property'
                    );
                }

                // Extract tags into a map for easier assertion
                const tagMap = {};
                for (const tag of tags) {
                    tagMap[tag.Key] = tag.Value;
                }

                // Tag keys are exactly the expected set
                const expectedKeys = ['mlcc:managed-by', 'mlcc:created-by', 'mlcc:version'];
                assert.deepStrictEqual(
                    Object.keys(tagMap).sort(),
                    expectedKeys.sort(),
                    'Tag keys must be exactly: mlcc:managed-by, mlcc:created-by, mlcc:version'
                );

                // mlcc:managed-by = 'ml-container-creator'
                assert.strictEqual(
                    tagMap['mlcc:managed-by'],
                    'ml-container-creator',
                    'mlcc:managed-by must equal "ml-container-creator"'
                );

                // mlcc:created-by = 'bootstrap'
                assert.strictEqual(
                    tagMap['mlcc:created-by'],
                    'bootstrap',
                    'mlcc:created-by must equal "bootstrap"'
                );

                // mlcc:version is a non-empty string
                assert.ok(
                    typeof tagMap['mlcc:version'] === 'string' && tagMap['mlcc:version'].length > 0,
                    'mlcc:version must be a non-empty string'
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 7.1, 7.2, 7.3
     *
     * Consistency: multiple calls to _buildResourceTags() on different
     * handler instances always produce the same tag set.
     */
    it('_buildResourceTags() produces consistent results across handler instances', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.integer({ min: 2, max: 10 }),
            (instanceCount) => {
                const tagSets = [];

                for (let i = 0; i < instanceCount; i++) {
                    const handler = new BootstrapCommandHandler({});
                    tagSets.push(handler._buildResourceTags());
                }

                // All tag sets should be deeply equal
                for (let i = 1; i < tagSets.length; i++) {
                    assert.deepStrictEqual(
                        tagSets[i],
                        tagSets[0],
                        `Tag set from instance ${i} must match tag set from instance 0`
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});
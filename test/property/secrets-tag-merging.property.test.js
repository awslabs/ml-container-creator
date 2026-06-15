// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Tag Merging Correctness Property-Based Tests
 *
 * Property 5: Tag Merging Correctness
 *
 * For any set of user-provided tags, the final merged tag set SHALL:
 * (a) always contain the system-defined values for `mlcc:managed-by`,
 *     `mlcc:created-by`, and `mlcc:secret-type` regardless of user input, and
 * (b) preserve all user-provided tags whose keys do not use the `mlcc:` prefix.
 *
 * Feature: secrets-manager-integration, Property 5: Tag Merging Correctness
 *
 * Validates: Requirements 2.7, 2.8
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import SecretsCommandHandler from '../../src/lib/secrets-command-handler.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a SecretsCommandHandler instance to access _mergeTags.
 */
function createHandler() {
    const handler = new SecretsCommandHandler({
        promptFn: async () => ({}),
        execAwsFn: () => ({})
    });
    return handler;
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random tag key that does NOT start with 'mlcc:'.
 * These represent valid user-provided tags that should be preserved.
 */
const arbNonMlccTagKey = fc.string({ minLength: 1, maxLength: 50 })
    .filter(s => s.trim().length > 0 && !s.startsWith('mlcc:') && !s.includes('\0'));

/**
 * Generate a random tag key that starts with 'mlcc:'.
 * These represent user-provided tags that conflict with the reserved prefix.
 */
const arbMlccTagKey = fc.string({ minLength: 1, maxLength: 40 })
    .filter(s => s.trim().length > 0 && !s.includes('\0'))
    .map(s => `mlcc:${s}`);

/**
 * Generate a random tag value.
 */
const arbTagValue = fc.string({ minLength: 0, maxLength: 100 })
    .filter(s => !s.includes('\0'));

/**
 * Generate a valid user tag (Key/Value pair) without the mlcc: prefix.
 */
const arbNonMlccTag = fc.record({
    Key: arbNonMlccTagKey,
    Value: arbTagValue
});

/**
 * Generate a user tag with the mlcc: prefix (should be removed/overwritten).
 */
const arbMlccTag = fc.record({
    Key: arbMlccTagKey,
    Value: arbTagValue
});

/**
 * Generate a mixed array of user tags — some with mlcc: prefix, some without.
 */
const arbUserTags = fc.array(
    fc.oneof(arbNonMlccTag, arbMlccTag),
    { minLength: 0, maxLength: 20 }
);

/**
 * Generate a valid secret type identifier from the known types.
 */
const arbSecretType = fc.constantFrom('hf-token', 'ngc-token');

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration, Property 5: Tag Merging Correctness', () => {

    let originalLog;

    beforeEach(() => {
        // Suppress console.log warnings from _mergeTags about overwritten tags
        originalLog = console.log;
        console.log = () => {};
    });

    afterEach(() => {
        console.log = originalLog;
    });

    /**
     * Validates: Requirements 2.7, 2.8
     *
     * For any set of user-provided tags, the merged result always contains
     * the three system tags with correct values.
     */
    it('merged result always contains system tags with correct values', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbUserTags,
            arbSecretType,
            (userTags, secretType) => {
                const handler = createHandler();
                const result = handler._mergeTags(userTags, secretType);

                // System tag: mlcc:managed-by
                const managedByTag = result.find(t => t.Key === 'mlcc:managed-by');
                assert.ok(managedByTag, 'Result must contain mlcc:managed-by tag');
                assert.strictEqual(managedByTag.Value, 'ml-container-creator',
                    'mlcc:managed-by must equal "ml-container-creator"');

                // System tag: mlcc:created-by
                const createdByTag = result.find(t => t.Key === 'mlcc:created-by');
                assert.ok(createdByTag, 'Result must contain mlcc:created-by tag');
                assert.strictEqual(createdByTag.Value, 'secrets',
                    'mlcc:created-by must equal "secrets"');

                // System tag: mlcc:secret-type
                const secretTypeTag = result.find(t => t.Key === 'mlcc:secret-type');
                assert.ok(secretTypeTag, 'Result must contain mlcc:secret-type tag');
                assert.strictEqual(secretTypeTag.Value, secretType,
                    `mlcc:secret-type must equal "${secretType}"`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 2.8
     *
     * All user tags without the mlcc: prefix are preserved in the result.
     */
    it('all user tags without mlcc: prefix are preserved in the result', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbUserTags,
            arbSecretType,
            (userTags, secretType) => {
                const handler = createHandler();
                const result = handler._mergeTags(userTags, secretType);

                // Every user tag whose key does NOT start with 'mlcc:' must appear in result
                const nonMlccUserTags = userTags.filter(t => t && t.Key && !t.Key.startsWith('mlcc:'));

                for (const userTag of nonMlccUserTags) {
                    const found = result.find(t => t.Key === userTag.Key && t.Value === userTag.Value);
                    assert.ok(found,
                        `User tag {Key: "${userTag.Key}", Value: "${userTag.Value}"} should be preserved in result`);
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 2.7
     *
     * No user tags with the mlcc: prefix appear in the result
     * (except the three system-defined ones with their correct values).
     */
    it('no user-provided mlcc: tags appear in result except system tags', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbUserTags,
            arbSecretType,
            (userTags, secretType) => {
                const handler = createHandler();
                const result = handler._mergeTags(userTags, secretType);

                const systemTagKeys = new Set([
                    'mlcc:managed-by',
                    'mlcc:created-by',
                    'mlcc:secret-type'
                ]);

                // All tags with mlcc: prefix in the result must be system tags
                const mlccTagsInResult = result.filter(t => t.Key.startsWith('mlcc:'));

                for (const tag of mlccTagsInResult) {
                    assert.ok(systemTagKeys.has(tag.Key),
                        `Tag with key "${tag.Key}" has mlcc: prefix but is not a system tag — should have been removed`);
                }

                // There should be exactly 3 mlcc: tags in the result (the system ones)
                assert.strictEqual(mlccTagsInResult.length, 3,
                    `Expected exactly 3 mlcc: tags in result, got ${mlccTagsInResult.length}`);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 2.7
     *
     * System tags cannot be overridden by user input — even if user provides
     * tags with the exact system tag keys, the system values always win.
     */
    it('system tags cannot be overridden by user-provided tags with same keys', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        // Generate user tags that specifically try to override system tags
        const arbOverrideTags = fc.array(
            fc.record({
                Key: fc.constantFrom('mlcc:managed-by', 'mlcc:created-by', 'mlcc:secret-type'),
                Value: fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes('\0'))
            }),
            { minLength: 1, maxLength: 5 }
        );

        fc.assert(fc.property(
            arbOverrideTags,
            arbSecretType,
            (overrideTags, secretType) => {
                const handler = createHandler();
                const result = handler._mergeTags(overrideTags, secretType);

                // System values must still be correct regardless of user override attempts
                const managedByTag = result.find(t => t.Key === 'mlcc:managed-by');
                assert.strictEqual(managedByTag.Value, 'ml-container-creator');

                const createdByTag = result.find(t => t.Key === 'mlcc:created-by');
                assert.strictEqual(createdByTag.Value, 'secrets');

                const secretTypeTag = result.find(t => t.Key === 'mlcc:secret-type');
                assert.strictEqual(secretTypeTag.Value, secretType);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

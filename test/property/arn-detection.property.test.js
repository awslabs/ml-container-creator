// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ARN Detection Correctness Property-Based Tests
 *
 * Property 11: ARN Detection Correctness
 *
 * For any string value, the `isSecretsManagerArn` function SHALL return
 * true if and only if the string starts with `arn:aws:secretsmanager:`.
 *
 * Feature: secrets-manager-integration, Property 11: ARN Detection Correctness
 *
 * Validates: Requirements 8.4
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { isSecretsManagerArn } from '../../src/lib/arn-detection.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

const SECRETS_MANAGER_ARN_PREFIX = 'arn:aws:secretsmanager:';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid Secrets Manager ARN by prepending the required prefix
 * to a random suffix string.
 */
const arbValidArn = fc.string({ minLength: 1 }).map(
    suffix => `${SECRETS_MANAGER_ARN_PREFIX}${suffix}`
);

/**
 * Generate a random string that does NOT start with the Secrets Manager ARN prefix.
 * Filters out any string that happens to start with the prefix.
 */
const arbNonArnString = fc.string().filter(
    s => !s.startsWith(SECRETS_MANAGER_ARN_PREFIX)
);

/**
 * Generate partial prefixes of the ARN pattern that are not complete matches.
 * These are substrings of the prefix that should NOT be detected as ARNs.
 */
const arbPartialPrefix = fc.integer({ min: 1, max: SECRETS_MANAGER_ARN_PREFIX.length - 1 }).map(
    len => SECRETS_MANAGER_ARN_PREFIX.slice(0, len)
);

/**
 * Generate non-string values (numbers, booleans, null, undefined, objects, arrays).
 */
const arbNonStringValue = fc.oneof(
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.object(),
    fc.array(fc.anything())
);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration, Property 11: ARN Detection Correctness', () => {

    /**
     * Validates: Requirements 8.4
     */

    it('returns true for any string starting with the Secrets Manager ARN prefix', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbValidArn,
            (arn) => {
                assert.strictEqual(
                    isSecretsManagerArn(arn),
                    true,
                    `Expected true for ARN "${arn}" which starts with "${SECRETS_MANAGER_ARN_PREFIX}"`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('returns false for any string that does not start with the Secrets Manager ARN prefix', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbNonArnString,
            (value) => {
                assert.strictEqual(
                    isSecretsManagerArn(value),
                    false,
                    `Expected false for non-ARN string "${value}"`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('returns false for partial prefixes of the ARN pattern', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbPartialPrefix,
            (partial) => {
                assert.strictEqual(
                    isSecretsManagerArn(partial),
                    false,
                    `Expected false for partial prefix "${partial}"`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('returns false for any non-string value', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbNonStringValue,
            (value) => {
                assert.strictEqual(
                    isSecretsManagerArn(value),
                    false,
                    `Expected false for non-string value ${JSON.stringify(value)} (type: ${typeof value})`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('the biconditional holds: returns true iff string starts with prefix', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.string(),
            (value) => {
                const expected = value.startsWith(SECRETS_MANAGER_ARN_PREFIX);
                const actual = isSecretsManagerArn(value);
                assert.strictEqual(
                    actual,
                    expected,
                    `Biconditional violated for "${value}": expected ${expected}, got ${actual}`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Register Sensitive Value Redaction Property-Based Tests
 *
 * Property 11: Sensitive value redaction
 *
 * For any parameters object containing keys matching sensitive patterns
 * (HF_TOKEN, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, or keys containing
 * "SECRET" or "TOKEN"), the register script's output SHALL replace those
 * values with a redaction marker before writing to DynamoDB.
 *
 * Feature: cli-config-parameters, Property 11
 *
 * **Validates: Requirements 6.5**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import {
    isSensitiveKey,
    redactSensitiveValues,
    REDACTION_MARKER
} from '../../src/lib/sensitive-redactor.js';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Arbitrary generators ─────────────────────────────────────────────────────

/**
 * Generate a key that is guaranteed to be sensitive (matches one of the patterns).
 */
const arbSensitiveKey = fc.oneof(
    fc.constant('HF_TOKEN'),
    fc.constant('AWS_SECRET_ACCESS_KEY'),
    fc.constant('AWS_SESSION_TOKEN'),
    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}SECRET[A-Z0-9_]{0,5}$/),
    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}TOKEN[A-Z0-9_]{0,5}$/),
    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,5}_SECRET_[A-Z0-9_]{0,5}$/),
    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,5}_TOKEN_[A-Z0-9_]{0,5}$/)
);

/**
 * Generate a key that is guaranteed to be non-sensitive.
 */
const arbNonSensitiveKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{2,12}$/).filter(key => {
    return !isSensitiveKey(key);
});

/**
 * Generate an arbitrary value (could be a real secret or normal value).
 */
const arbValue = fc.stringMatching(/^[a-zA-Z0-9._\-/]{1,30}$/);

/**
 * Generate a parameters object with at least one sensitive key.
 */
const arbParamsWithSensitiveKeys = fc.tuple(
    fc.array(fc.tuple(arbSensitiveKey, arbValue), { minLength: 1, maxLength: 4 }),
    fc.array(fc.tuple(arbNonSensitiveKey, arbValue), { minLength: 0, maxLength: 3 })
).map(([sensitiveEntries, normalEntries]) => {
    const params = {};
    sensitiveEntries.forEach(([key, value]) => { params[key] = value; });
    normalEntries.forEach(([key, value]) => { params[key] = value; });
    return params;
});

/**
 * Generate a parameters object with only non-sensitive keys.
 */
const arbParamsWithNoSensitiveKeys = fc.array(
    fc.tuple(arbNonSensitiveKey, arbValue),
    { minLength: 1, maxLength: 5 }
).map(entries => {
    const params = {};
    entries.forEach(([key, value]) => { params[key] = value; });
    return params;
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: cli-config-parameters, Property 11: Sensitive value redaction', () => {

    describe('sensitive keys are redacted in output', () => {

        it('for any parameters with sensitive keys, redacted output replaces values with marker', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbParamsWithSensitiveKeys,
                (params) => {
                    const redacted = redactSensitiveValues(params);

                    for (const [key, value] of Object.entries(params)) {
                        if (isSensitiveKey(key)) {
                            assert.strictEqual(redacted[key], REDACTION_MARKER,
                                `Sensitive key "${key}" should be redacted but got "${redacted[key]}"`);
                        } else {
                            assert.strictEqual(redacted[key], value,
                                `Non-sensitive key "${key}" should preserve value "${value}" but got "${redacted[key]}"`);
                        }
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any parameters with no sensitive keys, no values are redacted', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbParamsWithNoSensitiveKeys,
                (params) => {
                    const redacted = redactSensitiveValues(params);

                    for (const [key, value] of Object.entries(params)) {
                        assert.strictEqual(redacted[key], value,
                            `Non-sensitive key "${key}" should preserve value "${value}" but got "${redacted[key]}"`);
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('redaction preserves all keys (no keys are dropped)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbParamsWithSensitiveKeys,
                (params) => {
                    const redacted = redactSensitiveValues(params);
                    const originalKeys = Object.keys(params).sort();
                    const redactedKeys = Object.keys(redacted).sort();

                    assert.deepStrictEqual(redactedKeys, originalKeys,
                        'Redaction should preserve all keys');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

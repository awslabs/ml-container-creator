// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * KEY=VALUE First-Equals Splitting Property-Based Tests
 *
 * Property 3: KEY=VALUE first-equals splitting
 *
 * For any string containing at least one equals sign, the KEY=VALUE parser
 * SHALL split on the first equals sign only, such that the key is the
 * substring before the first `=` and the value is the entire substring
 * after the first `=` (which may itself contain `=` characters).
 *
 * Feature: cli-config-parameters, Property 3
 *
 * **Validates: Requirements 3.4, 4.4**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { parseKeyValue } from '../../generators/app/lib/key-value-parser.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Property tests ───────────────────────────────────────────────────────────

describe('KEY=VALUE First-Equals Splitting Property-Based Tests', () => {

    // Feature: cli-config-parameters, Property 3: KEY=VALUE first-equals splitting
    describe('Property 3: KEY=VALUE first-equals splitting', () => {

        /**
         * Validates: Requirements 3.4, 4.4
         */

        it('splits on the first equals sign: key is substring before first =, value is everything after', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(fc.string(), fc.string()),
                ([keyPart, valuePart]) => {
                    const input = `${keyPart}=${valuePart}`;
                    const result = parseKeyValue(input);

                    const expectedKey = input.substring(0, input.indexOf('='));
                    const expectedValue = input.substring(input.indexOf('=') + 1);

                    assert.strictEqual(result.key, expectedKey,
                        `Key should be substring before first "=". Input: "${input}", got key: "${result.key}", expected: "${expectedKey}"`);
                    assert.strictEqual(result.value, expectedValue,
                        `Value should be everything after first "=". Input: "${input}", got value: "${result.value}", expected: "${expectedValue}"`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('preserves additional equals signs in the value portion', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(
                    fc.string({ minLength: 1 }),
                    fc.string(),
                    fc.string()
                ),
                ([keyPart, valuePart1, valuePart2]) => {
                    // Create input with multiple = signs in value
                    const input = `${keyPart}=${valuePart1}=${valuePart2}`;
                    const result = parseKeyValue(input);

                    const expectedKey = input.substring(0, input.indexOf('='));
                    const expectedValue = input.substring(input.indexOf('=') + 1);

                    assert.strictEqual(result.key, expectedKey,
                        `Key should be substring before first "=". Input: "${input}"`);
                    assert.strictEqual(result.value, expectedValue,
                        `Value should preserve all "=" after the first. Input: "${input}"`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});

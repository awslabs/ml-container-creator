// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Missing-Equals Format Rejection Property-Based Tests
 *
 * Property 4: Missing-equals format rejection
 *
 * For any string that does not contain an equals sign, passing it as a
 * `--model-env` or `--server-env` flag SHALL produce a validation error
 * indicating the expected `KEY=VALUE` format.
 *
 * Feature: cli-config-parameters, Property 4
 *
 * **Validates: Requirements 3.5, 4.5**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { parseKeyValue } from '../../src/lib/key-value-parser.js';
import { ValidationError } from '../../src/lib/config-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Property tests ───────────────────────────────────────────────────────────

describe('Missing-Equals Format Rejection Property-Based Tests', () => {

    // Feature: cli-config-parameters, Property 4: Missing-equals format rejection
    describe('Property 4: Missing-equals format rejection', () => {

        /**
         * Validates: Requirements 3.5, 4.5
         */

        it('throws ValidationError for any string without an equals sign', function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.string().filter(s => !s.includes('=')),
                (input) => {
                    assert.throws(
                        () => parseKeyValue(input),
                        (err) => {
                            assert.ok(err instanceof ValidationError,
                                `Expected ValidationError but got ${err.constructor.name}`);
                            assert.ok(err.message.includes('expected KEY=VALUE'),
                                `Error message should include "expected KEY=VALUE" but got: "${err.message}"`);
                            assert.ok(err.message.includes(input),
                                `Error message should include the input "${input}" but got: "${err.message}"`);
                            return true;
                        }
                    );

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});

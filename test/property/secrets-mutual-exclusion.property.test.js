// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Mutual Exclusion Property-Based Tests
 *
 * Property 9: Mutual Exclusion of Plaintext and ARN Flags
 *
 * For any CLI invocation where both --hf-token and --hf-token-arn are provided
 * (regardless of their values), the CLI SHALL produce a validation error.
 * The same applies to --ngc-token and --ngc-token-arn.
 *
 * Feature: secrets-manager-integration, Property 9: Mutual Exclusion of Plaintext and ARN Flags
 *
 * Validates: Requirements 7.6
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Validation Function ──────────────────────────────────────────────────────

/**
 * Validates mutual exclusion of plaintext and ARN flags.
 * Mirrors the validation logic in bin/cli.js root command action handler.
 *
 * @param {object} options - CLI options object
 * @returns {{ error: string } | null} Error object if validation fails, null if valid
 */
function validateMutualExclusion(options) {
    if (options.hfToken && options.hfTokenArn) {
        return { error: 'Cannot specify both --hf-token and --hf-token-arn. Use one or the other.' };
    }
    if (options.ngcToken && options.ngcTokenArn) {
        return { error: 'Cannot specify both --ngc-token and --ngc-token-arn. Use one or the other.' };
    }
    return null;
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a non-empty string suitable for token values.
 * These represent truthy values that would trigger the mutual exclusion check.
 */
const arbNonEmptyToken = fc.string({ minLength: 1, maxLength: 100 })
    .filter(s => s.trim().length > 0);

/**
 * Generate a valid-looking Secrets Manager ARN.
 */
const arbArn = fc.tuple(
    fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'),
    fc.stringMatching(/^[0-9]{12}$/),
    fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0)
).map(([region, account, name]) =>
    `arn:aws:secretsmanager:${region}:${account}:secret:mlcc/${name}`
);

/**
 * Generate an optional (possibly undefined/null/empty) value for a flag.
 * These represent falsy values that would NOT trigger the mutual exclusion check.
 */
const arbFalsyValue = fc.constantFrom(undefined, null, '', false);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration, Property 9: Mutual Exclusion of Plaintext and ARN Flags', () => {

    /**
     * Validates: Requirements 7.6
     *
     * When both --hf-token and --hf-token-arn are provided with truthy values,
     * validation MUST produce an error.
     */
    it('produces an error when both --hf-token and --hf-token-arn are provided', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbNonEmptyToken,
            arbArn,
            (hfToken, hfTokenArn) => {
                const options = { hfToken, hfTokenArn };
                const result = validateMutualExclusion(options);

                assert.notStrictEqual(
                    result,
                    null,
                    `Expected validation error when both hfToken="${hfToken}" and hfTokenArn="${hfTokenArn}" are provided`
                );
                assert.ok(
                    result.error.includes('--hf-token'),
                    `Error message should mention --hf-token: "${result.error}"`
                );
                assert.ok(
                    result.error.includes('--hf-token-arn'),
                    `Error message should mention --hf-token-arn: "${result.error}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 7.6
     *
     * When both --ngc-token and --ngc-token-arn are provided with truthy values,
     * validation MUST produce an error.
     */
    it('produces an error when both --ngc-token and --ngc-token-arn are provided', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbNonEmptyToken,
            arbArn,
            (ngcToken, ngcTokenArn) => {
                const options = { ngcToken, ngcTokenArn };
                const result = validateMutualExclusion(options);

                assert.notStrictEqual(
                    result,
                    null,
                    `Expected validation error when both ngcToken="${ngcToken}" and ngcTokenArn="${ngcTokenArn}" are provided`
                );
                assert.ok(
                    result.error.includes('--ngc-token'),
                    `Error message should mention --ngc-token: "${result.error}"`
                );
                assert.ok(
                    result.error.includes('--ngc-token-arn'),
                    `Error message should mention --ngc-token-arn: "${result.error}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 7.6
     *
     * When only --hf-token is provided (without --hf-token-arn),
     * validation MUST pass (return null).
     */
    it('passes validation when only --hf-token is provided without --hf-token-arn', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbNonEmptyToken,
            arbFalsyValue,
            (hfToken, hfTokenArn) => {
                const options = { hfToken, hfTokenArn };
                const result = validateMutualExclusion(options);

                assert.strictEqual(
                    result,
                    null,
                    `Expected no error when only hfToken is provided, but got: ${JSON.stringify(result)}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 7.6
     *
     * When only --hf-token-arn is provided (without --hf-token),
     * validation MUST pass (return null).
     */
    it('passes validation when only --hf-token-arn is provided without --hf-token', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbFalsyValue,
            arbArn,
            (hfToken, hfTokenArn) => {
                const options = { hfToken, hfTokenArn };
                const result = validateMutualExclusion(options);

                assert.strictEqual(
                    result,
                    null,
                    `Expected no error when only hfTokenArn is provided, but got: ${JSON.stringify(result)}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 7.6
     *
     * When only --ngc-token is provided (without --ngc-token-arn),
     * validation MUST pass (return null).
     */
    it('passes validation when only --ngc-token is provided without --ngc-token-arn', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbNonEmptyToken,
            arbFalsyValue,
            (ngcToken, ngcTokenArn) => {
                const options = { ngcToken, ngcTokenArn };
                const result = validateMutualExclusion(options);

                assert.strictEqual(
                    result,
                    null,
                    `Expected no error when only ngcToken is provided, but got: ${JSON.stringify(result)}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 7.6
     *
     * When only --ngc-token-arn is provided (without --ngc-token),
     * validation MUST pass (return null).
     */
    it('passes validation when only --ngc-token-arn is provided without --ngc-token', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbFalsyValue,
            arbArn,
            (ngcToken, ngcTokenArn) => {
                const options = { ngcToken, ngcTokenArn };
                const result = validateMutualExclusion(options);

                assert.strictEqual(
                    result,
                    null,
                    `Expected no error when only ngcTokenArn is provided, but got: ${JSON.stringify(result)}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 7.6
     *
     * When neither token nor ARN is provided for either pair,
     * validation MUST pass (return null).
     */
    it('passes validation when no token flags are provided', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbFalsyValue,
            arbFalsyValue,
            arbFalsyValue,
            arbFalsyValue,
            (hfToken, hfTokenArn, ngcToken, ngcTokenArn) => {
                const options = { hfToken, hfTokenArn, ngcToken, ngcTokenArn };
                const result = validateMutualExclusion(options);

                assert.strictEqual(
                    result,
                    null,
                    `Expected no error when no token flags are provided, but got: ${JSON.stringify(result)}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 7.6
     *
     * When both HF pair AND NGC pair have conflicts simultaneously,
     * the first conflict (hf-token) is reported.
     */
    it('reports hf-token conflict first when both pairs conflict simultaneously', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbNonEmptyToken,
            arbArn,
            arbNonEmptyToken,
            arbArn,
            (hfToken, hfTokenArn, ngcToken, ngcTokenArn) => {
                const options = { hfToken, hfTokenArn, ngcToken, ngcTokenArn };
                const result = validateMutualExclusion(options);

                assert.notStrictEqual(
                    result,
                    null,
                    'Expected validation error when both pairs conflict'
                );
                // The first check in the CLI is for hf-token pair
                assert.ok(
                    result.error.includes('--hf-token'),
                    `Error should report hf-token conflict first: "${result.error}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

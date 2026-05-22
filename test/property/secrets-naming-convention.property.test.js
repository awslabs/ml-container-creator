// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Naming Convention Enforcement Property-Based Tests
 *
 * Property 6: Naming Convention Enforcement
 *
 * For any valid secret-type identifier and user-provided label, the constructed
 * secret name SHALL always match the pattern `mlcc/<type>/<label>`, regardless
 * of input method (interactive, flags, or JSON).
 *
 * Feature: secrets-manager-integration, Property 6: Naming Convention Enforcement
 *
 * Validates: Requirements 2.9
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import SecretsCommandHandler from '../../src/lib/secrets-command-handler.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a SecretsCommandHandler instance to access _constructSecretName.
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
 * Generate a random type string (non-empty, no slashes or null bytes).
 * Represents a secret type identifier like 'hf-token' or 'ngc-token'.
 */
const arbType = fc.string({ minLength: 1, maxLength: 50 })
    .filter(s => s.trim().length > 0 && !s.includes('/') && !s.includes('\0'));

/**
 * Generate a random label string (non-empty, no slashes or null bytes).
 * Represents a user-provided label like 'production' or 'ci-pipeline'.
 */
const arbLabel = fc.string({ minLength: 1, maxLength: 50 })
    .filter(s => s.trim().length > 0 && !s.includes('/') && !s.includes('\0'));

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration, Property 6: Naming Convention Enforcement', () => {

    /**
     * Validates: Requirements 2.9
     *
     * For any valid type and label, the constructed name always starts with 'mlcc/'.
     */
    it('constructed name always starts with mlcc/ prefix', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbType,
            arbLabel,
            (type, label) => {
                const handler = createHandler();
                const result = handler._constructSecretName(type, label);

                assert.ok(result.startsWith('mlcc/'),
                    `Expected name to start with "mlcc/" but got "${result}"`);
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 2.9
     *
     * For any valid type and label, the constructed name matches
     * the exact pattern mlcc/<type>/<label>.
     */
    it('constructed name matches pattern mlcc/<type>/<label> exactly', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbType,
            arbLabel,
            (type, label) => {
                const handler = createHandler();
                const result = handler._constructSecretName(type, label);

                const expected = `mlcc/${type}/${label}`;
                assert.strictEqual(result, expected,
                    `Expected "${expected}" but got "${result}"`);
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 2.9
     *
     * For any valid type and label, the type and label can be extracted
     * back from the constructed name by splitting on '/'.
     */
    it('type and label can be extracted back from the constructed name', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbType,
            arbLabel,
            (type, label) => {
                const handler = createHandler();
                const result = handler._constructSecretName(type, label);

                // Split on '/' — should yield exactly ['mlcc', type, label]
                const parts = result.split('/');
                assert.strictEqual(parts.length, 3,
                    `Expected 3 parts when splitting on "/" but got ${parts.length}: ${JSON.stringify(parts)}`);
                assert.strictEqual(parts[0], 'mlcc',
                    `First part should be "mlcc" but got "${parts[0]}"`);
                assert.strictEqual(parts[1], type,
                    `Second part should be type "${type}" but got "${parts[1]}"`);
                assert.strictEqual(parts[2], label,
                    `Third part should be label "${label}" but got "${parts[2]}"`);
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

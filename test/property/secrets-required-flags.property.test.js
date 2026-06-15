// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Required Flags Validation Property-Based Tests
 *
 * Property 2: Required Flags Validation
 *
 * For any subset of CLI flags provided to `secrets create` in non-interactive mode,
 * the command SHALL succeed if and only if the subset includes `--type`, `--name`,
 * and `--secret-value`. When the subset is incomplete, the error message SHALL list
 * exactly the missing required fields.
 *
 * Feature: secrets-manager-integration, Property 2: Required Flags Validation
 *
 * Validates: Requirements 2.4, 2.13
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import SecretsCommandHandler from '../../src/lib/secrets-command-handler.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a SecretsCommandHandler with mocked dependencies.
 * The execAwsFn returns a mock ARN result so that when all required flags
 * are present, the create flow succeeds without calling real AWS APIs.
 */
function createMockedHandler() {
    const mockExecAwsFn = () => ({
        ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/test-abc123',
        Name: 'mlcc/hf-token/test'
    });

    const mockPromptFn = async () => ({});

    const handler = new SecretsCommandHandler({
        promptFn: mockPromptFn,
        execAwsFn: mockExecAwsFn
    });

    // Mock the bootstrap config to return a valid profile
    handler._bootstrapConfig = {
        getActiveProfile: () => ({
            config: {
                awsProfile: 'test-profile',
                awsRegion: 'us-east-1'
            }
        })
    };

    return handler;
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random non-empty string suitable for flag values.
 */
const arbFlagValue = fc.string({ minLength: 1, maxLength: 50 })
    .filter(s => s.trim().length > 0 && !s.includes('\0'));

/**
 * Generate a random boolean for each of the three required flags (type, name, secretValue)
 * and two optional flags (description, kmsKeyId).
 * This produces all possible subsets of flags.
 */
const arbFlagSubset = fc.record({
    includeType: fc.boolean(),
    includeName: fc.boolean(),
    includeSecretValue: fc.boolean(),
    includeDescription: fc.boolean(),
    includeKmsKeyId: fc.boolean()
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: secrets-manager-integration, Property 2: Required Flags Validation', () => {

    let originalExitCode;

    beforeEach(() => {
        originalExitCode = process.exitCode;
        process.exitCode = undefined;
    });

    afterEach(() => {
        process.exitCode = originalExitCode;
    });

    /**
     * Validates: Requirements 2.4, 2.13
     *
     * For any subset of CLI flags, `secrets create` succeeds iff subset
     * includes type, name, and secret-value.
     */
    it('secrets create succeeds iff all three required flags (type, name, secretValue) are present', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.asyncProperty(
            arbFlagSubset,
            arbFlagValue,
            arbFlagValue,
            arbFlagValue,
            arbFlagValue,
            arbFlagValue,
            async (subset, typeVal, nameVal, secretVal, descVal, kmsVal) => {
                const handler = createMockedHandler();
                process.exitCode = undefined;

                // Build options object based on the subset flags
                const options = {};
                if (subset.includeType) options.type = 'hf-token'; // Use valid type from registry
                if (subset.includeName) options.name = nameVal;
                if (subset.includeSecretValue) options.secretValue = secretVal;
                if (subset.includeDescription) options.description = descVal;
                if (subset.includeKmsKeyId) options.kmsKeyId = kmsVal;

                // Suppress console output during test
                const originalLog = console.log;
                const logOutput = [];
                console.log = (...args) => logOutput.push(args.join(' '));

                try {
                    await handler._handleCreate(options);
                } finally {
                    console.log = originalLog;
                }

                const allRequiredPresent = subset.includeType && subset.includeName && subset.includeSecretValue;

                if (allRequiredPresent) {
                    // Should succeed — exitCode should NOT be 1
                    assert.notStrictEqual(
                        process.exitCode,
                        1,
                        `Expected success when all required flags are present, but got exitCode=1. Output: ${logOutput.join('\n')}`
                    );
                } else {
                    // Should fail — exitCode should be 1
                    assert.strictEqual(
                        process.exitCode,
                        1,
                        `Expected exitCode=1 when required flags are missing (type=${subset.includeType}, name=${subset.includeName}, secretValue=${subset.includeSecretValue}). Output: ${logOutput.join('\n')}`
                    );
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 2.13
     *
     * When required flags are missing, the error message lists exactly
     * the missing required fields.
     */
    it('error message lists exactly the missing required fields', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.asyncProperty(
            arbFlagSubset.filter(s => !(s.includeType && s.includeName && s.includeSecretValue)),
            arbFlagValue,
            arbFlagValue,
            arbFlagValue,
            async (subset, nameVal, secretVal, descVal) => {
                const handler = createMockedHandler();
                process.exitCode = undefined;

                // Build options with at least one required flag missing
                const options = {};
                if (subset.includeType) options.type = 'hf-token';
                if (subset.includeName) options.name = nameVal;
                if (subset.includeSecretValue) options.secretValue = secretVal;
                if (subset.includeDescription) options.description = descVal;

                // Capture console output
                const originalLog = console.log;
                const logOutput = [];
                console.log = (...args) => logOutput.push(args.join(' '));

                try {
                    await handler._handleCreate(options);
                } finally {
                    console.log = originalLog;
                }

                const output = logOutput.join('\n');

                // Verify each missing flag is mentioned in the error
                if (!subset.includeType) {
                    assert.ok(
                        output.includes('--type'),
                        `Error should mention --type when it is missing. Output: ${output}`
                    );
                }
                if (!subset.includeName) {
                    assert.ok(
                        output.includes('--name'),
                        `Error should mention --name when it is missing. Output: ${output}`
                    );
                }
                if (!subset.includeSecretValue) {
                    assert.ok(
                        output.includes('--secret-value'),
                        `Error should mention --secret-value when it is missing. Output: ${output}`
                    );
                }

                // Verify present flags are NOT listed as missing
                if (subset.includeType) {
                    // The output may mention --type in context, but it should not be in the "Missing required fields" list
                    const missingLine = logOutput.find(l => l.includes('Missing required fields'));
                    if (missingLine) {
                        assert.ok(
                            !missingLine.includes('--type'),
                            `Error should NOT list --type as missing when it is present. Missing line: ${missingLine}`
                        );
                    }
                }
                if (subset.includeName) {
                    const missingLine = logOutput.find(l => l.includes('Missing required fields'));
                    if (missingLine) {
                        assert.ok(
                            !missingLine.includes('--name'),
                            `Error should NOT list --name as missing when it is present. Missing line: ${missingLine}`
                        );
                    }
                }
                if (subset.includeSecretValue) {
                    const missingLine = logOutput.find(l => l.includes('Missing required fields'));
                    if (missingLine) {
                        assert.ok(
                            !missingLine.includes('--secret-value'),
                            `Error should NOT list --secret-value as missing when it is present. Missing line: ${missingLine}`
                        );
                    }
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

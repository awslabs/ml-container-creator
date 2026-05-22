// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Format-Only Validation for Env Vars Property-Based Tests
 *
 * Property 12: Format-only validation for env vars
 *
 * For any --model-env or --server-env value that passes format validation
 * (contains at least one `=`), the ConfigManager SHALL NOT raise a
 * value-level validation error regardless of the value content — only the
 * KEY=VALUE structure is validated in this release.
 *
 * Feature: cli-config-parameters, Property 12
 *
 * **Validates: Requirements 10.7**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ConfigManager from '../../src/lib/config-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a string containing at least one `=` with arbitrary content
 * on both sides. The key portion is non-empty to be a valid env var entry.
 */
const arbValidFormatEnvVar = fc.tuple(
    fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('=')),
    fc.string({ minLength: 0, maxLength: 100 })
).map(([key, value]) => `${key}=${value}`);

/**
 * Generate values with special characters, unicode, whitespace, etc.
 * to ensure no value-level validation is performed.
 */
const arbExoticValue = fc.oneof(
    fc.string({ minLength: 0, maxLength: 100 }),
    fc.stringMatching(/^[\u0020-\u007E]{0,50}$/), // eslint-disable-line no-control-regex -- printable ASCII range
    fc.constant(''),
    fc.constant('   '),
    fc.constant('value=with=equals'),
    fc.constant('{"json": true}'),
    fc.constant('<xml>data</xml>'),
    fc.constant('path/to/file.txt'),
    fc.constant('0'),
    fc.constant('-1'),
    fc.constant('99999999999999999')
);

const arbKeyWithExoticValue = fc.tuple(
    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,15}$/),
    arbExoticValue
).map(([key, value]) => `${key}=${value}`);

// ── Helper to create a mock generator ────────────────────────────────────────

function createMockGenerator(cliOptions = {}) {
    return {
        options: { ...cliOptions },
        args: [],
        destDir: process.cwd()
    };
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Format-Only Validation for Env Vars Property-Based Tests', () => {

    // Feature: cli-config-parameters, Property 12: Format-only validation for env vars
    describe('Property 12: Format-only validation for env vars', () => {

        /**
         * Validates: Requirements 10.7
         */

        it('--model-env with valid KEY=VALUE format does not raise value-level validation errors', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbKeyWithExoticValue,
                async (envEntry) => {
                    const mockGenerator = createMockGenerator({
                        'model-env': [envEntry]
                    });

                    // Should not throw any error during configuration loading
                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    // The entry should be stored without value-level validation
                    const key = envEntry.substring(0, envEntry.indexOf('='));
                    const value = envEntry.substring(envEntry.indexOf('=') + 1);

                    assert.strictEqual(configManager.config.modelEnvVars[key], value,
                        `modelEnvVars["${key}"] should be "${value}" without validation error`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('--server-env with valid KEY=VALUE format does not raise value-level validation errors', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbKeyWithExoticValue,
                async (envEntry) => {
                    const mockGenerator = createMockGenerator({
                        'server-env': [envEntry]
                    });

                    // Should not throw any error during configuration loading
                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    // The entry should be stored without value-level validation
                    const key = envEntry.substring(0, envEntry.indexOf('='));
                    const value = envEntry.substring(envEntry.indexOf('=') + 1);

                    assert.strictEqual(configManager.config.serverEnvVars[key], value,
                        `serverEnvVars["${key}"] should be "${value}" without validation error`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });

        it('--model-env with arbitrary value content (special chars, unicode) is accepted', async function () {
            this.timeout(FAST_PROPERTY_CONFIG.timeout);

            await fc.assert(fc.asyncProperty(
                arbValidFormatEnvVar,
                async (envEntry) => {
                    const mockGenerator = createMockGenerator({
                        'model-env': [envEntry]
                    });

                    // Should not throw — format is valid (contains =)
                    const configManager = new ConfigManager(mockGenerator);
                    await configManager.loadConfiguration();

                    const key = envEntry.substring(0, envEntry.indexOf('='));
                    assert.ok(key in configManager.config.modelEnvVars,
                        `Key "${key}" should be present in modelEnvVars`);

                    return true;
                }
            ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
        });
    });
});

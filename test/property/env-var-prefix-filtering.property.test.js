// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Environment Variable Prefix Filtering Property-Based Tests
 *
 * Property 8: For any set of env vars and an engine prefix string, filtering
 * by prefix SHALL produce a result containing only variables whose key starts
 * with that prefix, plus `HF_TOKEN` (redacted) and `HF_MODEL_ID`. For http
 * architectures, filtering SHALL exclude system variables (`PATH`, `PYTHONPATH`,
 * `LANG`, etc.) and redact secrets (`HF_TOKEN`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_SESSION_TOKEN`).
 *
 * Feature: registry-to-server-migration, Property 8: Environment variable prefix filtering
 * Validates: Requirements 9.3, 9.4
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Constants (from do/register template) ────────────────────────────────────

const REDACTED = '***REDACTED***';

const SYSTEM_VARS = new Set([
    'PATH', 'PYTHONPATH', 'SAGEMAKER_BIND_TO_PORT', 'LANG', 'GPG_KEY',
    'PYTHON_VERSION', 'PYTHON_PIP_VERSION', 'PYTHON_SETUPTOOLS_VERSION',
    'PYTHON_GET_PIP_URL', 'PYTHON_GET_PIP_SHA256'
]);

const SECRET_VARS = new Set([
    'HF_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'
]);

// ── Filtering functions under test ───────────────────────────────────────────
// Extracted from the Python logic in templates/do/register

/**
 * Filter env vars for transformers/diffusors architectures.
 * Returns vars whose key starts with the given prefix, plus HF_TOKEN (redacted)
 * and HF_MODEL_ID (preserved as-is).
 */
function filterByEnginePrefix(envVars, prefix) {
    const result = {};
    for (const [key, value] of Object.entries(envVars)) {
        if (prefix && key.startsWith(prefix)) {
            result[key] = value;
        } else if (key === 'HF_TOKEN') {
            result[key] = REDACTED;
        } else if (key === 'HF_MODEL_ID') {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Filter env vars for http architectures.
 * Returns all vars except system vars, redacting secrets.
 */
function filterForHttp(envVars) {
    const result = {};
    for (const [key, value] of Object.entries(envVars)) {
        if (!SYSTEM_VARS.has(key)) {
            result[key] = SECRET_VARS.has(key) ? REDACTED : value;
        }
    }
    return result;
}

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/).filter(s => s.length >= 1);
const arbEnvValue = fc.stringMatching(/^[a-zA-Z0-9._/-]{0,30}$/);

const arbPrefix = fc.constantFrom('VLLM_', 'SGLANG_', 'TRTLLM_', 'LMI_', 'DJL_');

const arbEnvVarMap = fc.dictionary(arbEnvKey, arbEnvValue);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: registry-to-server-migration, Property 8: Environment variable prefix filtering', () => {

    describe('transformers/diffusors prefix filtering', () => {

        it('only vars starting with the prefix are included (plus HF_TOKEN and HF_MODEL_ID)', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvVarMap,
                arbPrefix,
                (envVars, prefix) => {
                    const result = filterByEnginePrefix(envVars, prefix);

                    for (const key of Object.keys(result)) {
                        const isPrefix = key.startsWith(prefix);
                        const isHfToken = key === 'HF_TOKEN';
                        const isHfModelId = key === 'HF_MODEL_ID';

                        assert.ok(isPrefix || isHfToken || isHfModelId,
                            `key "${key}" must start with "${prefix}" or be HF_TOKEN/HF_MODEL_ID`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('HF_TOKEN is always redacted to "***REDACTED***"', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvVarMap,
                arbPrefix,
                arbEnvValue,
                (envVars, prefix, tokenValue) => {
                    const withToken = { ...envVars, HF_TOKEN: tokenValue };
                    const result = filterByEnginePrefix(withToken, prefix);

                    assert.ok('HF_TOKEN' in result,
                        'HF_TOKEN must always be present in result');
                    assert.strictEqual(result.HF_TOKEN, REDACTED,
                        `HF_TOKEN must be redacted to "${REDACTED}", got "${result.HF_TOKEN}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('HF_MODEL_ID value is preserved as-is', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvVarMap,
                arbPrefix,
                arbEnvValue,
                (envVars, prefix, modelIdValue) => {
                    const withModelId = { ...envVars, HF_MODEL_ID: modelIdValue };
                    const result = filterByEnginePrefix(withModelId, prefix);

                    assert.ok('HF_MODEL_ID' in result,
                        'HF_MODEL_ID must always be present in result');
                    assert.strictEqual(result.HF_MODEL_ID, modelIdValue,
                        `HF_MODEL_ID must be preserved as-is, expected "${modelIdValue}", got "${result.HF_MODEL_ID}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('no other vars leak through the filter', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvVarMap,
                arbPrefix,
                (envVars, prefix) => {
                    const result = filterByEnginePrefix(envVars, prefix);

                    // Every key in the input that does NOT match prefix/HF_TOKEN/HF_MODEL_ID
                    // must NOT appear in the result
                    for (const key of Object.keys(envVars)) {
                        const shouldBeIncluded = key.startsWith(prefix) ||
                            key === 'HF_TOKEN' ||
                            key === 'HF_MODEL_ID';

                        if (!shouldBeIncluded) {
                            assert.ok(!(key in result),
                                `key "${key}" should not leak through the filter ` +
                                `(does not start with "${prefix}" and is not HF_TOKEN/HF_MODEL_ID)`);
                        }
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('http filtering', () => {

        it('system vars are always excluded', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvVarMap,
                (envVars) => {
                    // Ensure some system vars are present in input
                    const withSystemVars = {
                        ...envVars,
                        PATH: '/usr/bin',
                        PYTHONPATH: '/opt/python',
                        LANG: 'en_US.UTF-8'
                    };
                    const result = filterForHttp(withSystemVars);

                    for (const sysVar of SYSTEM_VARS) {
                        assert.ok(!(sysVar in result),
                            `system var "${sysVar}" must be excluded from http filtering result`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('secret vars are always redacted', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvVarMap,
                arbEnvValue,
                arbEnvValue,
                arbEnvValue,
                (envVars, tokenVal, secretKeyVal, sessionVal) => {
                    const withSecrets = {
                        ...envVars,
                        HF_TOKEN: tokenVal,
                        AWS_SECRET_ACCESS_KEY: secretKeyVal,
                        AWS_SESSION_TOKEN: sessionVal
                    };
                    const result = filterForHttp(withSecrets);

                    for (const secretVar of SECRET_VARS) {
                        assert.ok(secretVar in result,
                            `secret var "${secretVar}" must be present in result (redacted)`);
                        assert.strictEqual(result[secretVar], REDACTED,
                            `secret var "${secretVar}" must be redacted to "${REDACTED}", ` +
                            `got "${result[secretVar]}"`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('non-system, non-secret vars are preserved with original values', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbEnvVarMap,
                (envVars) => {
                    // Remove any system or secret vars from the input to isolate
                    const cleanEnvVars = { ...envVars };
                    for (const sysVar of SYSTEM_VARS) delete cleanEnvVars[sysVar];
                    for (const secretVar of SECRET_VARS) delete cleanEnvVars[secretVar];

                    const result = filterForHttp(cleanEnvVars);

                    for (const [key, value] of Object.entries(cleanEnvVars)) {
                        assert.ok(key in result,
                            `non-system, non-secret var "${key}" must be in result`);
                        assert.strictEqual(result[key], value,
                            `var "${key}" must preserve original value "${value}", got "${result[key]}"`);
                    }

                    // Result should have exactly the same keys as input
                    assert.strictEqual(Object.keys(result).length, Object.keys(cleanEnvVars).length,
                        'result should have same number of keys as clean input');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('empty env var sets produce empty results', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            const result = filterForHttp({});
            assert.deepStrictEqual(result, {},
                'filtering empty env vars must produce empty result');
        });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Env Var Filtering Property-Based Tests
 *
 * Property 15: Env var filtering for transformer deployments
 * Property 16: Env var filtering for http deployments
 *
 * Feature: deployment-registry
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { filterTransformerEnvVars, filterHttpEnvVars } from '../../src/lib/deployment-registry.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const ENGINE_PREFIXES = ['VLLM_', 'SGLANG_', 'TRTLLM_', 'LMI_', 'DJL_'];

const HTTP_SYSTEM_VARS = [
    'PATH',
    'PYTHONPATH',
    'SAGEMAKER_BIND_TO_PORT',
    'LANG',
    'GPG_KEY',
    'PYTHON_VERSION',
    'PYTHON_PIP_VERSION',
    'PYTHON_SETUPTOOLS_VERSION',
    'PYTHON_GET_PIP_URL',
    'PYTHON_GET_PIP_SHA256'
];

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random env var key that does NOT start with any engine prefix
 * and is not HF_TOKEN or HF_MODEL_ID or a system var.
 */
const arbRandomEnvKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,19}$/)
    .filter(s =>
        s.length >= 2 &&
        !ENGINE_PREFIXES.some(p => s.startsWith(p)) &&
        s !== 'HF_TOKEN' &&
        s !== 'HF_MODEL_ID' &&
        !HTTP_SYSTEM_VARS.includes(s)
    );

/**
 * Generate a random env var value.
 */
const arbEnvValue = fc.string({ minLength: 0, maxLength: 30 });

/**
 * Generate a prefixed env var key for a given engine prefix.
 */
const arbPrefixedKey = (prefix) =>
    fc.stringMatching(/^[A-Z0-9_]{1,15}$/)
        .filter(s => s.length >= 1)
        .map(suffix => `${prefix}${suffix}`);

/**
 * Generate a dictionary of env vars with a controlled mix:
 * - Some vars with the chosen engine prefix
 * - Optionally HF_TOKEN and HF_MODEL_ID
 * - Some random other vars
 */
const arbTransformerEnvVars = (prefix) =>
    fc.tuple(
        // Prefixed vars
        fc.array(
            fc.tuple(arbPrefixedKey(prefix), arbEnvValue),
            { minLength: 0, maxLength: 5 }
        ),
        // HF_TOKEN presence
        fc.boolean(),
        fc.tuple(fc.constant('HF_TOKEN'), arbEnvValue),
        // HF_MODEL_ID presence
        fc.boolean(),
        fc.tuple(fc.constant('HF_MODEL_ID'), arbEnvValue),
        // Random other vars (not prefixed, not HF_TOKEN/HF_MODEL_ID)
        fc.array(
            fc.tuple(arbRandomEnvKey, arbEnvValue),
            { minLength: 0, maxLength: 5 }
        )
    ).map(([prefixed, hasToken, tokenPair, hasModelId, modelIdPair, others]) => {
        const envVars = {};
        for (const [k, v] of prefixed) {
            envVars[k] = v;
        }
        if (hasToken) {
            envVars[tokenPair[0]] = tokenPair[1];
        }
        if (hasModelId) {
            envVars[modelIdPair[0]] = modelIdPair[1];
        }
        for (const [k, v] of others) {
            envVars[k] = v;
        }
        return envVars;
    });

/**
 * Generate a dictionary of env vars with a controlled mix for http filtering:
 * - Some system vars
 * - Some non-system vars
 */
const arbHttpEnvVars = fc.tuple(
    // System vars (subset present)
    fc.subarray(HTTP_SYSTEM_VARS, { minLength: 0 }),
    // Non-system vars
    fc.array(
        fc.tuple(arbRandomEnvKey, arbEnvValue),
        { minLength: 0, maxLength: 8 }
    )
).map(([systemKeys, others]) => {
    const envVars = {};
    for (const key of systemKeys) {
        envVars[key] = `/some/value/${key.toLowerCase()}`;
    }
    for (const [k, v] of others) {
        envVars[k] = v;
    }
    return envVars;
});

// ── Property 15: Env var filtering for transformer deployments ───────────────

describe('Feature: deployment-registry, Property 15: Env var filtering for transformer deployments', () => {

    /**
     * Validates: Requirements 12.2
     *
     * For any set of environment variable key-value pairs and any
     * transformer engine prefix, the filter function should return only
     * those vars whose key starts with the engine prefix, plus HF_TOKEN
     * and HF_MODEL_ID if present. No other vars should be included.
     */
    it('filterTransformerEnvVars returns only prefixed vars plus HF_TOKEN and HF_MODEL_ID', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            fc.constantFrom(...ENGINE_PREFIXES),
            fc.constantFrom(...ENGINE_PREFIXES).chain(prefix => arbTransformerEnvVars(prefix)),
            (prefix, envVars) => {
                const result = filterTransformerEnvVars(envVars, prefix);

                // Every key in the result must be prefixed or HF_TOKEN/HF_MODEL_ID
                for (const key of Object.keys(result)) {
                    const allowed = key.startsWith(prefix) ||
                        key === 'HF_TOKEN' ||
                        key === 'HF_MODEL_ID';
                    assert.ok(
                        allowed,
                        `Unexpected key "${key}" in result — should only include ${prefix}* or HF_TOKEN/HF_MODEL_ID`
                    );
                }

                // Every qualifying key from the input must be in the result
                for (const [key, value] of Object.entries(envVars)) {
                    const shouldInclude = key.startsWith(prefix) ||
                        key === 'HF_TOKEN' ||
                        key === 'HF_MODEL_ID';
                    if (shouldInclude) {
                        assert.strictEqual(
                            result[key],
                            value,
                            `Expected key "${key}" with value "${value}" in result`
                        );
                    } else {
                        assert.strictEqual(
                            result[key],
                            undefined,
                            `Key "${key}" should not be in result`
                        );
                    }
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 16: Env var filtering for http deployments ──────────────────────

describe('Feature: deployment-registry, Property 16: Env var filtering for http deployments', () => {

    /**
     * Validates: Requirements 12.3
     *
     * For any set of environment variable key-value pairs, the http filter
     * function should return all vars except the defined system vars.
     */
    it('filterHttpEnvVars excludes exactly the system vars and keeps everything else', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const systemVarSet = new Set(HTTP_SYSTEM_VARS);

        fc.assert(fc.property(
            arbHttpEnvVars,
            (envVars) => {
                const result = filterHttpEnvVars(envVars);

                // No system var should be in the result
                for (const sysVar of HTTP_SYSTEM_VARS) {
                    assert.strictEqual(
                        result[sysVar],
                        undefined,
                        `System var "${sysVar}" should be excluded from result`
                    );
                }

                // Every non-system var from input must be in the result
                for (const [key, value] of Object.entries(envVars)) {
                    if (!systemVarSet.has(key)) {
                        assert.strictEqual(
                            result[key],
                            value,
                            `Non-system var "${key}" should be in result with value "${value}"`
                        );
                    }
                }

                // No extra keys should appear in the result
                for (const key of Object.keys(result)) {
                    assert.ok(
                        key in envVars,
                        `Unexpected key "${key}" in result that was not in input`
                    );
                }

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

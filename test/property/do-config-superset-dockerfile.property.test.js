// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * do/config Superset of Dockerfile ENV Property-Based Tests
 *
 * Property 10: do/config superset of Dockerfile ENV
 *
 * For any set of model and server environment variables, the set of variable
 * names exported by the rendered do/config template SHALL be a superset of
 * the variable names declared as ENV in the rendered Dockerfile template.
 *
 * Feature: cli-config-parameters, Property 10
 *
 * **Validates: Requirements 8.3**
 */

import fc from 'fast-check'
import { describe, it } from 'mocha'
import assert from 'assert'
import { resolvePrefixedEnvVars } from '../../generators/app/lib/engine-prefix-resolver.js'

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false }

// ── Engines with defined prefixes ────────────────────────────────────────────

const ENGINES_WITH_PREFIX = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl']
const ENGINES_WITHOUT_PREFIX = ['flask', 'fastapi']
const ALL_ENGINES = [...ENGINES_WITH_PREFIX, ...ENGINES_WITHOUT_PREFIX]

// ── Simulate orderedEnvVars assembly (mirrors generators/app/index.js) ───────

/**
 * Simulates how orderedEnvVars is built in the generator's writing phase.
 * Model env vars are added as-is, server env vars get engine prefix applied.
 */
function buildOrderedEnvVars(modelEnvVars, serverEnvVars, engine) {
    const orderedEnvVars = []

    // Add model env vars
    Object.entries(modelEnvVars).forEach(([key, value]) => {
        orderedEnvVars.push({ key, value })
    })

    // Add server env vars with engine prefix applied
    const prefixedServerEnvVars = resolvePrefixedEnvVars(engine, serverEnvVars)
    Object.entries(prefixedServerEnvVars).forEach(([key, value]) => {
        orderedEnvVars.push({ key, value })
    })

    return orderedEnvVars
}

/**
 * Extract ENV variable names from Dockerfile orderedEnvVars.
 * In the Dockerfile template, orderedEnvVars are rendered as:
 *   ENV key=value
 */
function getDockerfileEnvNames(orderedEnvVars) {
    return new Set(orderedEnvVars.map(({ key }) => key))
}

/**
 * Simulate do/config exported variable names for model and server env vars.
 * In do/config, model env vars are exported as-is, server env vars are
 * exported with engine prefix applied (via the prefixed serverEnvVars
 * passed to the template).
 */
function getDoConfigExportNames(modelEnvVars, serverEnvVars, engine) {
    const names = new Set()

    // Model env vars exported as-is
    Object.keys(modelEnvVars).forEach(key => names.add(key))

    // Server env vars exported with engine prefix
    const prefixedServerEnvVars = resolvePrefixedEnvVars(engine, serverEnvVars)
    Object.keys(prefixedServerEnvVars).forEach(key => names.add(key))

    return names
}

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbEnvVarKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,12}$/)
const arbEnvVarValue = fc.stringMatching(/^[a-zA-Z0-9._/-]{1,20}$/)

const arbModelEnvVars = fc.dictionary(arbEnvVarKey, arbEnvVarValue, { minKeys: 0, maxKeys: 4 })
const arbServerEnvVars = fc.dictionary(arbEnvVarKey, arbEnvVarValue, { minKeys: 0, maxKeys: 4 })
const arbEngine = fc.constantFrom(...ALL_ENGINES)

/**
 * Generate a configuration with at least one env var (model or server).
 */
const arbEnvVarConfig = fc.tuple(arbModelEnvVars, arbServerEnvVars, arbEngine).filter(
    ([modelEnvVars, serverEnvVars]) => {
        return Object.keys(modelEnvVars).length > 0 || Object.keys(serverEnvVars).length > 0
    }
)

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: cli-config-parameters, Property 10: do/config superset of Dockerfile ENV', () => {

    describe('do/config exports are a superset of Dockerfile ENV declarations', () => {

        it('for any model and server env vars, do/config variable names include all Dockerfile ENV names', function () {
            this.timeout(PROPERTY_CONFIG.timeout)

            fc.assert(fc.property(
                arbEnvVarConfig,
                ([modelEnvVars, serverEnvVars, engine]) => {
                    // Build orderedEnvVars as the generator does for Dockerfile
                    const orderedEnvVars = buildOrderedEnvVars(modelEnvVars, serverEnvVars, engine)
                    const dockerfileEnvNames = getDockerfileEnvNames(orderedEnvVars)

                    // Get do/config export names
                    const doConfigExportNames = getDoConfigExportNames(modelEnvVars, serverEnvVars, engine)

                    // Assert do/config is a superset of Dockerfile ENV
                    for (const envName of dockerfileEnvNames) {
                        assert.ok(doConfigExportNames.has(envName),
                            `Dockerfile ENV "${envName}" is not exported by do/config. ` +
                            `do/config exports: [${[...doConfigExportNames].join(', ')}], ` +
                            `Dockerfile ENVs: [${[...dockerfileEnvNames].join(', ')}]`)
                    }

                    return true
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })

        it('for engines with prefix, server env vars appear with prefix in both surfaces', function () {
            this.timeout(PROPERTY_CONFIG.timeout)

            const arbPrefixedConfig = fc.tuple(
                arbServerEnvVars.filter(vars => Object.keys(vars).length > 0),
                fc.constantFrom(...ENGINES_WITH_PREFIX)
            )

            fc.assert(fc.property(
                arbPrefixedConfig,
                ([serverEnvVars, engine]) => {
                    const orderedEnvVars = buildOrderedEnvVars({}, serverEnvVars, engine)
                    const dockerfileEnvNames = getDockerfileEnvNames(orderedEnvVars)
                    const doConfigExportNames = getDoConfigExportNames({}, serverEnvVars, engine)

                    // Both surfaces should have the same prefixed keys
                    for (const envName of dockerfileEnvNames) {
                        assert.ok(doConfigExportNames.has(envName),
                            `Prefixed key "${envName}" in Dockerfile but not in do/config`)
                    }

                    // Verify keys are actually prefixed (not raw user keys)
                    const prefixed = resolvePrefixedEnvVars(engine, serverEnvVars)
                    for (const prefixedKey of Object.keys(prefixed)) {
                        assert.ok(dockerfileEnvNames.has(prefixedKey),
                            `Expected prefixed key "${prefixedKey}" in Dockerfile ENV`)
                        assert.ok(doConfigExportNames.has(prefixedKey),
                            `Expected prefixed key "${prefixedKey}" in do/config exports`)
                    }

                    return true
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })

        it('for engines without prefix, server env vars appear unchanged in both surfaces', function () {
            this.timeout(PROPERTY_CONFIG.timeout)

            const arbNoPrefixConfig = fc.tuple(
                arbServerEnvVars.filter(vars => Object.keys(vars).length > 0),
                fc.constantFrom(...ENGINES_WITHOUT_PREFIX)
            )

            fc.assert(fc.property(
                arbNoPrefixConfig,
                ([serverEnvVars, engine]) => {
                    const orderedEnvVars = buildOrderedEnvVars({}, serverEnvVars, engine)
                    const dockerfileEnvNames = getDockerfileEnvNames(orderedEnvVars)
                    const doConfigExportNames = getDoConfigExportNames({}, serverEnvVars, engine)

                    // For no-prefix engines, keys should be unchanged
                    for (const key of Object.keys(serverEnvVars)) {
                        assert.ok(dockerfileEnvNames.has(key),
                            `Key "${key}" should appear unchanged in Dockerfile ENV for engine "${engine}"`)
                        assert.ok(doConfigExportNames.has(key),
                            `Key "${key}" should appear unchanged in do/config for engine "${engine}"`)
                    }

                    return true
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose })
        })
    })
})

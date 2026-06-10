// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap CI Singleton Property-Based Tests
 *
 * Property 2: CI Singleton
 *
 * At most one profile across all profiles in config has `ciInfraProvisioned: true`.
 * The `_findExistingCiProfile()` check runs before any CI deployment.
 *
 * Feature: multi-region-bootstrap, Property 2: CI Singleton
 *
 * Validates: Requirements 4.1, 4.2
 */

import fc from 'fast-check'
import { describe, it, beforeEach, afterEach } from 'mocha'
import assert from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js'
import BootstrapConfig from '../../src/lib/bootstrap-config.js'

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid profile name (alphanumeric with hyphens, starting with a letter).
 */
const arbProfileName = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
    .filter(s => s.length >= 2 && !s.endsWith('-'))

/**
 * Generate a valid AWS region.
 */
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1',
    'ap-northeast-1', 'eu-central-1', 'sa-east-1'
)

/**
 * Generate a valid 12-digit AWS account ID.
 */
const arbAccountId = fc.stringMatching(/^[0-9]{12}$/)

/**
 * Generate a profile config object with configurable CI state.
 */
function makeProfileConfig(region, accountId, ciProvisioned) {
    return {
        awsProfile: 'test-aws-profile',
        awsRegion: region,
        accountId: accountId,
        stackName: 'mlcc-bootstrap-profile',
        roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
        ecrRepositoryName: 'ml-container-creator',
        ciInfraProvisioned: ciProvisioned,
        ciTableName: 'mlcc-ci-table'
    }
}

/**
 * Generate a random config with 1-5 profiles, where at most one has CI provisioned.
 * Returns { profiles, ciProfileName, accountId, region }.
 */
const arbExistingConfig = fc.tuple(
    fc.array(arbProfileName, { minLength: 1, maxLength: 5 }),
    arbAwsRegion,
    arbAccountId
).chain(([names, region, accountId]) => {
    const uniqueNames = [...new Set(names)]
    if (uniqueNames.length === 0) return fc.constant({ profiles: {}, ciProfileName: null, accountId, region })

    return fc.option(fc.constantFrom(...uniqueNames), { nil: null }).map(ciName => {
        const profiles = {}
        for (const name of uniqueNames) {
            profiles[name] = makeProfileConfig(region, accountId, name === ciName)
        }
        return { profiles, ciProfileName: ciName, accountId, region }
    })
})

/**
 * Generate a random config with multiple profiles where MULTIPLE may have CI provisioned
 * (an invalid state). This tests that `_findExistingCiProfile` still detects at least one.
 */
const arbConfigWithMultipleCi = fc.tuple(
    fc.array(arbProfileName, { minLength: 2, maxLength: 5 }),
    arbAwsRegion,
    arbAccountId
).chain(([names, region, accountId]) => {
    const uniqueNames = [...new Set(names)]
    if (uniqueNames.length < 2) return fc.constant(null)

    // Randomly assign CI to 2+ profiles (invalid state we're checking enforcement against)
    return fc.subarray(uniqueNames, { minLength: 2 }).map(ciNames => {
        const profiles = {}
        for (const name of uniqueNames) {
            profiles[name] = makeProfileConfig(region, accountId, ciNames.includes(name))
        }
        return { profiles, ciNames, accountId, region }
    })
}).filter(v => v !== null)

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Count profiles with ciInfraProvisioned === true.
 */
function countCiProfiles(config) {
    if (!config || !config.profiles) return 0
    return Object.values(config.profiles).filter(p => p.ciInfraProvisioned === true).length
}

/**
 * Create a BootstrapCommandHandler with the given config path.
 */
function createHandler(configPath) {
    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) })
    handler.config = new BootstrapConfig(configPath)
    return handler
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: multi-region-bootstrap, Property 2: CI Singleton', () => {

    let tmpDir

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-ci-singleton-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        mkdirSync(tmpDir, { recursive: true })
    })

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true })
    })

    /**
     * Validates: Requirements 4.1, 4.2
     *
     * _findExistingCiProfile correctly detects when another profile already has
     * CI provisioned, blocking a second profile from deploying CI.
     * For any config where one profile has CI, attempting to deploy CI from
     * any OTHER profile is detected and blocked.
     */
    it('_findExistingCiProfile detects existing CI and blocks new CI deployment', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        fc.assert(fc.property(
            arbExistingConfig,
            arbProfileName,
            ({ profiles, ciProfileName, accountId, region }, newProfileName) => {
                // Ensure the new profile name doesn't collide with existing ones
                if (profiles[newProfileName]) return true

                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)
                const handler = createHandler(configPath)

                // Write initial config with existing profiles
                handler.config.write({
                    activeProfile: Object.keys(profiles)[0] || newProfileName,
                    profiles
                })

                // Call _findExistingCiProfile for the new profile
                const ciConflict = handler._findExistingCiProfile(newProfileName)

                if (ciProfileName) {
                    // CI exists in another profile — enforcement must detect it
                    assert.ok(ciConflict, 'Should detect existing CI profile')
                    assert.strictEqual(ciConflict.name, ciProfileName)
                    assert.strictEqual(ciConflict.config.ciInfraProvisioned, true)
                } else {
                    // No CI anywhere — should allow deployment
                    assert.strictEqual(ciConflict, null, 'Should not detect CI conflict when none exists')
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })

    /**
     * Validates: Requirements 4.1, 4.2
     *
     * The CI singleton enforcement guarantees that after the check-and-set pattern
     * (check via _findExistingCiProfile, then set ciInfraProvisioned if allowed),
     * at most one profile has ciInfraProvisioned: true.
     *
     * Simulates the CI deployment flow: for a new profile requesting CI,
     * if _findExistingCiProfile returns null (no conflict), the profile gets CI.
     * The resulting config must still have at most one CI profile.
     */
    it('check-and-set pattern ensures at most one CI profile across all configs', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        fc.assert(fc.property(
            arbExistingConfig,
            arbProfileName,
            arbAwsRegion,
            ({ profiles, ciProfileName, accountId, region }, newProfileName, newRegion) => {
                // Ensure the new profile name doesn't collide
                if (profiles[newProfileName]) return true

                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)
                const handler = createHandler(configPath)

                // Write initial config
                handler.config.write({
                    activeProfile: Object.keys(profiles)[0] || newProfileName,
                    profiles
                })

                // Simulate the CI deployment flow:
                // 1. Check for existing CI
                const ciConflict = handler._findExistingCiProfile(newProfileName)

                // 2. Only set CI on the new profile if no conflict
                const newProfileConfig = makeProfileConfig(
                    newRegion,
                    accountId || '123456789012',
                    ciConflict === null // CI is provisioned only if no conflict
                )

                // 3. Save the new profile
                const config = handler.config.read()
                config.profiles[newProfileName] = newProfileConfig
                handler.config.write(config)

                // THE INVARIANT: at most one profile has ciInfraProvisioned: true
                const finalConfig = handler.config.read()
                const ciCount = countCiProfiles(finalConfig)
                assert.ok(
                    ciCount <= 1,
                    `CI singleton violated: ${ciCount} profiles have ciInfraProvisioned: true ` +
                    `(profiles: ${JSON.stringify(Object.entries(finalConfig.profiles).filter(([, p]) => p.ciInfraProvisioned).map(([n]) => n))})`
                )
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })

    /**
     * Validates: Requirements 4.1, 4.2
     *
     * _findExistingCiProfile excludes the specified profile from its search,
     * ensuring a profile doesn't block itself from CI operations (e.g., updates).
     */
    it('_findExistingCiProfile excludes the specified profile from detection', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        fc.assert(fc.property(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            (profileName, region, accountId) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)
                const handler = createHandler(configPath)

                // Write config where the target profile itself has CI
                const profiles = {}
                profiles[profileName] = makeProfileConfig(region, accountId, true)

                handler.config.write({
                    activeProfile: profileName,
                    profiles
                })

                // _findExistingCiProfile should NOT find the excluded profile
                const result = handler._findExistingCiProfile(profileName)
                assert.strictEqual(
                    result,
                    null,
                    `Should not detect CI conflict for the excluded profile "${profileName}" itself`
                )
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })

    /**
     * Validates: Requirements 4.1, 4.2
     *
     * Even with an arbitrarily corrupted config (multiple profiles with CI set to true),
     * _findExistingCiProfile always returns one of the CI profiles (not null), ensuring
     * enforcement always triggers when CI exists elsewhere.
     */
    it('_findExistingCiProfile always detects at least one CI profile in multi-CI configs', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        fc.assert(fc.property(
            arbConfigWithMultipleCi,
            arbProfileName,
            (configData, queryProfile) => {
                if (!configData) return true
                const { profiles, ciNames } = configData

                // Ensure query profile is not in existing profiles
                if (profiles[queryProfile]) return true

                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)
                const handler = createHandler(configPath)

                handler.config.write({
                    activeProfile: Object.keys(profiles)[0],
                    profiles
                })

                // Even with multiple CI profiles (invalid state), enforcement detects it
                const result = handler._findExistingCiProfile(queryProfile)
                assert.ok(
                    result !== null,
                    'Should detect at least one CI profile when multiple exist'
                )
                assert.strictEqual(
                    result.config.ciInfraProvisioned,
                    true,
                    'Detected profile must have ciInfraProvisioned: true'
                )
                assert.ok(
                    ciNames.includes(result.name),
                    `Detected profile "${result.name}" should be one of the CI profiles: ${ciNames.join(', ')}`
                )
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })
})

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Migrate Idempotent Property-Based Tests
 *
 * Property 5: Idempotent Migration
 *
 * Running `bootstrap migrate` multiple times produces the same result
 * (no additional changes after first run). After the first confirmed migration,
 * a second run should detect no changes and exit early with a success message.
 *
 * Feature: multi-region-bootstrap, Property 5: Idempotent Migration
 *
 * Validates: Requirements 6.5
 */

import fc from 'fast-check'
import { describe, it, beforeEach, afterEach } from 'mocha'
import assert from 'node:assert'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js'
import BootstrapConfig from '../../src/lib/bootstrap-config.js'

const STACK_NAME_PREFIX = 'mlcc-bootstrap'

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
 * Generate a random stack name that does NOT match the expected pattern for a profile.
 * This simulates legacy profiles with mismatched stack names.
 */
const arbLegacyStackName = fc.stringMatching(/^[a-z][a-z0-9-]{3,30}$/)
    .filter(s => !s.endsWith('-'))
    .map(s => `mlcc-bootstrap-${s}`)

/**
 * Generate profile config that may need migration.
 * Randomly includes stackName mismatches and/or legacy sharedStackFrom fields.
 */
function arbProfileConfig(profileName, region, accountId) {
    return fc.record({
        hasStackNameMismatch: fc.boolean(),
        hasSharedStackFrom: fc.boolean(),
        legacyStackName: arbLegacyStackName
    }).map(({ hasStackNameMismatch, hasSharedStackFrom, legacyStackName }) => {
        const expectedStackName = `${STACK_NAME_PREFIX}-${profileName}`
        const config = {
            awsProfile: 'test-profile',
            awsRegion: region,
            accountId: accountId,
            stackName: hasStackNameMismatch ? legacyStackName : expectedStackName,
            roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
            ecrRepositoryName: 'ml-container-creator',
            ciInfraProvisioned: false
        }

        if (hasSharedStackFrom) {
            config.sharedStackFrom = `mlcc-bootstrap-other-profile`
        }

        return config
    })
}

/**
 * Generate a config with 1-4 profiles, some of which may need migration.
 */
const arbConfigWithProfiles = fc.tuple(
    fc.array(arbProfileName, { minLength: 1, maxLength: 4 }),
    arbAwsRegion,
    arbAccountId
).chain(([names, region, accountId]) => {
    // Deduplicate names
    const uniqueNames = [...new Set(names)]
    if (uniqueNames.length === 0) return fc.constant(null)

    const profileArbs = uniqueNames.map(name =>
        arbProfileConfig(name, region, accountId).map(config => [name, config])
    )

    return fc.tuple(...profileArbs).map(entries => {
        const profiles = {}
        for (const [name, config] of entries) {
            profiles[name] = config
        }
        return {
            activeProfile: uniqueNames[0],
            profiles
        }
    })
}).filter(config => config !== null)

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Suppress console.log during test execution and capture output.
 */
async function captureConsoleLog(fn) {
    const captured = []
    const originalLog = console.log
    console.log = (...args) => {
        captured.push(args.join(' '))
    }
    try {
        await fn()
    } finally {
        console.log = originalLog
    }
    return captured
}

/**
 * Create a BootstrapCommandHandler with a mocked prompt function
 * that always confirms migration.
 */
function createHandler(configPath) {
    const handler = new BootstrapCommandHandler({
        promptFn: async () => ({ confirm: true })
    })
    handler.config = new BootstrapConfig(configPath)
    return handler
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: multi-region-bootstrap, Property 5: Idempotent Migration', () => {

    let tmpDir

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        mkdirSync(tmpDir, { recursive: true })
    })

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true })
    })

    /**
     * Validates: Requirements 6.5
     *
     * After running _handleMigrate once (with confirmation), running it a second time
     * should detect no changes and exit early with the success message
     * "✅ All profiles already use current naming conventions."
     */
    it('second migration run detects no changes after first run applies fixes', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        await fc.assert(fc.asyncProperty(
            arbConfigWithProfiles,
            async (initialConfig) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)
                const bootstrapConfig = new BootstrapConfig(configPath)

                // Write initial config (may contain legacy fields needing migration)
                bootstrapConfig.write(initialConfig)

                const handler = createHandler(configPath)

                // First migration run — applies changes if needed
                await captureConsoleLog(async () => {
                    await handler._handleMigrate()
                })

                // Read config state after first migration
                const configAfterFirst = JSON.parse(readFileSync(configPath, 'utf8'))

                // Second migration run — should detect no changes
                const secondRunLogs = await captureConsoleLog(async () => {
                    await handler._handleMigrate()
                })

                // Read config state after second migration
                const configAfterSecond = JSON.parse(readFileSync(configPath, 'utf8'))

                // PROPERTY: Config after second run is identical to config after first run
                assert.deepStrictEqual(
                    configAfterSecond,
                    configAfterFirst,
                    'Config should not change on second migration run'
                )

                // PROPERTY: Second run should report no changes needed
                const secondOutput = secondRunLogs.join('\n')
                assert.ok(
                    secondOutput.includes('All profiles already use current naming conventions'),
                    `Second migration run should report no changes needed, but got: "${secondOutput}"`
                )
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })

    /**
     * Validates: Requirements 6.5
     *
     * After migration, every profile's stackName matches mlcc-bootstrap-{profileName}
     * and no profile has a sharedStackFrom field (renamed to sharedInfraFrom).
     */
    it('after migration all profiles satisfy naming conventions', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        await fc.assert(fc.asyncProperty(
            arbConfigWithProfiles,
            async (initialConfig) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)
                const bootstrapConfig = new BootstrapConfig(configPath)

                // Write initial config
                bootstrapConfig.write(initialConfig)

                const handler = createHandler(configPath)

                // Run migration
                await captureConsoleLog(async () => {
                    await handler._handleMigrate()
                })

                // Read migrated config
                const migratedConfig = JSON.parse(readFileSync(configPath, 'utf8'))

                // PROPERTY: Every profile's stackName matches expected pattern
                for (const [name, profileConfig] of Object.entries(migratedConfig.profiles)) {
                    const expected = `${STACK_NAME_PREFIX}-${name}`
                    assert.strictEqual(
                        profileConfig.stackName,
                        expected,
                        `Profile "${name}" stackName should be "${expected}" but got "${profileConfig.stackName}"`
                    )

                    // PROPERTY: No profile has legacy sharedStackFrom field
                    assert.strictEqual(
                        profileConfig.sharedStackFrom,
                        undefined,
                        `Profile "${name}" should not have sharedStackFrom after migration`
                    )
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })
})

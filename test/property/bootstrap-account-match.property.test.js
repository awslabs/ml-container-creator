// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Account Match Property-Based Tests
 *
 * Property 3: Account Match
 *
 * `bootstrap update` never deploys to a different AWS account than what the profile specifies.
 * Verified via `sts get-caller-identity` at the start of `_handleUpdate()`.
 *
 * Feature: multi-region-bootstrap, Property 3: Account Match
 *
 * Validates: Requirements 5.1, 5.5
 */

import fc from 'fast-check'
import { describe, it, beforeEach, afterEach } from 'mocha'
import assert from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
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
 * Generate a pair of DIFFERENT 12-digit AWS account IDs.
 */
const arbMismatchedAccountIds = fc.tuple(arbAccountId, arbAccountId)
    .filter(([a, b]) => a !== b)

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Suppress console.log during test execution.
 */
async function suppressConsole(fn) {
    const originalLog = console.log
    console.log = () => {}
    try {
        return await fn()
    } finally {
        console.log = originalLog
    }
}

/**
 * Create a BootstrapCommandHandler with mocked dependencies for testing
 * account match enforcement.
 *
 * @param {string} configPath - Path to temp config file
 * @param {object} opts - Options controlling the mock behavior
 * @param {string} opts.callerAccount - Account returned by _getCallerAccount (simulating STS)
 * @param {boolean} opts.stackExists - Whether the target stack exists
 * @returns {{ handler: BootstrapCommandHandler, deployAttempted: boolean }}
 */
function createMockHandler(configPath, { callerAccount, stackExists }) {
    const state = { deployAttempted: false }

    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) })
    handler.config = new BootstrapConfig(configPath)

    // Mock _getCallerAccount to return the specified caller account
    handler._getCallerAccount = () => callerAccount

    // Mock _resourceExists to control whether the stack is found
    handler._resourceExists = () => stackExists

    // Mock _deployStack to track whether deployment was attempted
    handler._deployStack = () => {
        state.deployAttempted = true
        return {
            RoleArn: `arn:aws:iam::${callerAccount}:role/mlcc-sagemaker-execution-role`,
            EcrRepositoryName: 'ml-container-creator',
            AsyncS3BucketName: `mlcc-async-${callerAccount}-us-east-1`,
            BatchS3BucketName: `mlcc-batch-${callerAccount}-us-east-1`
        }
    }

    // Mock _displayProgress
    handler._displayProgress = () => {}

    // Mock _ensureMlflowApp
    handler._ensureMlflowApp = () => null

    // Mock _runPostSetupChain
    handler._runPostSetupChain = async () => {}

    return { handler, state }
}

/**
 * Write a config with a single active profile.
 */
function writeProfileConfig(handler, profileName, accountId, region) {
    handler.config.write({
        activeProfile: profileName,
        profiles: {
            [profileName]: {
                awsProfile: 'test-aws-profile',
                awsRegion: region,
                accountId: accountId,
                stackName: `${STACK_NAME_PREFIX}-${profileName}`,
                roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
                ecrRepositoryName: 'ml-container-creator',
                asyncS3Bucket: `mlcc-async-${accountId}-${region}`,
                batchS3Bucket: `mlcc-batch-${accountId}-${region}`,
                ciInfraProvisioned: false,
                ciTableName: 'mlcc-ci-table'
            }
        }
    })
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: multi-region-bootstrap, Property 3: Account Match', () => {

    let tmpDir

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-account-match-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        mkdirSync(tmpDir, { recursive: true })
    })

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true })
    })

    /**
     * Validates: Requirements 5.1, 5.5
     *
     * When the caller account (from STS) does NOT match the profile's accountId,
     * _handleUpdate must NOT attempt deployment. This ensures bootstrap update
     * never deploys to a different AWS account than what the profile specifies.
     */
    it('_handleUpdate never deploys when caller account differs from profile account', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbMismatchedAccountIds,
            arbAwsRegion,
            async (profileName, [profileAccount, callerAccount], region) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)

                const { handler, state } = createMockHandler(configPath, {
                    callerAccount,
                    stackExists: true
                })

                // Write config with the profile's account (different from caller)
                writeProfileConfig(handler, profileName, profileAccount, region)

                await suppressConsole(async () => {
                    await handler._handleUpdate()
                })

                // THE PROPERTY: deployment must NOT be attempted on account mismatch
                assert.strictEqual(
                    state.deployAttempted,
                    false,
                    `Deployment was attempted despite account mismatch: ` +
                    `profile="${profileAccount}" caller="${callerAccount}"`
                )
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })

    /**
     * Validates: Requirements 5.1, 5.5
     *
     * When the caller account matches the profile's accountId AND the stack exists,
     * _handleUpdate proceeds with deployment. This confirms the check allows
     * legitimate updates through.
     */
    it('_handleUpdate proceeds with deployment when caller account matches profile account', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAccountId,
            arbAwsRegion,
            async (profileName, accountId, region) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)

                const { handler, state } = createMockHandler(configPath, {
                    callerAccount: accountId, // matches profile
                    stackExists: true
                })

                // Write config with same account as caller
                writeProfileConfig(handler, profileName, accountId, region)

                await suppressConsole(async () => {
                    await handler._handleUpdate()
                })

                // THE PROPERTY: deployment IS attempted when accounts match
                assert.strictEqual(
                    state.deployAttempted,
                    true,
                    `Deployment was NOT attempted despite account match: accountId="${accountId}"`
                )
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })

    /**
     * Validates: Requirements 5.1, 5.5
     *
     * The account match check halts execution immediately — no stack existence
     * check or CI enforcement should run if the account mismatches. We verify
     * that _resourceExists is never called when accounts differ.
     */
    it('account mismatch halts before any resource checks', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout)

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbMismatchedAccountIds,
            arbAwsRegion,
            async (profileName, [profileAccount, callerAccount], region) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`)
                let resourceCheckCalled = false

                const { handler } = createMockHandler(configPath, {
                    callerAccount,
                    stackExists: true
                })

                // Override _resourceExists to track if it's called
                handler._resourceExists = () => {
                    resourceCheckCalled = true
                    return true
                }

                writeProfileConfig(handler, profileName, profileAccount, region)

                await suppressConsole(async () => {
                    await handler._handleUpdate()
                })

                // THE PROPERTY: resource checks should NOT run on account mismatch
                assert.strictEqual(
                    resourceCheckCalled,
                    false,
                    `_resourceExists was called despite account mismatch: ` +
                    `profile="${profileAccount}" caller="${callerAccount}"`
                )
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose })
    })
})

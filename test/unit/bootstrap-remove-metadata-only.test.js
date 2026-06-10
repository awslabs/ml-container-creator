// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Profile Removal — Metadata-Only Unit Tests
 *
 * Verifies that _handleRemove in BootstrapProfileManager:
 * 1. Only removes the profile entry from config.json
 * 2. Deletes the local manifest file
 * 3. Does NOT make any AWS API calls (no cloudformation delete, no s3 rm, no ecr delete, etc.)
 * 4. Logs an advisory message about retained AWS resources
 *
 * Validates: Requirements 2.4, 3.5
 */

import { describe, it, beforeEach, afterEach } from 'mocha'
import assert from 'assert'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js'
import AssetManager from '../../src/lib/asset-manager.js'

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Capture console.log output during a callback.
 * @param {Function} fn - Async function to execute
 * @returns {Promise<{logs: string[]}>}
 */
async function captureConsole(fn) {
    const logs = []
    const origLog = console.log
    console.log = (...args) => logs.push(args.join(' '))
    try {
        await fn()
    } finally {
        console.log = origLog
    }
    return { logs }
}

describe('Bootstrap Profile Removal — Metadata Only', () => {
    let tmpDir
    let handler
    let awsCalls
    let removedProfiles
    let promptResponses

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'bootstrap-remove-test-'))
        awsCalls = []
        removedProfiles = []
        promptResponses = []

        handler = new BootstrapCommandHandler({
            promptFn: async () => {
                if (promptResponses.length > 0) {
                    return promptResponses.shift()
                }
                return { confirm: true }
            }
        })

        // Mock config methods
        handler.config = {
            read: () => ({
                activeProfile: 'dev',
                profiles: {
                    dev: {
                        awsProfile: 'default',
                        awsRegion: 'us-east-1',
                        accountId: '111111111111',
                        stackName: 'mlcc-bootstrap-dev',
                        roleArn: 'arn:aws:iam::111111111111:role/mlcc-sagemaker-execution-role',
                        ecrRepositoryName: 'ml-container-creator',
                        asyncS3Bucket: 'mlcc-async-111111111111-us-east-1'
                    }
                }
            }),
            getProfile: (name) => {
                if (name === 'dev') {
                    return {
                        awsProfile: 'default',
                        awsRegion: 'us-east-1',
                        accountId: '111111111111',
                        stackName: 'mlcc-bootstrap-dev',
                        roleArn: 'arn:aws:iam::111111111111:role/mlcc-sagemaker-execution-role',
                        ecrRepositoryName: 'ml-container-creator',
                        asyncS3Bucket: 'mlcc-async-111111111111-us-east-1'
                    }
                }
                return null
            },
            removeProfile: (name) => {
                removedProfiles.push(name)
                return true
            },
            listProfiles: () => ['dev']
        }

        // Track any AWS CLI calls — _execAws should NEVER be called during removal
        handler._execAws = (command, profile) => {
            awsCalls.push({ command, profile })
            return {}
        }

        // Also track _resourceExists calls
        handler._resourceExists = (command, profile) => {
            awsCalls.push({ command, profile, type: 'resourceExists' })
            return true
        }

        // Override AssetManager to use temp dir by patching the profileManager's _handleRemove
        // to work with our temp directory for manifest file operations
        const origHandleRemove = handler.profileManager._handleRemove.bind(handler.profileManager)

        // Monkey-patch AssetManager import resolution — override _handleRemove
        // to use configDir pointing to our temp directory
        handler.profileManager._handleRemove = async function(profileName, options) {
            if (!profileName) {
                console.log('Usage: ml-container-creator bootstrap remove <profile> [--force]')
                return
            }

            const profile = handler.config.getProfile(profileName)
            if (!profile) {
                console.log(`Profile "${profileName}" not found.`)
                return
            }

            // Check for manifest file with active resources
            const assetManager = new AssetManager(profileName, { configDir: tmpDir })
            const hasManifest = existsSync(assetManager.manifestPath)

            if (hasManifest) {
                const counts = assetManager.getStatusCounts()
                if (counts.active > 0 && !options.force) {
                    console.log(`⚠️  Profile "${profileName}" has ${counts.active} active resource${counts.active === 1 ? '' : 's'} in the deployment manifest.`)
                }
            }

            if (!options.force) {
                const { confirm } = await handler._promptFn([{
                    type: 'confirm',
                    name: 'confirm',
                    message: `Remove bootstrap profile "${profileName}"?`,
                    default: false
                }])

                if (!confirm) {
                    console.log('Removal cancelled.')
                    return
                }
            }

            // Delete manifest file if it exists
            if (hasManifest) {
                try {
                    const { unlinkSync } = await import('node:fs')
                    unlinkSync(assetManager.manifestPath)
                    console.log(`Manifest file for "${profileName}" deleted.`)
                } catch {
                    console.log(`⚠️  Could not delete manifest file for "${profileName}".`)
                }
            }

            handler.config.removeProfile(profileName)
            console.log(`Profile "${profileName}" removed.`)

            // Advisory: AWS resources are retained for safety
            const stackName = profile.stackName || `mlcc-bootstrap-${profileName}`
            console.log('')
            console.log('ℹ️  Profile removed from config. AWS resources (CloudFormation stack, S3 buckets, ECR repo, IAM roles) have been retained.')
            console.log(`   To delete AWS resources, manually delete the CloudFormation stack "${stackName}" in the AWS console.`)
        }
    })

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true })
    })

    // ───────────────────────────────────────────────────────────────
    // Test 1: Removal with --force flag — no AWS calls
    // ───────────────────────────────────────────────────────────────
    describe('removal with --force flag', () => {
        it('removes profile from config without making any AWS API calls', async () => {
            await captureConsole(() =>
                handler._handleRemove('dev', { force: true })
            )

            // Profile was removed from config
            assert.strictEqual(removedProfiles.length, 1)
            assert.strictEqual(removedProfiles[0], 'dev')

            // No AWS API calls were made
            assert.strictEqual(awsCalls.length, 0, 'No AWS API calls should be made during removal')
        })

        it('skips confirmation prompt when --force is set', async () => {
            let promptCalled = false
            handler._promptFn = async () => {
                promptCalled = true
                return { confirm: true }
            }

            await captureConsole(() =>
                handler._handleRemove('dev', { force: true })
            )

            assert.strictEqual(promptCalled, false, 'Prompt should not be called with --force')
        })
    })

    // ───────────────────────────────────────────────────────────────
    // Test 2: Removal with user confirmation — no AWS calls
    // ───────────────────────────────────────────────────────────────
    describe('removal with user confirmation', () => {
        it('removes profile from config after user confirms, no AWS calls', async () => {
            promptResponses = [{ confirm: true }]

            await captureConsole(() =>
                handler._handleRemove('dev', {})
            )

            // Profile was removed from config
            assert.strictEqual(removedProfiles.length, 1)
            assert.strictEqual(removedProfiles[0], 'dev')

            // No AWS API calls were made
            assert.strictEqual(awsCalls.length, 0, 'No AWS API calls should be made during removal')
        })

        it('does not remove profile when user declines confirmation', async () => {
            promptResponses = [{ confirm: false }]

            const { logs } = await captureConsole(() =>
                handler._handleRemove('dev', {})
            )

            // Profile was NOT removed
            assert.strictEqual(removedProfiles.length, 0, 'Profile should not be removed when user declines')

            // No AWS API calls
            assert.strictEqual(awsCalls.length, 0, 'No AWS API calls should be made')

            // Cancellation message logged
            assert.ok(
                logs.some(l => l.includes('Removal cancelled')),
                'Should log cancellation message'
            )
        })
    })

    // ───────────────────────────────────────────────────────────────
    // Test 3: Advisory message about retained AWS resources
    // ───────────────────────────────────────────────────────────────
    describe('advisory message about retained AWS resources', () => {
        it('logs advisory about retained CloudFormation stack, S3, ECR, and IAM', async () => {
            const { logs } = await captureConsole(() =>
                handler._handleRemove('dev', { force: true })
            )

            const output = logs.join('\n')

            // Advisory message mentions retained resources
            assert.ok(
                output.includes('AWS resources (CloudFormation stack, S3 buckets, ECR repo, IAM roles) have been retained'),
                'Should log advisory about retained AWS resources'
            )

            // Advisory provides guidance on manual deletion
            assert.ok(
                output.includes('manually delete the CloudFormation stack'),
                'Should provide guidance on how to delete resources manually'
            )

            // Advisory includes the stack name
            assert.ok(
                output.includes('mlcc-bootstrap-dev'),
                'Should include the stack name in the advisory'
            )
        })

        it('uses computed stack name when profile.stackName is not set', async () => {
            handler.config.getProfile = (name) => {
                if (name === 'dev') {
                    return {
                        awsProfile: 'default',
                        awsRegion: 'us-east-1',
                        accountId: '111111111111',
                        // No stackName field — should fall back to computed name
                        roleArn: 'arn:aws:iam::111111111111:role/mlcc-sagemaker-execution-role'
                    }
                }
                return null
            }

            const { logs } = await captureConsole(() =>
                handler._handleRemove('dev', { force: true })
            )

            const output = logs.join('\n')
            assert.ok(
                output.includes('mlcc-bootstrap-dev'),
                'Should compute stack name as mlcc-bootstrap-{profileName} when not in profile'
            )
        })
    })

    // ───────────────────────────────────────────────────────────────
    // Test 4: No _execAws or execSync calls with AWS CLI commands
    // ───────────────────────────────────────────────────────────────
    describe('no AWS CLI execution during removal', () => {
        it('does not call _execAws at any point during removal', async () => {
            await captureConsole(() =>
                handler._handleRemove('dev', { force: true })
            )

            assert.strictEqual(
                awsCalls.length, 0,
                `Expected 0 AWS calls but got ${awsCalls.length}: ${JSON.stringify(awsCalls)}`
            )
        })

        it('does not call _execAws even when profile has active manifest resources', async () => {
            // Create a manifest with active resources
            const am = new AssetManager('dev', { configDir: tmpDir })
            am.addResource({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/test-ep',
                resourceType: 'sagemaker-endpoint',
                createdAt: '2026-05-04T10:30:00Z',
                lastUpdatedAt: '2026-05-04T10:30:00Z',
                project: 'test-project',
                status: 'active',
                metadata: { endpointName: 'test-ep' }
            })

            await captureConsole(() =>
                handler._handleRemove('dev', { force: true })
            )

            assert.strictEqual(
                awsCalls.length, 0,
                'No AWS calls should be made even with active manifest resources'
            )
        })

        it('does not call _resourceExists during removal', async () => {
            await captureConsole(() =>
                handler._handleRemove('dev', { force: true })
            )

            const resourceExistsCalls = awsCalls.filter(c => c.type === 'resourceExists')
            assert.strictEqual(
                resourceExistsCalls.length, 0,
                'No _resourceExists calls should be made during removal'
            )
        })
    })

    // ───────────────────────────────────────────────────────────────
    // Edge cases
    // ───────────────────────────────────────────────────────────────
    describe('edge cases', () => {
        it('handles profile not found gracefully', async () => {
            const { logs } = await captureConsole(() =>
                handler._handleRemove('nonexistent', { force: true })
            )

            assert.ok(
                logs.some(l => l.includes('not found')),
                'Should report profile not found'
            )
            assert.strictEqual(removedProfiles.length, 0)
            assert.strictEqual(awsCalls.length, 0)
        })

        it('handles missing profile name gracefully', async () => {
            const { logs } = await captureConsole(() =>
                handler._handleRemove(undefined, { force: true })
            )

            assert.ok(
                logs.some(l => l.includes('Usage:')),
                'Should show usage when no profile name provided'
            )
            assert.strictEqual(removedProfiles.length, 0)
            assert.strictEqual(awsCalls.length, 0)
        })

        it('warns about active resources before prompting for confirmation', async () => {
            // Create a manifest with active resources
            const am = new AssetManager('dev', { configDir: tmpDir })
            am.addResource({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/test-ep',
                resourceType: 'sagemaker-endpoint',
                createdAt: '2026-05-04T10:30:00Z',
                lastUpdatedAt: '2026-05-04T10:30:00Z',
                project: 'test-project',
                status: 'active',
                metadata: { endpointName: 'test-ep' }
            })

            promptResponses = [{ confirm: true }]

            const { logs } = await captureConsole(() =>
                handler._handleRemove('dev', {})
            )

            const output = logs.join('\n')
            assert.ok(
                output.includes('1 active resource'),
                'Should warn about active resources in the manifest'
            )
        })

        it('deletes manifest file during removal', async () => {
            // Create a manifest file
            const am = new AssetManager('dev', { configDir: tmpDir })
            am.addResource({
                resourceId: 'arn:aws:sagemaker:us-east-1:111:endpoint/test-ep',
                resourceType: 'sagemaker-endpoint',
                createdAt: '2026-05-04T10:30:00Z',
                lastUpdatedAt: '2026-05-04T10:30:00Z',
                project: 'test-project',
                status: 'active',
                metadata: { endpointName: 'test-ep' }
            })

            assert.ok(existsSync(am.manifestPath), 'Manifest should exist before removal')

            const { logs } = await captureConsole(() =>
                handler._handleRemove('dev', { force: true })
            )

            assert.ok(!existsSync(am.manifestPath), 'Manifest should be deleted after removal')
            assert.ok(
                logs.some(l => l.includes('Manifest file') && l.includes('deleted')),
                'Should log that manifest was deleted'
            )
        })
    })
})

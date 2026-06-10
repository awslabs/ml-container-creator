// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for BootstrapCommandHandler._findExistingCiProfile()
 *
 * Tests the CI profile lookup that scans all profiles to find one with
 * ciInfraProvisioned=true, excluding a specified profile name.
 *
 * Validates: Requirements 4.2
 */

import { describe, it } from 'mocha'
import assert from 'assert'
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js'

/**
 * Creates a handler with a mocked config.read() that returns the given data.
 * @param {object|null} configData - The data to return from config.read()
 * @returns {BootstrapCommandHandler}
 */
function createHandlerWithConfig(configData) {
    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) })
    handler.config = { read: () => configData }
    return handler
}

describe('BootstrapCommandHandler._findExistingCiProfile', () => {
    it('returns null when config is null', () => {
        const handler = createHandlerWithConfig(null)
        const result = handler._findExistingCiProfile('my-profile')
        assert.strictEqual(result, null)
    })

    it('returns null when config has no profiles field', () => {
        const handler = createHandlerWithConfig({ activeProfile: 'default' })
        const result = handler._findExistingCiProfile('my-profile')
        assert.strictEqual(result, null)
    })

    it('returns null when profiles object is empty', () => {
        const handler = createHandlerWithConfig({ profiles: {} })
        const result = handler._findExistingCiProfile('my-profile')
        assert.strictEqual(result, null)
    })

    it('returns null when no profile has ciInfraProvisioned=true', () => {
        const handler = createHandlerWithConfig({
            profiles: {
                'us-east-1': { awsRegion: 'us-east-1', ciInfraProvisioned: false },
                'us-west-2': { awsRegion: 'us-west-2' }
            }
        })
        const result = handler._findExistingCiProfile('some-profile')
        assert.strictEqual(result, null)
    })

    it('returns the CI profile when one exists and is not excluded', () => {
        const ciConfig = { awsRegion: 'us-west-2', ciInfraProvisioned: true }
        const handler = createHandlerWithConfig({
            profiles: {
                'us-east-1': { awsRegion: 'us-east-1', ciInfraProvisioned: false },
                'us-west-2': ciConfig
            }
        })

        const result = handler._findExistingCiProfile('us-east-1')
        assert.deepStrictEqual(result, { name: 'us-west-2', config: ciConfig })
    })

    it('excludes the named profile even if it has ciInfraProvisioned=true', () => {
        const handler = createHandlerWithConfig({
            profiles: {
                'us-east-1': { awsRegion: 'us-east-1', ciInfraProvisioned: true },
                'us-west-2': { awsRegion: 'us-west-2', ciInfraProvisioned: false }
            }
        })

        const result = handler._findExistingCiProfile('us-east-1')
        assert.strictEqual(result, null)
    })

    it('returns the first CI profile found among multiple profiles', () => {
        const ciConfig = { awsRegion: 'eu-west-1', ciInfraProvisioned: true }
        const handler = createHandlerWithConfig({
            profiles: {
                'us-east-1': { awsRegion: 'us-east-1', ciInfraProvisioned: false },
                'eu-west-1': ciConfig,
                'us-west-2': { awsRegion: 'us-west-2', ciInfraProvisioned: false },
                'ap-southeast-1': { awsRegion: 'ap-southeast-1' }
            }
        })

        const result = handler._findExistingCiProfile('us-east-1')
        assert.deepStrictEqual(result, { name: 'eu-west-1', config: ciConfig })
    })

    it('works correctly when excludeProfile does not exist in config', () => {
        const ciConfig = { awsRegion: 'us-west-2', ciInfraProvisioned: true }
        const handler = createHandlerWithConfig({
            profiles: {
                'us-east-1': { awsRegion: 'us-east-1', ciInfraProvisioned: false },
                'us-west-2': ciConfig
            }
        })

        const result = handler._findExistingCiProfile('nonexistent-profile')
        assert.deepStrictEqual(result, { name: 'us-west-2', config: ciConfig })
    })
})

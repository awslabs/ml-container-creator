// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Active Profile Resolution Property-Based Tests
 *
 * Property 8: Active profile resolution
 *
 * For any bootstrap config with N ≥ 1 profiles and an activeProfile value
 * that matches one of the profile names, getActiveProfile() should return
 * the matching profile's data. When activeProfile does not match any profile
 * name, getActiveProfile() should return null. When the config has no
 * profiles, getActiveProfile() should return null.
 *
 * Feature: bootstrap-shared-infra, Property 8: Active profile resolution
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import BootstrapConfig from '../../generators/app/lib/bootstrap-config.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a non-empty alphanumeric string suitable for profile names and values.
 */
const arbNonEmptyString = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,29}$/)
    .filter(s => s.length >= 1);

/**
 * Generate a valid 12-digit AWS account ID.
 */
const arbAccountId = fc.stringMatching(/^[0-9]{12}$/);

/**
 * Generate a valid AWS region string.
 */
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1',
    'ap-northeast-1', 'eu-central-1', 'sa-east-1'
);

/**
 * Generate a valid IAM role ARN.
 */
const arbRoleArn = fc.tuple(arbAccountId, arbNonEmptyString).map(
    ([accountId, roleName]) => `arn:aws:iam::${accountId}:role/${roleName}`
);

/**
 * Generate a valid bootstrap profile with required and optional keys.
 */
const arbBootstrapProfile = fc.record({
    awsProfile: arbNonEmptyString,
    awsRegion: arbAwsRegion,
    accountId: arbAccountId,
    roleArn: arbRoleArn,
    ecrRepositoryName: arbNonEmptyString,
    asyncS3Bucket: fc.option(arbNonEmptyString, { nil: undefined }),
    batchS3Bucket: fc.option(arbNonEmptyString, { nil: undefined })
}).map(profile => {
    const cleaned = { ...profile };
    if (cleaned.asyncS3Bucket === undefined) delete cleaned.asyncS3Bucket;
    if (cleaned.batchS3Bucket === undefined) delete cleaned.batchS3Bucket;
    return cleaned;
});

/**
 * Generate a profile name suitable for use as an object key.
 */
const arbProfileName = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{0,14}$/)
    .filter(s => s.length >= 1);

/**
 * Generate a valid bootstrap config with 1-5 profiles and an activeProfile
 * that references one of the profile names.
 */
const arbBootstrapConfigWithValidActive = fc.tuple(
    fc.array(
        fc.tuple(arbProfileName, arbBootstrapProfile),
        { minLength: 1, maxLength: 5 }
    )
).chain(([profileEntries]) => {
    const profileMap = {};
    for (const [name, profile] of profileEntries) {
        profileMap[name] = profile;
    }
    const names = Object.keys(profileMap);

    return fc.constantFrom(...names).map(activeName => ({
        activeProfile: activeName,
        profiles: profileMap
    }));
});

/**
 * Generate a bootstrap config where activeProfile does NOT match any profile name.
 */
const arbBootstrapConfigWithInvalidActive = fc.tuple(
    fc.array(
        fc.tuple(arbProfileName, arbBootstrapProfile),
        { minLength: 1, maxLength: 5 }
    ),
    arbProfileName
).chain(([profileEntries, candidateName]) => {
    const profileMap = {};
    for (const [name, profile] of profileEntries) {
        profileMap[name] = profile;
    }

    // Generate a name guaranteed not to be in the profiles map
    const missingName = `${candidateName  }-missing`;

    return fc.constant({
        activeProfile: missingName,
        profiles: profileMap
    });
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: bootstrap-shared-infra, Property 8: Active profile resolution', () => {

    let tmpDir;
    let configPath;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-active-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        configPath = join(tmpDir, 'config.json');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 12.2, 10.1
     *
     * When activeProfile matches a profile name, getActiveProfile() should
     * return { name, config } for that profile.
     */
    it('returns the matching profile when activeProfile references an existing profile name', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbBootstrapConfigWithValidActive,
            (config) => {
                const bootstrapConfig = new BootstrapConfig(configPath);
                bootstrapConfig.write(config);

                const result = bootstrapConfig.getActiveProfile();

                // Should not be null
                assert.notStrictEqual(
                    result,
                    null,
                    'getActiveProfile() should not return null when activeProfile matches a profile name'
                );

                // Should return the correct name
                assert.strictEqual(
                    result.name,
                    config.activeProfile,
                    `Returned name should be "${config.activeProfile}"`
                );

                // Should return the correct config for that profile
                assert.deepStrictEqual(
                    result.config,
                    config.profiles[config.activeProfile],
                    'Returned config should deeply equal the profile data for the active profile'
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 12.2, 10.1
     *
     * When activeProfile does not match any profile name, getActiveProfile()
     * should return null.
     */
    it('returns null when activeProfile does not match any profile name', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbBootstrapConfigWithInvalidActive,
            (config) => {
                const bootstrapConfig = new BootstrapConfig(configPath);
                bootstrapConfig.write(config);

                const result = bootstrapConfig.getActiveProfile();

                assert.strictEqual(
                    result,
                    null,
                    'getActiveProfile() should return null when activeProfile does not match any profile name'
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 12.2, 10.1
     *
     * When the config has no profiles, getActiveProfile() should return null.
     */
    it('returns null when the config has no profiles', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbProfileName,
            (activeProfileName) => {
                const bootstrapConfig = new BootstrapConfig(configPath);
                bootstrapConfig.write({
                    activeProfile: activeProfileName,
                    profiles: {}
                });

                const result = bootstrapConfig.getActiveProfile();

                assert.strictEqual(
                    result,
                    null,
                    'getActiveProfile() should return null when the config has no profiles'
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 12.2, 10.1
     *
     * When the config file does not exist, getActiveProfile() should return null.
     */
    it('returns null when the config file does not exist', () => {
        const bootstrapConfig = new BootstrapConfig(configPath);

        const result = bootstrapConfig.getActiveProfile();

        assert.strictEqual(
            result,
            null,
            'getActiveProfile() should return null when the config file does not exist'
        );
    });
});

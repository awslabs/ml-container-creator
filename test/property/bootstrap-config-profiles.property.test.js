// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Config Profile Isolation Property-Based Tests
 *
 * Property 2: Profile isolation — setting a profile preserves other profiles
 *
 * For any existing bootstrap config with N profiles and any new profile data,
 * calling `setProfile(name, data)` should result in a config where the new
 * profile is present with the given data, all other profiles are unchanged,
 * and `activeProfile` is set to the new profile name. The total number of
 * profiles should be N+1 if the name is new, or N if updating an existing profile.
 *
 * Feature: bootstrap-shared-infra, Property 2: Profile isolation — setting a profile preserves other profiles
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
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
    // Remove undefined optional keys to match real-world config shape
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
const arbBootstrapConfig = fc.tuple(
    fc.array(
        fc.tuple(arbProfileName, arbBootstrapProfile),
        { minLength: 1, maxLength: 5 }
    )
).chain(([profileEntries]) => {
    // Deduplicate profile names by keeping the last entry for each name
    const profileMap = {};
    for (const [name, profile] of profileEntries) {
        profileMap[name] = profile;
    }
    const names = Object.keys(profileMap);

    // Pick one of the names as activeProfile
    return fc.constantFrom(...names).map(activeName => ({
        activeProfile: activeName,
        profiles: profileMap
    }));
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: bootstrap-shared-infra, Property 2: Profile isolation — setting a profile preserves other profiles', () => {

    let tmpDir;
    let configPath;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-profiles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        configPath = join(tmpDir, 'config.json');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 8.5, 8.6
     */
    it('setting a new profile preserves all existing profiles, updates activeProfile, and has correct profile count', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbBootstrapConfig,
            arbProfileName, // new profile name (may or may not collide)
            arbBootstrapProfile,
            (existingConfig, newProfileName, newProfileData) => {
                const bootstrapConfig = new BootstrapConfig(configPath);

                // Write the existing config to disk
                bootstrapConfig.write(existingConfig);

                // Snapshot existing profiles before the mutation
                const existingProfileNames = Object.keys(existingConfig.profiles);
                const existingProfileSnapshots = {};
                for (const name of existingProfileNames) {
                    existingProfileSnapshots[name] = JSON.parse(JSON.stringify(existingConfig.profiles[name]));
                }

                const isNewName = !existingConfig.profiles[newProfileName];
                const expectedCount = isNewName
                    ? existingProfileNames.length + 1
                    : existingProfileNames.length;

                // Call setProfile with the new profile
                bootstrapConfig.setProfile(newProfileName, newProfileData);

                // Read back the config
                const updatedConfig = bootstrapConfig.read();

                // 1. The new profile should be present with the given data
                assert.deepStrictEqual(
                    updatedConfig.profiles[newProfileName],
                    newProfileData,
                    `New profile "${newProfileName}" should contain the provided data`
                );

                // 2. activeProfile should be set to the new profile name
                assert.strictEqual(
                    updatedConfig.activeProfile,
                    newProfileName,
                    `activeProfile should be set to "${newProfileName}"`
                );

                // 3. All other existing profiles should be unchanged
                for (const name of existingProfileNames) {
                    if (name === newProfileName) continue;
                    assert.deepStrictEqual(
                        updatedConfig.profiles[name],
                        existingProfileSnapshots[name],
                        `Existing profile "${name}" should be unchanged after setting "${newProfileName}"`
                    );
                }

                // 4. Total profile count should be correct
                const actualCount = Object.keys(updatedConfig.profiles).length;
                assert.strictEqual(
                    actualCount,
                    expectedCount,
                    `Profile count should be ${expectedCount} (was ${existingProfileNames.length}, ` +
                    `${isNewName ? 'added new' : 'updated existing'} "${newProfileName}")`
                );

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

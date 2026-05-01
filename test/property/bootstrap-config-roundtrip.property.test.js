// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Config Round-Trip Integrity Property-Based Tests
 *
 * Property 1: Bootstrap config round-trip integrity
 *
 * For any valid bootstrap configuration object containing an `activeProfile`
 * string and a `profiles` map where each profile contains the required keys
 * (`awsProfile`, `awsRegion`, `accountId`, `roleArn`, `ecrRepositoryName`)
 * and optional keys (`asyncS3Bucket`, `batchS3Bucket`), writing the config
 * to disk and reading it back should produce a deeply equal object.
 *
 * Feature: bootstrap-shared-infra, Property 1: Bootstrap config round-trip integrity
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

describe('Feature: bootstrap-shared-infra, Property 1: Bootstrap config round-trip integrity', () => {

    let tmpDir;
    let configPath;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        configPath = join(tmpDir, 'config.json');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 8.1, 8.2, 8.3
     */
    it('writing a bootstrap config then reading it back produces a deeply equal object', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        fc.assert(fc.property(
            arbBootstrapConfig,
            (config) => {
                const bootstrapConfig = new BootstrapConfig(configPath);

                // Write config to disk
                bootstrapConfig.write(config);

                // Read it back
                const readBack = bootstrapConfig.read();

                // Assert deep equality
                assert.deepStrictEqual(
                    readBack,
                    config,
                    'Reading back a written config should produce a deeply equal object'
                );

                // Verify activeProfile is preserved
                assert.strictEqual(
                    readBack.activeProfile,
                    config.activeProfile,
                    'activeProfile should be preserved'
                );

                // Verify all profile names are preserved
                assert.deepStrictEqual(
                    Object.keys(readBack.profiles).sort(),
                    Object.keys(config.profiles).sort(),
                    'All profile names should be preserved'
                );

                // Verify each profile's data is preserved
                for (const profileName of Object.keys(config.profiles)) {
                    assert.deepStrictEqual(
                        readBack.profiles[profileName],
                        config.profiles[profileName],
                        `Profile "${profileName}" data should be preserved`
                    );
                }

                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

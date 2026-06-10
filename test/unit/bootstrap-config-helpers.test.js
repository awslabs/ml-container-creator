// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BootstrapConfig Helper Methods Unit Tests
 *
 * Tests the findCiProfile() and getSharedInfraSource() helper methods:
 * - findCiProfile() with empty config, no CI profile, one CI profile, multiple profiles
 * - getSharedInfraSource() with sharedInfraFrom, legacy sharedStackFrom, and neither
 *
 * Validates: Requirements 4.1, 6.2
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import os from 'os';
import path from 'path';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';

/**
 * Creates a unique temp config path for test isolation.
 * @returns {string} Absolute path to a temp config.json
 */
function createTempConfigPath() {
    return path.join(
        os.tmpdir(),
        `mlcc-test-helpers-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        'config.json'
    );
}

// ─── findCiProfile() tests ──────────────────────────────────────────────────

describe('BootstrapConfig — findCiProfile()', () => {

    it('should return null when config file does not exist', () => {
        const configPath = createTempConfigPath();
        const config = new BootstrapConfig(configPath);

        const result = config.findCiProfile();
        assert.strictEqual(result, null, 'should return null for non-existent config');
    });

    it('should return null when config has no profiles', () => {
        const configPath = createTempConfigPath();
        const config = new BootstrapConfig(configPath);

        // Write an empty config with no profiles key
        config.write({ activeProfile: null, profiles: {} });

        const result = config.findCiProfile();
        assert.strictEqual(result, null, 'should return null when profiles is empty');
    });

    it('should return null when no profile has ciInfraProvisioned=true', () => {
        const configPath = createTempConfigPath();
        const config = new BootstrapConfig(configPath);

        config.write({
            activeProfile: 'dev',
            profiles: {
                dev: {
                    awsProfile: 'dev',
                    awsRegion: 'us-east-1',
                    accountId: '111111111111',
                    ciInfraProvisioned: false
                },
                staging: {
                    awsProfile: 'staging',
                    awsRegion: 'us-west-2',
                    accountId: '111111111111'
                    // ciInfraProvisioned not set at all
                }
            }
        });

        const result = config.findCiProfile();
        assert.strictEqual(result, null, 'should return null when no profile has CI enabled');
    });

    it('should return the profile with ciInfraProvisioned=true', () => {
        const configPath = createTempConfigPath();
        const config = new BootstrapConfig(configPath);

        config.write({
            activeProfile: 'dev',
            profiles: {
                dev: {
                    awsProfile: 'dev',
                    awsRegion: 'us-east-1',
                    accountId: '111111111111',
                    ciInfraProvisioned: false
                },
                'ci-region': {
                    awsProfile: 'ci',
                    awsRegion: 'us-west-2',
                    accountId: '111111111111',
                    ciInfraProvisioned: true,
                    ciTableName: 'mlcc-ci-table'
                }
            }
        });

        const result = config.findCiProfile();
        assert.ok(result, 'should return a result');
        assert.strictEqual(result.name, 'ci-region', 'should return the CI profile name');
        assert.strictEqual(result.config.awsRegion, 'us-west-2', 'should return the CI profile config');
        assert.strictEqual(result.config.ciInfraProvisioned, true, 'config should have ciInfraProvisioned=true');
    });

    it('should return the first CI profile when multiple profiles exist', () => {
        const configPath = createTempConfigPath();
        const config = new BootstrapConfig(configPath);

        config.write({
            activeProfile: 'alpha',
            profiles: {
                alpha: {
                    awsProfile: 'alpha',
                    awsRegion: 'us-east-1',
                    accountId: '111111111111',
                    ciInfraProvisioned: false
                },
                beta: {
                    awsProfile: 'beta',
                    awsRegion: 'eu-west-1',
                    accountId: '111111111111',
                    ciInfraProvisioned: true,
                    ciTableName: 'mlcc-ci-table'
                },
                gamma: {
                    awsProfile: 'gamma',
                    awsRegion: 'ap-southeast-1',
                    accountId: '111111111111',
                    ciInfraProvisioned: false
                }
            }
        });

        const result = config.findCiProfile();
        assert.ok(result, 'should return a result');
        assert.strictEqual(result.name, 'beta', 'should return the profile with CI enabled');
        assert.strictEqual(result.config.awsRegion, 'eu-west-1');
    });

    it('should return null when config has profiles key set to null-ish', () => {
        const configPath = createTempConfigPath();
        const config = new BootstrapConfig(configPath);

        // Write config with profiles explicitly null (edge case)
        config.write({ activeProfile: null, profiles: null });

        const result = config.findCiProfile();
        assert.strictEqual(result, null, 'should return null when profiles is null');
    });
});

// ─── getSharedInfraSource() tests ───────────────────────────────────────────

describe('BootstrapConfig — getSharedInfraSource()', () => {

    it('should return sharedInfraFrom when present', () => {
        const config = new BootstrapConfig(createTempConfigPath());

        const profileConfig = {
            awsProfile: 'dev',
            awsRegion: 'us-east-1',
            accountId: '111111111111',
            sharedInfraFrom: 'mlcc-bootstrap-primary'
        };

        const result = config.getSharedInfraSource(profileConfig);
        assert.strictEqual(result, 'mlcc-bootstrap-primary',
            'should return sharedInfraFrom value');
    });

    it('should return legacy sharedStackFrom when sharedInfraFrom is not present', () => {
        const config = new BootstrapConfig(createTempConfigPath());

        const profileConfig = {
            awsProfile: 'legacy',
            awsRegion: 'us-west-2',
            accountId: '222222222222',
            sharedStackFrom: 'mlcc-bootstrap-old-profile'
        };

        const result = config.getSharedInfraSource(profileConfig);
        assert.strictEqual(result, 'mlcc-bootstrap-old-profile',
            'should fall back to sharedStackFrom for legacy profiles');
    });

    it('should return null when neither sharedInfraFrom nor sharedStackFrom is present', () => {
        const config = new BootstrapConfig(createTempConfigPath());

        const profileConfig = {
            awsProfile: 'standalone',
            awsRegion: 'eu-west-1',
            accountId: '333333333333'
        };

        const result = config.getSharedInfraSource(profileConfig);
        assert.strictEqual(result, null,
            'should return null for standalone profiles with no shared infrastructure');
    });

    it('should prefer sharedInfraFrom over sharedStackFrom when both are present', () => {
        const config = new BootstrapConfig(createTempConfigPath());

        const profileConfig = {
            awsProfile: 'both',
            awsRegion: 'us-east-1',
            accountId: '444444444444',
            sharedInfraFrom: 'mlcc-bootstrap-new',
            sharedStackFrom: 'mlcc-bootstrap-old'
        };

        const result = config.getSharedInfraSource(profileConfig);
        assert.strictEqual(result, 'mlcc-bootstrap-new',
            'should prefer sharedInfraFrom over legacy sharedStackFrom');
    });

    it('should return null when sharedInfraFrom is explicitly null and sharedStackFrom is absent', () => {
        const config = new BootstrapConfig(createTempConfigPath());

        const profileConfig = {
            awsProfile: 'explicit-null',
            awsRegion: 'us-east-1',
            accountId: '555555555555',
            sharedInfraFrom: null
        };

        const result = config.getSharedInfraSource(profileConfig);
        assert.strictEqual(result, null,
            'should return null when sharedInfraFrom is explicitly null');
    });

    it('should return sharedStackFrom when sharedInfraFrom is explicitly null', () => {
        const config = new BootstrapConfig(createTempConfigPath());

        const profileConfig = {
            awsProfile: 'mixed',
            awsRegion: 'us-east-1',
            accountId: '666666666666',
            sharedInfraFrom: null,
            sharedStackFrom: 'mlcc-bootstrap-legacy'
        };

        const result = config.getSharedInfraSource(profileConfig);
        assert.strictEqual(result, 'mlcc-bootstrap-legacy',
            'should fall back to sharedStackFrom when sharedInfraFrom is null');
    });
});

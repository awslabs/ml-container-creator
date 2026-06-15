// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Config Precedence Property-Based Tests
 *
 * Property 5: ConfigManager bootstrap precedence
 *
 * For any configuration parameter that exists in both the bootstrap config
 * and a higher-precedence source (CLI option, environment variable, or config
 * file), the higher-precedence value should win. For any parameter that exists
 * in bootstrap config but not in any higher-precedence source, the bootstrap
 * value should be used over generator defaults.
 *
 * Feature: bootstrap-shared-infra, Property 5: ConfigManager bootstrap precedence
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';
import ConfigManager from '../../src/lib/config-manager.js';
import { createMockGenerator, createMockGeneratorWithOptions, cleanupEnvVars } from '../helpers/mock-generator.js';
import { NUM_RUNS } from '../helpers/property-config.js';

const PROPERTY_CONFIG = {
    numRuns: NUM_RUNS,
    timeout: 60000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid AWS region string.
 */
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1',
    'ap-northeast-1', 'eu-central-1', 'sa-east-1'
);

/**
 * Generate a valid 12-digit AWS account ID.
 */
const arbAccountId = fc.stringMatching(/^[0-9]{12}$/);

/**
 * Generate a valid IAM role ARN.
 */
const arbRoleArn = arbAccountId.map(
    (accountId) => `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`
);

/**
 * Generate a non-empty alphanumeric string for profile names.
 */
const arbProfileName = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{0,14}$/)
    .filter(s => s.length >= 1);

/**
 * Generate a bootstrap profile with values that map to ConfigManager keys.
 */
const arbBootstrapProfile = fc.record({
    awsProfile: fc.constantFrom('default', 'dev', 'staging', 'prod'),
    awsRegion: arbAwsRegion,
    accountId: arbAccountId,
    roleArn: arbRoleArn,
    ecrRepositoryName: fc.constantFrom('ml-container-creator', 'my-ecr-repo')
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Patches a ConfigManager instance so that _loadBootstrapConfig reads from
 * the given BootstrapConfig instance instead of the default home-directory path.
 */
function patchBootstrapConfig(configManager, bootstrapConfigInstance) {
    configManager._loadBootstrapConfig = async function () {
        try {
            const activeProfile = bootstrapConfigInstance.getActiveProfile();
            if (!activeProfile) {
                return;
            }

            const profileConfig = activeProfile.config;
            const mapped = {};

            if (profileConfig.roleArn) {
                mapped.awsRoleArn = profileConfig.roleArn;
            }
            if (profileConfig.awsRegion) {
                mapped.awsRegion = profileConfig.awsRegion;
            }
            if (profileConfig.awsProfile) {
                mapped.awsProfile = profileConfig.awsProfile;
            }

            this._mergeConfig(mapped);
        } catch (error) {
            // Ignore errors — matches production behaviour
        }
    };
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: bootstrap-shared-infra, Property 5: ConfigManager bootstrap precedence', () => {

    let tmpDir;
    let configPath;
    let envVarsToCleanup;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-precedence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        configPath = join(tmpDir, 'config.json');
        envVarsToCleanup = [];
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        cleanupEnvVars(envVarsToCleanup);
    });

    /**
     * Validates: Requirements 12.2
     *
     * When no higher-precedence source provides a value, bootstrap values
     * should appear in the final config instead of generator defaults.
     */
    it('bootstrap values are used over generator defaults when no higher source provides them', async function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbBootstrapProfile,
            async (profileName, profile) => {
                // Write a bootstrap config with the generated profile
                const bc = new BootstrapConfig(configPath);
                bc.setProfile(profileName, profile);

                // Create ConfigManager with a bare mock generator (no CLI options, no env vars)
                const mockGen = createMockGenerator();
                const configManager = new ConfigManager(mockGen);
                patchBootstrapConfig(configManager, bc);

                const config = await configManager.loadConfiguration();

                // awsRegion from bootstrap should be present in config
                assert.strictEqual(
                    config.awsRegion,
                    profile.awsRegion,
                    `awsRegion should come from bootstrap profile (${profile.awsRegion}), got ${config.awsRegion}`
                );

                // awsRoleArn from bootstrap should be present (generator default is null)
                assert.strictEqual(
                    config.awsRoleArn,
                    profile.roleArn,
                    `awsRoleArn should come from bootstrap profile (${profile.roleArn}), got ${config.awsRoleArn}`
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 12.2
     *
     * When a CLI option provides the same key that bootstrap also provides,
     * the CLI option (higher precedence) should win.
     */
    it('CLI options override bootstrap values', async function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbBootstrapProfile,
            arbAwsRegion,
            arbRoleArn,
            async (profileName, profile, cliRegion, cliRoleArn) => {
                // Ensure CLI values differ from bootstrap values so we can detect precedence
                fc.pre(cliRegion !== profile.awsRegion || cliRoleArn !== profile.roleArn);

                const bc = new BootstrapConfig(configPath);
                bc.setProfile(profileName, profile);

                // Create ConfigManager with CLI options that overlap bootstrap keys
                const mockGen = createMockGeneratorWithOptions({
                    region: cliRegion,
                    'role-arn': cliRoleArn
                });
                const configManager = new ConfigManager(mockGen);
                patchBootstrapConfig(configManager, bc);

                const config = await configManager.loadConfiguration();

                // CLI options have higher precedence — they should win
                assert.strictEqual(
                    config.awsRegion,
                    cliRegion,
                    `awsRegion should come from CLI (${cliRegion}), not bootstrap (${profile.awsRegion})`
                );
                assert.strictEqual(
                    config.awsRoleArn,
                    cliRoleArn,
                    `awsRoleArn should come from CLI (${cliRoleArn}), not bootstrap (${profile.roleArn})`
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 12.2
     *
     * When environment variables provide the same key that bootstrap also
     * provides, the environment variable (higher precedence) should win.
     */
    it('environment variables override bootstrap values', async function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbBootstrapProfile,
            arbAwsRegion,
            arbRoleArn,
            async (profileName, profile, envRegion, envRoleArn) => {
                // Ensure env values differ from bootstrap values
                fc.pre(envRegion !== profile.awsRegion || envRoleArn !== profile.roleArn);

                const bc = new BootstrapConfig(configPath);
                bc.setProfile(profileName, profile);

                // Set environment variables (higher precedence than bootstrap)
                process.env.AWS_REGION = envRegion;
                process.env.AWS_ROLE = envRoleArn;
                envVarsToCleanup.push('AWS_REGION', 'AWS_ROLE');

                const mockGen = createMockGenerator();
                const configManager = new ConfigManager(mockGen);
                patchBootstrapConfig(configManager, bc);

                const config = await configManager.loadConfiguration();

                // Environment variables have higher precedence — they should win
                assert.strictEqual(
                    config.awsRegion,
                    envRegion,
                    `awsRegion should come from env (${envRegion}), not bootstrap (${profile.awsRegion})`
                );
                assert.strictEqual(
                    config.awsRoleArn,
                    envRoleArn,
                    `awsRoleArn should come from env (${envRoleArn}), not bootstrap (${profile.roleArn})`
                );

                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

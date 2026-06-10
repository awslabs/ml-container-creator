// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Stack Name Invariant Property-Based Tests
 *
 * Property 1: Stack Name Invariant
 *
 * After `_handleInteractiveSetup` completes, `profile.stackName === 'mlcc-bootstrap-' + profileName`
 * (never another profile's name). This must hold regardless of whether infrastructure was reused
 * from an existing stack or freshly created.
 *
 * Feature: multi-region-bootstrap, Property 1: Stack Name Invariant
 *
 * Validates: Requirements 1.1, 1.2
 */

import fc from 'fast-check';
import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';
import BootstrapConfig from '../../src/lib/bootstrap-config.js';

const STACK_NAME_PREFIX = 'mlcc-bootstrap';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    timeout: 30000,
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid profile name (alphanumeric with hyphens, starting with a letter).
 */
const arbProfileName = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
    .filter(s => s.length >= 2 && !s.endsWith('-'));

/**
 * Generate a valid AWS region.
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
 * Generate a scenario: either reusing an existing stack or fresh deployment.
 */
const arbReuseScenario = fc.oneof(
    fc.constant('no-existing-stack'),
    fc.constant('existing-stack-same-region'),
    fc.constant('existing-stack-different-name')
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Suppress console.log during test execution.
 */
async function suppressConsole(fn) {
    const originalLog = console.log;
    console.log = () => {};
    try {
        return await fn();
    } finally {
        console.log = originalLog;
    }
}

/**
 * Create a BootstrapCommandHandler with mocked AWS dependencies that
 * simulates different stack reuse scenarios.
 *
 * @param {string} configPath - Path to temp config file
 * @param {object} opts - Options controlling the mock behavior
 * @param {string} opts.scenario - 'no-existing-stack' | 'existing-stack-same-region' | 'existing-stack-different-name'
 * @param {string} opts.otherStackName - Name of the "other" stack to simulate reuse from
 * @param {string} opts.accountId - Simulated AWS account ID
 * @param {string} opts.region - Simulated AWS region
 * @returns {BootstrapCommandHandler}
 */
function createMockHandler(configPath, { scenario, otherStackName, accountId, region }) {
    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
    handler.config = new BootstrapConfig(configPath);

    // Mock provisioners._verifyCliV2
    handler.provisioners = { _verifyCliV2: () => true };

    // Mock _displayProgress
    handler._displayProgress = () => {};

    // Mock _validateCredentials
    handler._validateCredentials = async () => ({ accountId, region });

    // Mock _selectProfile
    handler._selectProfile = async () => 'test-aws-profile';

    // Mock _ensureMlflowApp
    handler._ensureMlflowApp = () => null;

    // Mock _runPostSetupChain
    handler._runPostSetupChain = async () => {};

    // Mock _displaySummary
    handler._displaySummary = () => {};

    // Mock _resourceExists (for CI CDK bootstrap check)
    handler._resourceExists = () => false;

    // Mock _execAws based on scenario
    handler._execAws = (cmd) => {
        if (cmd.includes('list-stacks')) {
            if (scenario === 'no-existing-stack') {
                return [];
            }
            if (scenario === 'existing-stack-same-region' || scenario === 'existing-stack-different-name') {
                return [otherStackName];
            }
            return [];
        }
        if (cmd.includes('describe-stacks')) {
            // Return mock stack outputs from the "other" stack
            return [
                { OutputKey: 'RoleArn', OutputValue: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role` },
                { OutputKey: 'EcrRepositoryName', OutputValue: 'ml-container-creator' },
                { OutputKey: 'AsyncS3BucketName', OutputValue: `mlcc-async-${accountId}-${region}` },
                { OutputKey: 'BatchS3BucketName', OutputValue: `mlcc-batch-${accountId}-${region}` }
            ];
        }
        return {};
    };

    // Mock _deployStack for fresh deployments
    handler._deployStack = (stackName) => ({
        RoleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
        EcrRepositoryName: 'ml-container-creator',
        AsyncS3BucketName: `mlcc-async-${accountId}-${region}`,
        BatchS3BucketName: `mlcc-batch-${accountId}-${region}`
    });

    return handler;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: multi-region-bootstrap, Property 1: Stack Name Invariant', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-stackname-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 1.1, 1.2
     *
     * After _handleInteractiveSetup completes, the profile's stackName is always
     * 'mlcc-bootstrap-' + profileName, regardless of whether an existing stack
     * was found and reused, or a fresh deployment occurred.
     */
    it('stackName always equals mlcc-bootstrap-{profileName} after interactive setup', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbReuseScenario,
            arbAwsRegion,
            arbAccountId,
            async (profileName, scenario, region, accountId) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                // Generate a different stack name to simulate "another profile's stack"
                const otherStackName = `${STACK_NAME_PREFIX}-other-profile-${Math.random().toString(36).slice(2, 8)}`;

                const handler = createMockHandler(configPath, {
                    scenario,
                    otherStackName,
                    accountId,
                    region
                });

                await suppressConsole(async () => {
                    await handler._handleInteractiveSetup({
                        'non-interactive': true,
                        name: profileName,
                        profile: 'test-aws-profile',
                        region,
                        'skip-ci': true,
                        'skip-s3': false
                    });
                });

                // Read the saved profile
                const config = handler.config.read();
                assert.ok(config, 'Config should have been written');
                assert.ok(config.profiles, 'Config should have profiles');

                const savedProfile = config.profiles[profileName];
                assert.ok(savedProfile, `Profile "${profileName}" should exist in saved config`);

                // THE INVARIANT: stackName must always be mlcc-bootstrap-{profileName}
                const expectedStackName = `${STACK_NAME_PREFIX}-${profileName}`;
                assert.strictEqual(
                    savedProfile.stackName,
                    expectedStackName,
                    `Stack name invariant violated: expected "${expectedStackName}" but got "${savedProfile.stackName}" (scenario: ${scenario})`
                );

                // Additional: stackName must never be the other profile's stack name
                if (scenario !== 'no-existing-stack') {
                    assert.notStrictEqual(
                        savedProfile.stackName,
                        otherStackName,
                        `Stack name must never be another profile's stack name "${otherStackName}"`
                    );
                }

                // When reusing, sharedInfraFrom should reference the other stack
                if (scenario === 'existing-stack-same-region' || scenario === 'existing-stack-different-name') {
                    assert.strictEqual(
                        savedProfile.sharedInfraFrom,
                        otherStackName,
                        `sharedInfraFrom should reference the source stack "${otherStackName}"`
                    );
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 1.1, 1.2
     *
     * The stack name invariant holds for any valid profile name string —
     * the prefix is always 'mlcc-bootstrap-' and the suffix is always the exact profile name.
     */
    it('stack name prefix is always mlcc-bootstrap- regardless of profile name', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            async (profileName, region, accountId) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                const handler = createMockHandler(configPath, {
                    scenario: 'no-existing-stack',
                    otherStackName: '',
                    accountId,
                    region
                });

                await suppressConsole(async () => {
                    await handler._handleInteractiveSetup({
                        'non-interactive': true,
                        name: profileName,
                        profile: 'test-aws-profile',
                        region,
                        'skip-ci': true,
                        'skip-s3': true
                    });
                });

                const config = handler.config.read();
                const savedProfile = config.profiles[profileName];
                assert.ok(savedProfile, `Profile "${profileName}" should exist`);

                // Verify the prefix is correct
                assert.ok(
                    savedProfile.stackName.startsWith(`${STACK_NAME_PREFIX}-`),
                    `Stack name "${savedProfile.stackName}" must start with "${STACK_NAME_PREFIX}-"`
                );

                // Verify the suffix is the exact profile name
                const suffix = savedProfile.stackName.slice(`${STACK_NAME_PREFIX}-`.length);
                assert.strictEqual(
                    suffix,
                    profileName,
                    `Stack name suffix must be the profile name "${profileName}" but got "${suffix}"`
                );
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Region Isolation Property-Based Tests
 *
 * Property 4: Region Isolation
 *
 * Deploying bootstrap in region A never modifies resources in region B.
 * Each stack operates in its profile's `awsRegion` only. All regional AWS commands
 * (cloudformation deploy, ecr, s3 operations) include `--region {profile.awsRegion}`
 * and never target a different region.
 *
 * Feature: multi-region-bootstrap, Property 4: Region Isolation
 *
 * Validates: Requirements 3.2, 3.3
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

// Services whose commands are region-independent (exempt from region check)
const REGION_INDEPENDENT_SERVICES = ['iam', 'sts'];

/**
 * Extract the --region value from a CLI command string, if present.
 * Returns null if no --region flag is found.
 */
function extractRegionFromCommand(cmd) {
    const match = cmd.match(/--region\s+([a-z0-9-]+)/);
    return match ? match[1] : null;
}

/**
 * Determine whether a command targets a regional service.
 * IAM and STS are global/region-independent services.
 */
function isRegionalCommand(cmd) {
    for (const svc of REGION_INDEPENDENT_SERVICES) {
        // Check if the command starts with the service name (e.g. "iam get-role", "sts get-caller-identity")
        if (cmd.startsWith(`${svc} `)) {
            return false;
        }
    }
    return true;
}

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
 * Create a BootstrapCommandHandler with mocked dependencies for testing
 * region isolation. Captures all _execAws commands for inspection.
 *
 * @param {string} configPath - Path to temp config file
 * @param {object} opts - Options controlling the mock behavior
 * @param {string} opts.accountId - Simulated AWS account ID
 * @param {string} opts.region - Profile's configured AWS region
 * @returns {{ handler: BootstrapCommandHandler, capturedCommands: string[] }}
 */
function createMockHandlerForSetup(configPath, { accountId, region }) {
    const capturedCommands = [];

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

    // Mock _resourceExists — captures its command and returns false
    handler._resourceExists = (cmd, _profile) => {
        capturedCommands.push(cmd);
        return false;
    };

    // Mock _execAws — captures all commands and returns appropriate mock data
    handler._execAws = (cmd) => {
        capturedCommands.push(cmd);

        if (cmd.includes('list-stacks')) {
            return []; // No existing stacks — fresh deployment
        }
        if (cmd.includes('describe-stacks')) {
            return {
                Stacks: [{
                    Outputs: [
                        { OutputKey: 'RoleArn', OutputValue: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role` },
                        { OutputKey: 'EcrRepositoryName', OutputValue: 'ml-container-creator' },
                        { OutputKey: 'AsyncS3BucketName', OutputValue: `mlcc-async-${accountId}-${region}` },
                        { OutputKey: 'BatchS3BucketName', OutputValue: `mlcc-batch-${accountId}-${region}` }
                    ]
                }]
            };
        }
        if (cmd.includes('iam get-role')) {
            // Role does not exist — will be created by stack
            throw new Error('NoSuchEntity');
        }
        return {};
    };

    // Mock _deployStack — captures the region parameter and returns outputs
    handler._deployStack = (stackName, parameters, profile, deployRegion) => {
        // Record a synthetic command to verify the region
        capturedCommands.push(`cloudformation deploy --stack-name ${stackName} --region ${deployRegion}`);
        return {
            RoleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
            EcrRepositoryName: 'ml-container-creator',
            AsyncS3BucketName: `mlcc-async-${accountId}-${region}`,
            BatchS3BucketName: `mlcc-batch-${accountId}-${region}`
        };
    };

    return { handler, capturedCommands };
}

/**
 * Create a BootstrapCommandHandler with mocked dependencies for testing
 * region isolation during _handleUpdate. Captures all commands.
 *
 * @param {string} configPath - Path to temp config file
 * @param {object} opts - Options controlling the mock behavior
 * @param {string} opts.accountId - Simulated AWS account ID
 * @param {string} opts.region - Profile's configured AWS region
 * @returns {{ handler: BootstrapCommandHandler, capturedCommands: string[] }}
 */
function createMockHandlerForUpdate(configPath, { accountId, region }) {
    const capturedCommands = [];

    const handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
    handler.config = new BootstrapConfig(configPath);

    // Mock _getCallerAccount — returns matching account
    handler._getCallerAccount = () => accountId;

    // Mock _resourceExists — captures commands, returns true (stack exists)
    handler._resourceExists = (cmd) => {
        capturedCommands.push(cmd);
        return true;
    };

    // Mock _displayProgress
    handler._displayProgress = () => {};

    // Mock _execAws — captures commands, prevents real AWS calls
    handler._execAws = (cmd) => {
        capturedCommands.push(cmd);
        if (cmd.includes('iam get-role')) {
            throw new Error('NoSuchEntity');
        }
        if (cmd.includes('ecr describe-repositories')) {
            throw new Error('RepositoryNotFoundException');
        }
        return {};
    };

    // Mock _ensureMlflowApp
    handler._ensureMlflowApp = () => null;

    // Mock _runPostSetupChain
    handler._runPostSetupChain = async () => {};

    // Mock _deployStack — captures the region parameter and returns outputs
    handler._deployStack = (stackName, parameters, profile, deployRegion) => {
        capturedCommands.push(`cloudformation deploy --stack-name ${stackName} --region ${deployRegion}`);
        return {
            RoleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
            EcrRepositoryName: 'ml-container-creator',
            AsyncS3BucketName: `mlcc-async-${accountId}-${region}`,
            BatchS3BucketName: `mlcc-batch-${accountId}-${region}`
        };
    };

    return { handler, capturedCommands };
}

/**
 * Write a config with a single active profile for update testing.
 */
function writeProfileConfig(handler, profileName, accountId, region) {
    handler.config.write({
        activeProfile: profileName,
        profiles: {
            [profileName]: {
                awsProfile: 'test-aws-profile',
                awsRegion: region,
                accountId,
                stackName: `${STACK_NAME_PREFIX}-${profileName}`,
                roleArn: `arn:aws:iam::${accountId}:role/mlcc-sagemaker-execution-role`,
                ecrRepositoryName: 'ml-container-creator',
                asyncS3Bucket: `mlcc-async-${accountId}-${region}`,
                batchS3Bucket: `mlcc-batch-${accountId}-${region}`,
                ciInfraProvisioned: false,
                ciTableName: 'mlcc-ci-table'
            }
        }
    });
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: multi-region-bootstrap, Property 4: Region Isolation', () => {

    let tmpDir;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `bootstrap-region-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Validates: Requirements 3.2, 3.3
     *
     * During _handleInteractiveSetup, all regional AWS commands must target
     * the profile's configured awsRegion. No command should include a --region
     * flag pointing to a different region.
     */
    it('_handleInteractiveSetup only targets the profile awsRegion for regional commands', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            async (profileName, region, accountId) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                const { handler, capturedCommands } = createMockHandlerForSetup(configPath, {
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

                // THE PROPERTY: every regional command with a --region flag must use the profile's region
                for (const cmd of capturedCommands) {
                    if (!isRegionalCommand(cmd)) continue;

                    const cmdRegion = extractRegionFromCommand(cmd);
                    if (cmdRegion !== null) {
                        assert.strictEqual(
                            cmdRegion,
                            region,
                            `Region isolation violated: command targets "${cmdRegion}" but profile region is "${region}". Command: ${cmd}`
                        );
                    }
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 3.2, 3.3
     *
     * During _handleUpdate, all regional AWS commands must target the profile's
     * configured awsRegion. No command should include a --region flag pointing
     * to a different region.
     */
    it('_handleUpdate only targets the profile awsRegion for regional commands', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            async (profileName, region, accountId) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                const { handler, capturedCommands } = createMockHandlerForUpdate(configPath, {
                    accountId,
                    region
                });

                // Write config with the profile
                writeProfileConfig(handler, profileName, accountId, region);

                await suppressConsole(async () => {
                    await handler._handleUpdate();
                });

                // THE PROPERTY: every regional command with a --region flag must use the profile's region
                for (const cmd of capturedCommands) {
                    if (!isRegionalCommand(cmd)) continue;

                    const cmdRegion = extractRegionFromCommand(cmd);
                    if (cmdRegion !== null) {
                        assert.strictEqual(
                            cmdRegion,
                            region,
                            `Region isolation violated: command targets "${cmdRegion}" but profile region is "${region}". Command: ${cmd}`
                        );
                    }
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    /**
     * Validates: Requirements 3.2, 3.3
     *
     * When running _handleInteractiveSetup, the cloudformation deploy command
     * always includes --region matching the profile's awsRegion. This ensures
     * the stack is created in the correct region.
     */
    it('cloudformation deploy always specifies the correct region during setup', async function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        await fc.assert(fc.asyncProperty(
            arbProfileName,
            arbAwsRegion,
            arbAccountId,
            async (profileName, region, accountId) => {
                const configPath = join(tmpDir, `config-${Math.random().toString(36).slice(2)}.json`);

                const { handler, capturedCommands } = createMockHandlerForSetup(configPath, {
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

                // Find the cloudformation deploy command
                const deployCmds = capturedCommands.filter(cmd => cmd.includes('cloudformation deploy'));
                assert.ok(
                    deployCmds.length > 0,
                    'Expected at least one cloudformation deploy command'
                );

                for (const cmd of deployCmds) {
                    const cmdRegion = extractRegionFromCommand(cmd);
                    assert.strictEqual(
                        cmdRegion,
                        region,
                        `CloudFormation deploy targets wrong region: "${cmdRegion}" instead of "${region}". Command: ${cmd}`
                    );
                }
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

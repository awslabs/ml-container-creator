// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AI Registry Hub provisioning in bootstrap.
 *
 * Tests the provisionAiRegistryHub() method on BootstrapProvisioners:
 * - AC-1.1: Creates hub named mlcc-registry-{accountId} with display name "MCC AI Registry"
 * - AC-1.2: Idempotent — skips creation if hub already exists
 * - AC-1.3: Stores aiRegistryHubName and aiRegistryHubArn in profileData
 * - AC-1.4: Uses aws sagemaker create-hub CLI (via _execAws)
 * - AC-1.5: Non-fatal — catches errors and prints warning
 * - AC-1.6: Uses the profile's awsRegion
 * - AC-3.3: bootstrap status shows AI Registry hub state
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'node:assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

/**
 * Capture console.log output during a callback.
 */
async function captureConsoleLog(fn) {
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => {
        captured.push(args.join(' '));
    };
    try {
        await fn();
    } finally {
        console.log = originalLog;
    }
    return captured;
}

describe('Bootstrap AI Registry Hub Provisioning', () => {
    let handler;
    let executedCommands;

    beforeEach(() => {
        handler = new BootstrapCommandHandler({ promptFn: async () => ({}) });
        handler._currentProfile = 'test-profile';
        handler._currentRegion = 'us-west-2';
        handler._currentAccountId = '123456789012';
        executedCommands = [];
    });

    describe('provisionAiRegistryHub — hub already exists (idempotent)', () => {
        it('should skip creation and store hub name/ARN in profileData when hub exists', async () => {
            const profileData = {
                accountId: '123456789012',
                awsRegion: 'us-west-2'
            };

            // Mock _resourceExists to return true (hub exists)
            handler._resourceExists = (cmd) => {
                executedCommands.push(cmd);
                return true;
            };

            // Mock _execAws to return describe-hub result
            handler._execAws = (cmd) => {
                executedCommands.push(cmd);
                if (cmd.includes('describe-hub')) {
                    return {
                        HubArn: 'arn:aws:sagemaker:us-west-2:123456789012:hub/mlcc-registry-123456789012'
                    };
                }
                return {};
            };

            const logs = await captureConsoleLog(async () => {
                await handler.provisioners.provisionAiRegistryHub(profileData);
            });

            // AC-1.2: Should log "already provisioned"
            assert.ok(
                logs.some(l => l.includes('already provisioned')),
                `Expected "already provisioned" message, got: ${logs.join('\n')}`
            );

            // AC-1.3: Should store hub name and ARN
            assert.strictEqual(profileData.aiRegistryHubName, 'mlcc-registry-123456789012');
            assert.strictEqual(profileData.aiRegistryHubArn, 'arn:aws:sagemaker:us-west-2:123456789012:hub/mlcc-registry-123456789012');

            // AC-1.6: Should use the profile's region
            const describeCmd = executedCommands.find(c => c.includes('describe-hub'));
            assert.ok(describeCmd.includes('--region us-west-2'), 'Should use profile region');
        });
    });

    describe('provisionAiRegistryHub — hub does not exist (create)', () => {
        it('should create hub and store hub name/ARN in profileData', async () => {
            const profileData = {
                accountId: '999888777666',
                awsRegion: 'eu-west-1'
            };

            handler._currentProfile = 'eu-profile';
            handler._currentRegion = 'eu-west-1';

            // Mock _resourceExists to return false (hub doesn't exist)
            handler._resourceExists = (cmd) => {
                executedCommands.push(cmd);
                return false;
            };

            // Mock _formatTagsForCli
            handler._formatTagsForCli = () => 'file:///tmp/tags.json';

            // Mock _execAws to return create-hub result
            handler._execAws = (cmd) => {
                executedCommands.push(cmd);
                if (cmd.includes('create-hub')) {
                    return {
                        HubArn: 'arn:aws:sagemaker:eu-west-1:999888777666:hub/mlcc-registry-999888777666'
                    };
                }
                return {};
            };

            const logs = await captureConsoleLog(async () => {
                await handler.provisioners.provisionAiRegistryHub(profileData);
            });

            // AC-1.1: Should create hub with correct name
            const createCmd = executedCommands.find(c => c.includes('create-hub'));
            assert.ok(createCmd, 'Should call create-hub');
            assert.ok(createCmd.includes('--hub-name mlcc-registry-999888777666'), 'Hub name should be mlcc-registry-{accountId}');
            assert.ok(createCmd.includes('--hub-display-name "MCC AI Registry"'), 'Display name should be MCC AI Registry');

            // AC-1.4: Uses aws sagemaker create-hub (verified by the command above)

            // AC-1.6: Should use the profile's region
            assert.ok(createCmd.includes('--region eu-west-1'), 'Should use profile region');

            // Should log "created"
            assert.ok(
                logs.some(l => l.includes('created')),
                `Expected "created" message, got: ${logs.join('\n')}`
            );

            // AC-1.3: Should store hub name and ARN
            assert.strictEqual(profileData.aiRegistryHubName, 'mlcc-registry-999888777666');
            assert.strictEqual(profileData.aiRegistryHubArn, 'arn:aws:sagemaker:eu-west-1:999888777666:hub/mlcc-registry-999888777666');
        });
    });

    describe('provisionAiRegistryHub — non-fatal error handling', () => {
        it('should catch errors and print a warning without throwing (AC-1.5)', async () => {
            const profileData = {
                accountId: '111222333444',
                awsRegion: 'us-east-1'
            };

            handler._currentProfile = 'fail-profile';

            // Mock _resourceExists to throw (simulating AWS API failure)
            handler._resourceExists = () => {
                throw new Error('AccessDeniedException: User is not authorized');
            };

            const logs = await captureConsoleLog(async () => {
                await handler.provisioners.provisionAiRegistryHub(profileData);
            });

            // AC-1.5: Should NOT throw — bootstrap continues
            // Should log a warning
            assert.ok(
                logs.some(l => l.includes('⚠️') && l.includes('non-fatal')),
                `Expected non-fatal warning message, got: ${logs.join('\n')}`
            );

            // Should NOT store hub info in profile (creation failed)
            assert.strictEqual(profileData.aiRegistryHubName, undefined);
            assert.strictEqual(profileData.aiRegistryHubArn, undefined);
        });

        it('should catch create-hub failure and print a warning', async () => {
            const profileData = {
                accountId: '555666777888',
                awsRegion: 'ap-southeast-1'
            };

            handler._currentProfile = 'ap-profile';

            // Hub doesn't exist
            handler._resourceExists = () => false;

            // Mock _formatTagsForCli
            handler._formatTagsForCli = () => 'file:///tmp/tags.json';

            // create-hub fails
            handler._execAws = (cmd) => {
                if (cmd.includes('create-hub')) {
                    throw new Error('ServiceQuotaExceededException: Hub limit reached');
                }
                return {};
            };

            const logs = await captureConsoleLog(async () => {
                await handler.provisioners.provisionAiRegistryHub(profileData);
            });

            // Should NOT throw
            // Should log a warning about non-fatal failure
            assert.ok(
                logs.some(l => l.includes('⚠️') && l.includes('non-fatal')),
                `Expected non-fatal warning, got: ${logs.join('\n')}`
            );

            // Should NOT store hub info
            assert.strictEqual(profileData.aiRegistryHubName, undefined);
        });
    });

    describe('provisionAiRegistryHub — deterministic hub naming', () => {
        it('should always use mlcc-registry-{accountId} as the hub name', async () => {
            const testCases = [
                { accountId: '000000000000', expected: 'mlcc-registry-000000000000' },
                { accountId: '123456789012', expected: 'mlcc-registry-123456789012' },
                { accountId: '999999999999', expected: 'mlcc-registry-999999999999' }
            ];

            for (const { accountId, expected } of testCases) {
                const profileData = { accountId, awsRegion: 'us-east-1' };
                const commands = [];

                handler._resourceExists = (cmd) => {
                    commands.push(cmd);
                    return true; // hub exists
                };
                handler._execAws = (cmd) => {
                    commands.push(cmd);
                    return { HubArn: `arn:aws:sagemaker:us-east-1:${accountId}:hub/${expected}` };
                };

                await captureConsoleLog(async () => {
                    await handler.provisioners.provisionAiRegistryHub(profileData);
                });

                assert.strictEqual(profileData.aiRegistryHubName, expected);
                assert.ok(
                    commands.some(c => c.includes(`--hub-name ${expected}`)),
                    `Should check hub with name ${expected}`
                );
            }
        });
    });

    describe('bootstrap status — AI Registry hub display (AC-3.3)', () => {
        it('should display hub status when aiRegistryHubName is in profile', async () => {
            const mockConfig = {
                profiles: {
                    default: {
                        awsProfile: 'test-profile',
                        awsRegion: 'us-west-2',
                        accountId: '123456789012',
                        stackName: 'mlcc-bootstrap-default',
                        aiRegistryHubName: 'mlcc-registry-123456789012',
                        aiRegistryHubArn: 'arn:aws:sagemaker:us-west-2:123456789012:hub/mlcc-registry-123456789012'
                    }
                },
                activeProfile: 'default'
            };

            handler.config.read = () => mockConfig;
            handler.config.getActiveProfile = () => ({ name: 'default', config: mockConfig.profiles.default });
            handler.config.listProfiles = () => ['default'];

            // Mock _execAws for stack describe and hub describe
            handler._execAws = (cmd) => {
                if (cmd.includes('describe-stacks')) {
                    return {
                        Stacks: [{
                            StackStatus: 'CREATE_COMPLETE',
                            Outputs: [
                                { OutputKey: 'RoleArn', OutputValue: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role' }
                            ]
                        }]
                    };
                }
                if (cmd.includes('describe-hub')) {
                    return {
                        HubArn: 'arn:aws:sagemaker:us-west-2:123456789012:hub/mlcc-registry-123456789012'
                    };
                }
                return {};
            };

            handler._resourceExists = (_cmd) => {
                return true; // All resources exist
            };

            const logs = await captureConsoleLog(async () => {
                await handler._handleStatus({});
            });

            // AC-3.3: Should show AI Registry hub status
            assert.ok(
                logs.some(l => l.includes('AI Registry hub') && l.includes('mlcc-registry-123456789012')),
                `Expected AI Registry hub status, got: ${logs.join('\n')}`
            );
        });

        it('should show "not provisioned" when aiRegistryHubName is missing from profile', async () => {
            const mockConfig = {
                profiles: {
                    legacy: {
                        awsProfile: 'test-profile',
                        awsRegion: 'us-east-1',
                        accountId: '123456789012',
                        stackName: 'mlcc-bootstrap-legacy'
                    }
                },
                activeProfile: 'legacy'
            };

            handler.config.read = () => mockConfig;
            handler.config.getActiveProfile = () => ({ name: 'legacy', config: mockConfig.profiles.legacy });
            handler.config.listProfiles = () => ['legacy'];

            handler._execAws = (cmd) => {
                if (cmd.includes('describe-stacks')) {
                    return {
                        Stacks: [{
                            StackStatus: 'CREATE_COMPLETE',
                            Outputs: []
                        }]
                    };
                }
                return {};
            };

            handler._resourceExists = () => true;

            const logs = await captureConsoleLog(async () => {
                await handler._handleStatus({});
            });

            // Legacy profile without aiRegistryHubName should NOT show registry hub line
            assert.ok(
                !logs.some(l => l.includes('AI Registry hub')),
                `Expected no AI Registry hub message for legacy profile without it, got: ${logs.join('\n')}`
            );
        });
    });
});

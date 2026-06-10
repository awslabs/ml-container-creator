// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for BootstrapCommandHandler._handleMigrate()
 *
 * Tests the migrate subcommand which upgrades legacy profiles to current
 * naming conventions:
 * 1. No changes needed — logs success message, no writes
 * 2. One profile needs stackName fix — confirms → config written with corrected stackName
 * 3. Multiple profiles need fixes (stackName + sharedStackFrom → sharedInfraFrom) — confirms → all fixed
 * 4. User declines confirmation — no changes written to config
 * 5. Empty/null config — exits gracefully with message
 *
 * Validates: Requirements 6.4, 6.5
 */

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

/**
 * Creates a handler with mocked internals for _handleMigrate testing.
 *
 * @param {object} opts
 * @param {object|null} opts.configData - Data returned by config.read()
 * @param {boolean} opts.userConfirms - Whether the user confirms the migration
 * @returns {{ handler, logs, writeCalls, restore }}
 */
function setupHandler(opts = {}) {
    const {
        configData = null,
        userConfirms = true
    } = opts;

    const handler = new BootstrapCommandHandler({
        promptFn: async () => ({ confirm: userConfirms })
    });

    const logs = [];
    const writeCalls = [];

    // Mock config.read and config.write
    handler.config = {
        read: () => configData,
        write: (data) => { writeCalls.push(JSON.parse(JSON.stringify(data))); }
    };

    // Capture console.log output
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    const restore = () => { console.log = origLog; };

    return { handler, logs, writeCalls, restore };
}

describe('BootstrapCommandHandler._handleMigrate', () => {
    let restoreFn;

    afterEach(() => {
        if (restoreFn) {
            restoreFn();
            restoreFn = null;
        }
    });

    describe('no changes needed', () => {
        it('logs success message when all profiles already use correct naming', async () => {
            const configData = {
                activeProfile: 'mlcc-us-west-2',
                profiles: {
                    'mlcc-us-west-2': {
                        awsRegion: 'us-west-2',
                        accountId: '123456789012',
                        stackName: 'mlcc-bootstrap-mlcc-us-west-2',
                        roleArn: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role'
                    },
                    'mlcc-us-east-1': {
                        awsRegion: 'us-east-1',
                        accountId: '123456789012',
                        stackName: 'mlcc-bootstrap-mlcc-us-east-1',
                        roleArn: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role'
                    }
                }
            };

            const { handler, logs, writeCalls, restore } = setupHandler({ configData });
            restoreFn = restore;

            await handler._handleMigrate();

            assert.ok(
                logs.some(l => l.includes('All profiles already use current naming conventions')),
                'should display success message when no changes needed'
            );
            assert.strictEqual(writeCalls.length, 0, 'should not write config when no changes needed');
        });

        it('does not prompt user when no changes needed', async () => {
            const configData = {
                activeProfile: 'default',
                profiles: {
                    'default': {
                        stackName: 'mlcc-bootstrap-default',
                        awsRegion: 'us-west-2'
                    }
                }
            };

            let promptCalled = false;
            const handler = new BootstrapCommandHandler({
                promptFn: async () => {
                    promptCalled = true;
                    return { confirm: true };
                }
            });
            handler.config = {
                read: () => configData,
                write: () => {}
            };

            const origLog = console.log;
            console.log = () => {};
            restoreFn = () => { console.log = origLog; };

            await handler._handleMigrate();

            assert.strictEqual(promptCalled, false, 'should not prompt when no changes needed');
        });
    });

    describe('one profile needs stackName fix', () => {
        it('corrects stackName when user confirms', async () => {
            const configData = {
                activeProfile: 'mlcc-us-west-2',
                profiles: {
                    'mlcc-us-west-2': {
                        awsRegion: 'us-west-2',
                        accountId: '123456789012',
                        stackName: 'mlcc-bootstrap-old-name',
                        roleArn: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role'
                    }
                }
            };

            const { handler, logs, writeCalls, restore } = setupHandler({
                configData,
                userConfirms: true
            });
            restoreFn = restore;

            await handler._handleMigrate();

            // Should display preview
            assert.ok(
                logs.some(l => l.includes('Migration Preview')),
                'should display migration preview'
            );
            assert.ok(
                logs.some(l => l.includes('mlcc-bootstrap-old-name') && l.includes('mlcc-bootstrap-mlcc-us-west-2')),
                'should show from/to values in preview'
            );

            // Should write config with corrected stackName
            assert.strictEqual(writeCalls.length, 1, 'should write config once');
            const written = writeCalls[0];
            assert.strictEqual(
                written.profiles['mlcc-us-west-2'].stackName,
                'mlcc-bootstrap-mlcc-us-west-2',
                'should correct stackName to match profile name'
            );

            // Should log completion
            assert.ok(
                logs.some(l => l.includes('Migration complete')),
                'should display migration complete message'
            );
        });
    });

    describe('multiple profiles need fixes', () => {
        it('fixes stackName and renames sharedStackFrom to sharedInfraFrom', async () => {
            const configData = {
                activeProfile: 'mlcc-us-west-2',
                profiles: {
                    'mlcc-us-west-2': {
                        awsRegion: 'us-west-2',
                        accountId: '123456789012',
                        stackName: 'mlcc-bootstrap-wrong',
                        roleArn: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role'
                    },
                    'mlcc-us-east-1': {
                        awsRegion: 'us-east-1',
                        accountId: '123456789012',
                        stackName: 'mlcc-bootstrap-mlcc-us-east-1',
                        sharedStackFrom: 'mlcc-bootstrap-mlcc-us-west-2',
                        roleArn: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role'
                    }
                }
            };

            const { handler, logs, writeCalls, restore } = setupHandler({
                configData,
                userConfirms: true
            });
            restoreFn = restore;

            await handler._handleMigrate();

            // Should write config once
            assert.strictEqual(writeCalls.length, 1, 'should write config once');
            const written = writeCalls[0];

            // First profile: stackName fixed
            assert.strictEqual(
                written.profiles['mlcc-us-west-2'].stackName,
                'mlcc-bootstrap-mlcc-us-west-2',
                'should correct first profile stackName'
            );

            // Second profile: sharedStackFrom renamed to sharedInfraFrom
            assert.strictEqual(
                written.profiles['mlcc-us-east-1'].sharedInfraFrom,
                'mlcc-bootstrap-mlcc-us-west-2',
                'should rename sharedStackFrom to sharedInfraFrom'
            );
            assert.strictEqual(
                written.profiles['mlcc-us-east-1'].sharedStackFrom,
                undefined,
                'should remove the legacy sharedStackFrom field'
            );

            // Preview should mention both profiles
            assert.ok(
                logs.some(l => l.includes('mlcc-us-west-2')),
                'preview should mention first profile'
            );
            assert.ok(
                logs.some(l => l.includes('mlcc-us-east-1')),
                'preview should mention second profile'
            );
        });
    });

    describe('user declines confirmation', () => {
        it('does not write config when user declines', async () => {
            const configData = {
                activeProfile: 'mlcc-us-west-2',
                profiles: {
                    'mlcc-us-west-2': {
                        awsRegion: 'us-west-2',
                        accountId: '123456789012',
                        stackName: 'mlcc-bootstrap-old-name',
                        roleArn: 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role'
                    }
                }
            };

            const { handler, logs, writeCalls, restore } = setupHandler({
                configData,
                userConfirms: false
            });
            restoreFn = restore;

            await handler._handleMigrate();

            // Should display preview (still shows what would change)
            assert.ok(
                logs.some(l => l.includes('Migration Preview')),
                'should still display migration preview before prompting'
            );

            // Should NOT write config
            assert.strictEqual(writeCalls.length, 0, 'should not write config when user declines');

            // Should NOT display migration complete
            assert.ok(
                !logs.some(l => l.includes('Migration complete')),
                'should not display migration complete message'
            );
        });
    });

    describe('empty/null config', () => {
        it('exits gracefully when config is null', async () => {
            const { handler, logs, writeCalls, restore } = setupHandler({
                configData: null
            });
            restoreFn = restore;

            await handler._handleMigrate();

            assert.ok(
                logs.some(l => l.includes('No profiles to migrate')),
                'should display no profiles message for null config'
            );
            assert.strictEqual(writeCalls.length, 0, 'should not write config for null config');
        });

        it('exits gracefully when config has no profiles key', async () => {
            const { handler, logs, writeCalls, restore } = setupHandler({
                configData: { activeProfile: 'default' }
            });
            restoreFn = restore;

            await handler._handleMigrate();

            assert.ok(
                logs.some(l => l.includes('No profiles to migrate')),
                'should display no profiles message when profiles key is missing'
            );
            assert.strictEqual(writeCalls.length, 0, 'should not write config when no profiles');
        });

        it('exits gracefully when profiles object is empty', async () => {
            const { handler, logs, writeCalls, restore } = setupHandler({
                configData: { activeProfile: 'default', profiles: {} }
            });
            restoreFn = restore;

            await handler._handleMigrate();

            assert.ok(
                logs.some(l => l.includes('All profiles already use current naming conventions')),
                'should display success message for empty profiles object'
            );
            assert.strictEqual(writeCalls.length, 0, 'should not write config for empty profiles');
        });
    });
});

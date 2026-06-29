// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Integration Unit Tests for sync-serving-versions
 *
 * Tests that BootstrapCommandHandler.handle() correctly dispatches the
 * sync-serving-versions subcommand and that help text includes the entry.
 *
 * Validates: Requirements 8.1, 8.2, 8.3
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

describe('Bootstrap sync-serving-versions integration', () => {
    let handler;
    let calls;

    beforeEach(() => {
        handler = new BootstrapCommandHandler();
        calls = {
            syncServingVersions: [],
            interactiveSetup: []
        };

        // Override internal handler methods with spies
        handler._handleSyncServingVersions = async () => {
            calls.syncServingVersions.push({});
        };
        handler._handleInteractiveSetup = async (options) => {
            calls.interactiveSetup.push({ options });
        };
    });

    describe('subcommand dispatch', () => {
        it('handle(["sync-serving-versions"], {}) calls _handleSyncServingVersions', async () => {
            await handler.handle(['sync-serving-versions'], {});

            assert.strictEqual(calls.syncServingVersions.length, 1, 'should call _handleSyncServingVersions once');
            assert.strictEqual(calls.interactiveSetup.length, 0, 'should not call interactive setup');
        });
    });

    describe('help text', () => {
        it('help text includes sync-serving-versions', () => {
            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                handler._showHelp();
            } finally {
                console.log = origLog;
            }

            const helpOutput = logs.join('\n');
            assert.ok(
                helpOutput.includes('sync-serving-versions'),
                'help text should include sync-serving-versions subcommand'
            );
        });
    });
});

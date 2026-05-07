// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Subcommand Routing Unit Tests
 *
 * Tests that BootstrapCommandHandler.handle() correctly dispatches
 * subcommands (status, use, list, remove, unknown, default interactive)
 * to the appropriate internal handler methods.
 *
 * Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

/**
 * Creates a minimal mock generator with a prompt method.
 * @returns {object} Mock generator
 */
// eslint-disable-next-line no-unused-vars
function createMockGenerator() {
    return {
        prompt: async () => ({})
    };
}

describe('Bootstrap Subcommand Routing', () => {
    let handler;
    let calls;

    beforeEach(() => {
        handler = new BootstrapCommandHandler();
        calls = {
            interactiveSetup: [],
            status: [],
            use: [],
            list: [],
            remove: [],
            showHelp: []
        };

        // Override internal handler methods with spies
        handler._handleInteractiveSetup = async (options) => {
            calls.interactiveSetup.push({ options });
        };
        handler._handleStatus = async () => {
            calls.status.push({});
        };
        handler._handleUse = async (profileName) => {
            calls.use.push({ profileName });
        };
        handler._handleList = async () => {
            calls.list.push({});
        };
        handler._handleRemove = async (profileName, options) => {
            calls.remove.push({ profileName, options });
        };
        handler._showHelp = () => {
            calls.showHelp.push({});
        };
    });

    describe('default interactive flow', () => {
        it('handle([], options) calls _handleInteractiveSetup(options)', async () => {
            const options = { 'non-interactive': false };
            await handler.handle([], options);

            assert.strictEqual(calls.interactiveSetup.length, 1, 'should call _handleInteractiveSetup once');
            assert.deepStrictEqual(calls.interactiveSetup[0].options, options);
            assert.strictEqual(calls.status.length, 0);
            assert.strictEqual(calls.use.length, 0);
            assert.strictEqual(calls.list.length, 0);
            assert.strictEqual(calls.remove.length, 0);
        });
    });

    describe('status subcommand', () => {
        it('handle(["status"], options) calls _handleStatus()', async () => {
            await handler.handle(['status'], {});

            assert.strictEqual(calls.status.length, 1, 'should call _handleStatus once');
            assert.strictEqual(calls.interactiveSetup.length, 0);
            assert.strictEqual(calls.use.length, 0);
            assert.strictEqual(calls.list.length, 0);
            assert.strictEqual(calls.remove.length, 0);
        });
    });

    describe('use subcommand', () => {
        it('handle(["use", "dev"], options) calls _handleUse("dev")', async () => {
            await handler.handle(['use', 'dev'], {});

            assert.strictEqual(calls.use.length, 1, 'should call _handleUse once');
            assert.strictEqual(calls.use[0].profileName, 'dev');
            assert.strictEqual(calls.interactiveSetup.length, 0);
            assert.strictEqual(calls.status.length, 0);
            assert.strictEqual(calls.list.length, 0);
            assert.strictEqual(calls.remove.length, 0);
        });
    });

    describe('list subcommand', () => {
        it('handle(["list"], options) calls _handleList()', async () => {
            await handler.handle(['list'], {});

            assert.strictEqual(calls.list.length, 1, 'should call _handleList once');
            assert.strictEqual(calls.interactiveSetup.length, 0);
            assert.strictEqual(calls.status.length, 0);
            assert.strictEqual(calls.use.length, 0);
            assert.strictEqual(calls.remove.length, 0);
        });
    });

    describe('remove subcommand', () => {
        it('handle(["remove", "dev"], options) calls _handleRemove("dev", options)', async () => {
            const options = { force: true };
            await handler.handle(['remove', 'dev'], options);

            assert.strictEqual(calls.remove.length, 1, 'should call _handleRemove once');
            assert.strictEqual(calls.remove[0].profileName, 'dev');
            assert.deepStrictEqual(calls.remove[0].options, options);
            assert.strictEqual(calls.interactiveSetup.length, 0);
            assert.strictEqual(calls.status.length, 0);
            assert.strictEqual(calls.use.length, 0);
            assert.strictEqual(calls.list.length, 0);
        });
    });

    describe('unknown subcommand', () => {
        it('handle(["unknown"], options) logs error and calls _showHelp()', async () => {
            const logs = [];
            const origLog = console.log;
            console.log = (...a) => logs.push(a.join(' '));

            try {
                await handler.handle(['unknown'], {});
            } finally {
                console.log = origLog;
            }

            assert.strictEqual(calls.showHelp.length, 1, 'should call _showHelp once');
            assert.ok(logs.some(l => l.includes('Unknown bootstrap subcommand')), 'should log error about unknown subcommand');
            assert.strictEqual(calls.interactiveSetup.length, 0);
            assert.strictEqual(calls.status.length, 0);
            assert.strictEqual(calls.use.length, 0);
            assert.strictEqual(calls.list.length, 0);
            assert.strictEqual(calls.remove.length, 0);
        });
    });

    describe('case-insensitive subcommands', () => {
        it('handle(["STATUS"], options) calls _handleStatus()', async () => {
            await handler.handle(['STATUS'], {});

            assert.strictEqual(calls.status.length, 1, 'should call _handleStatus for uppercase STATUS');
        });

        it('handle(["Use", "prod"], options) calls _handleUse("prod")', async () => {
            await handler.handle(['Use', 'prod'], {});

            assert.strictEqual(calls.use.length, 1);
            assert.strictEqual(calls.use[0].profileName, 'prod');
        });

        it('handle(["LIST"], options) calls _handleList()', async () => {
            await handler.handle(['LIST'], {});

            assert.strictEqual(calls.list.length, 1);
        });

        it('handle(["REMOVE", "staging"], options) calls _handleRemove("staging", options)', async () => {
            const options = { force: false };
            await handler.handle(['REMOVE', 'staging'], options);

            assert.strictEqual(calls.remove.length, 1);
            assert.strictEqual(calls.remove[0].profileName, 'staging');
            assert.deepStrictEqual(calls.remove[0].options, options);
        });
    });
});

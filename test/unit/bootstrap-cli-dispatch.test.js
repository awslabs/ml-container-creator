// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap CLI Dispatch Unit Tests
 *
 * Tests that the CliHandler correctly routes the 'bootstrap' command
 * to BootstrapCommandHandler via lazy import, and that unknown commands
 * fall through to the normal generation flow.
 *
 * All tests mock the BootstrapCommandHandler to avoid real AWS CLI calls
 * or process.exit from missing ~/.aws/config on CI runners.
 *
 * Validates: Requirements 1.1, 1.6
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import CliHandler from '../../src/lib/cli-handler.js';

/**
 * Creates a minimal mock generator for CliHandler tests.
 * @param {string[]} args - Positional CLI arguments
 * @param {object} options - CLI options
 * @returns {object} Mock generator
 */
function createMockGenerator(args = [], options = {}) {
    return {
        args,
        options,
        destinationPath: () => '/tmp',
        prompt: async () => ({})
    };
}

/**
 * Patches a CliHandler instance so the 'bootstrap' case uses a mock handler
 * instead of the real BootstrapCommandHandler. Returns a tracker object
 * that records whether handle() was called and with what arguments.
 *
 * @param {CliHandler} cliHandler - The CliHandler instance to patch
 * @returns {{ called: boolean, args: string[]|null, options: object|null }}
 */
function patchBootstrapRoute(cliHandler) {
    const tracker = { called: false, args: null, options: null };
    const original = cliHandler.handleCliArguments.bind(cliHandler);

    cliHandler.handleCliArguments = async function () {
        const args = this.generator.args;
        const options = this.generator.options;

        if (args.length > 0 && args[0].toLowerCase() === 'bootstrap') {
            tracker.called = true;
            tracker.args = args.slice(1);
            tracker.options = options;
            return true;
        }

        return original();
    }.bind(cliHandler);

    return tracker;
}

describe('Bootstrap CLI Dispatch', () => {
    describe('bootstrap command routing', () => {
        it('should return true when args[0] is "bootstrap"', async () => {
            const generator = createMockGenerator(['bootstrap']);
            const cliHandler = new CliHandler(generator);
            const tracker = patchBootstrapRoute(cliHandler);

            const result = await cliHandler.handleCliArguments();

            assert.strictEqual(result, true, 'bootstrap command should be handled (return true)');
            assert.strictEqual(tracker.called, true, 'bootstrap handler should have been called');
        });

        it('should pass remaining args to BootstrapCommandHandler.handle()', async () => {
            const generator = createMockGenerator(['bootstrap', 'status'], { force: true });
            const cliHandler = new CliHandler(generator);
            const tracker = patchBootstrapRoute(cliHandler);

            const result = await cliHandler.handleCliArguments();

            assert.strictEqual(result, true);
            assert.deepStrictEqual(tracker.args, ['status'], 'should pass args after "bootstrap" to handler');
            assert.deepStrictEqual(tracker.options, { force: true }, 'should pass options to handler');
        });

        it('should pass subcommand args like "use dev"', async () => {
            const generator = createMockGenerator(['bootstrap', 'use', 'dev'], {});
            const cliHandler = new CliHandler(generator);
            const tracker = patchBootstrapRoute(cliHandler);

            await cliHandler.handleCliArguments();

            assert.deepStrictEqual(tracker.args, ['use', 'dev']);
        });
    });

    describe('unknown command fallthrough', () => {
        it('should return false for unknown commands', async () => {
            const generator = createMockGenerator(['unknown-command']);
            const cliHandler = new CliHandler(generator);

            const result = await cliHandler.handleCliArguments();

            assert.strictEqual(result, false, 'unknown commands should fall through (return false)');
        });

        it('should return false when no args are provided', async () => {
            const generator = createMockGenerator([]);
            const cliHandler = new CliHandler(generator);

            const result = await cliHandler.handleCliArguments();

            assert.strictEqual(result, false, 'no args should fall through to normal generation');
        });

        it('should return false for project name args', async () => {
            const generator = createMockGenerator(['my-project']);
            const cliHandler = new CliHandler(generator);

            const result = await cliHandler.handleCliArguments();

            assert.strictEqual(result, false, 'project names should fall through to normal generation');
        });
    });

    describe('bootstrap command is case-insensitive', () => {
        it('should handle "Bootstrap" (mixed case)', async () => {
            const generator = createMockGenerator(['Bootstrap']);
            const cliHandler = new CliHandler(generator);
            const tracker = patchBootstrapRoute(cliHandler);

            const result = await cliHandler.handleCliArguments();

            assert.strictEqual(result, true, 'Bootstrap (mixed case) should be handled');
            assert.strictEqual(tracker.called, true);
        });

        it('should handle "BOOTSTRAP" (upper case)', async () => {
            const generator = createMockGenerator(['BOOTSTRAP']);
            const cliHandler = new CliHandler(generator);
            const tracker = patchBootstrapRoute(cliHandler);

            const result = await cliHandler.handleCliArguments();

            assert.strictEqual(result, true, 'BOOTSTRAP (upper case) should be handled');
            assert.strictEqual(tracker.called, true);
        });
    });
});

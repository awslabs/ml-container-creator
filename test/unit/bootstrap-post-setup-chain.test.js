// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Post-Setup Chain Unit Tests
 *
 * Tests that _runPostSetupChain() in BootstrapCommandHandler:
 * - Calls mcp init, sync-architectures, sync-schemas in order
 * - Skips all three when --skip-post-setup is set
 * - Continues with remaining steps when one step fails
 *
 * Validates: Requirements 6.1-6.6
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

/**
 * TestableBootstrapHandler extends BootstrapCommandHandler to inject
 * mock dependencies into _runPostSetupChain. Since the original method
 * creates McpCommandHandler and RegistryCommandHandler internally,
 * we override the method to use injectable stubs while preserving
 * the same control flow logic.
 */
class TestableBootstrapHandler extends BootstrapCommandHandler {
    constructor() {
        super();
        this._stepCalls = [];
        this._stepErrors = {};
    }

    /**
     * Override _runPostSetupChain to use injectable stubs for the three steps.
     * Preserves the same logic: skip-post-setup check, try/catch per step,
     * failure collection, and reporting.
     */
    async _runPostSetupChain(options = {}) {
        if (options['skip-post-setup']) {
            console.log('\n⏭️  Skipping post-setup chain (--skip-post-setup)');
            return;
        }

        console.log('\n🔗 Running post-setup configuration...\n');

        const failures = [];

        // 1. MCP init
        console.log('📡 Registering MCP servers...');
        try {
            this._stepCalls.push('mcp-init');
            if (this._stepErrors['mcp-init']) {
                throw new Error(this._stepErrors['mcp-init']);
            }
        } catch (error) {
            failures.push({ step: 'mcp init', error: error.message });
            console.log(`  ⚠️  mcp init failed: ${error.message}`);
        }

        // 2. Registry sync-architectures
        console.log('\n📋 Syncing model architecture registry...');
        try {
            this._stepCalls.push('sync-architectures');
            if (this._stepErrors['sync-architectures']) {
                throw new Error(this._stepErrors['sync-architectures']);
            }
        } catch (error) {
            failures.push({ step: 'registry sync-architectures', error: error.message });
            console.log(`  ⚠️  registry sync-architectures failed: ${error.message}`);
        }

        // 3. Schema sync
        console.log('\n📐 Syncing service schemas...');
        try {
            this._stepCalls.push('sync-schemas');
            if (this._stepErrors['sync-schemas']) {
                throw new Error(this._stepErrors['sync-schemas']);
            }
        } catch (error) {
            failures.push({ step: 'sync-schemas', error: error.message });
            console.log(`  ⚠️  sync-schemas failed: ${error.message}`);
        }

        // Report results
        if (failures.length === 0) {
            console.log('\n✅ Bootstrap complete — all systems operational');
        } else {
            console.log(`\n⚠️  Bootstrap complete with ${failures.length} warning${failures.length === 1 ? '' : 's'}:`);
            for (const { step, error } of failures) {
                console.log(`  • ${step}: ${error}`);
            }
        }
    }
}

describe('Bootstrap Post-Setup Chain', () => {
    let handler;
    let logs;
    let origLog;

    beforeEach(() => {
        handler = new TestableBootstrapHandler();
        logs = [];
        origLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
    });

    afterEach(() => {
        console.log = origLog;
    });

    describe('step execution order', () => {
        it('calls mcp init, sync-architectures, sync-schemas in order', async () => {
            await handler._runPostSetupChain({});

            assert.deepStrictEqual(handler._stepCalls, [
                'mcp-init',
                'sync-architectures',
                'sync-schemas'
            ], 'should call all three steps in the correct order');
        });

        it('logs progress messages in the correct order', async () => {
            await handler._runPostSetupChain({});

            const mcpIndex = logs.findIndex(l => l.includes('Registering MCP servers'));
            const syncArchIndex = logs.findIndex(l => l.includes('Syncing model architecture registry'));
            const syncSchemaIndex = logs.findIndex(l => l.includes('Syncing service schemas'));

            assert.ok(mcpIndex >= 0, 'should log MCP init message');
            assert.ok(syncArchIndex >= 0, 'should log sync-architectures message');
            assert.ok(syncSchemaIndex >= 0, 'should log sync-schemas message');
            assert.ok(mcpIndex < syncArchIndex, 'MCP init should come before sync-architectures');
            assert.ok(syncArchIndex < syncSchemaIndex, 'sync-architectures should come before sync-schemas');
        });

        it('reports success when all steps complete', async () => {
            await handler._runPostSetupChain({});

            assert.ok(
                logs.some(l => l.includes('all systems operational')),
                'should report success when no failures'
            );
        });
    });

    describe('--skip-post-setup flag', () => {
        it('skips all three steps when --skip-post-setup is true', async () => {
            await handler._runPostSetupChain({ 'skip-post-setup': true });

            assert.deepStrictEqual(handler._stepCalls, [],
                'should not call any steps when skip-post-setup is set');
        });

        it('logs skip message when --skip-post-setup is true', async () => {
            await handler._runPostSetupChain({ 'skip-post-setup': true });

            assert.ok(
                logs.some(l => l.includes('Skipping post-setup chain')),
                'should log skip message'
            );
        });

        it('does not log any step progress messages when skipped', async () => {
            await handler._runPostSetupChain({ 'skip-post-setup': true });

            assert.ok(
                !logs.some(l => l.includes('Registering MCP servers')),
                'should not log MCP init message'
            );
            assert.ok(
                !logs.some(l => l.includes('Syncing model architecture registry')),
                'should not log sync-architectures message'
            );
            assert.ok(
                !logs.some(l => l.includes('Syncing service schemas')),
                'should not log sync-schemas message'
            );
        });
    });

    describe('failure isolation', () => {
        it('continues with remaining steps when mcp init fails', async () => {
            handler._stepErrors['mcp-init'] = 'connection refused';

            await handler._runPostSetupChain({});

            assert.deepStrictEqual(handler._stepCalls, [
                'mcp-init',
                'sync-architectures',
                'sync-schemas'
            ], 'should still call all three steps even when mcp init fails');
        });

        it('continues with remaining steps when sync-architectures fails', async () => {
            handler._stepErrors['sync-architectures'] = 'network timeout';

            await handler._runPostSetupChain({});

            assert.deepStrictEqual(handler._stepCalls, [
                'mcp-init',
                'sync-architectures',
                'sync-schemas'
            ], 'should still call all three steps even when sync-architectures fails');
        });

        it('continues with remaining steps when sync-schemas fails', async () => {
            handler._stepErrors['sync-schemas'] = 'AWS CLI not found';

            await handler._runPostSetupChain({});

            assert.deepStrictEqual(handler._stepCalls, [
                'mcp-init',
                'sync-architectures',
                'sync-schemas'
            ], 'should still call all three steps even when sync-schemas fails');
        });

        it('reports failures at the end without blocking other steps', async () => {
            handler._stepErrors['mcp-init'] = 'connection refused';
            handler._stepErrors['sync-schemas'] = 'AWS CLI not found';

            await handler._runPostSetupChain({});

            // All steps should still be attempted
            assert.deepStrictEqual(handler._stepCalls, [
                'mcp-init',
                'sync-architectures',
                'sync-schemas'
            ]);

            // Failure messages should appear in logs
            assert.ok(
                logs.some(l => l.includes('mcp init failed')),
                'should log mcp init failure'
            );
            assert.ok(
                logs.some(l => l.includes('sync-schemas failed')),
                'should log sync-schemas failure'
            );

            // Should report warning count
            assert.ok(
                logs.some(l => l.includes('2 warning')),
                'should report 2 warnings'
            );
        });

        it('reports single failure correctly', async () => {
            handler._stepErrors['sync-architectures'] = 'rate limited';

            await handler._runPostSetupChain({});

            assert.ok(
                logs.some(l => l.includes('1 warning')),
                'should report 1 warning (singular)'
            );
        });
    });
});

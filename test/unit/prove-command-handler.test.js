// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for prove-command-handler.js
 *
 * Tests sweep expansion, config hash determinism, and status reading.
 *
 * Feature: prove-mvp
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import ProveCommandHandler from '../../src/lib/prove-command-handler.js';

// ── Test Helpers ─────────────────────────────────────────────────────────────

let testDir;
let handler;

function createTestDir() {
    testDir = path.join(tmpdir(), `mlcc-prove-cmd-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    return testDir;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('prove-command-handler', () => {
    beforeEach(() => {
        testDir = createTestDir();
        handler = new ProveCommandHandler();
    });

    afterEach(() => {
        if (testDir) {
            try {
                rmSync(testDir, { recursive: true, force: true });
            } catch { /* ignore cleanup errors */ }
        }
    });

    describe('expandSweep', () => {
        it('returns single config when no sweep axes', () => {
            const proveConfig = {
                base: { model_name: 'Qwen/Qwen3-4B', deployment_config: 'transformers-vllm' },
                sweep: {}
            };
            const configs = handler.expandSweep(proveConfig);
            assert.strictEqual(configs.length, 1);
            assert.strictEqual(configs[0].model_name, 'Qwen/Qwen3-4B');
        });

        it('expands single axis into multiple configs', () => {
            const proveConfig = {
                base: { model_name: 'Qwen/Qwen3-4B' },
                sweep: { quantization: ['fp8', 'bf16'] }
            };
            const configs = handler.expandSweep(proveConfig);
            assert.strictEqual(configs.length, 2);
            assert.strictEqual(configs[0].quantization, 'fp8');
            assert.strictEqual(configs[1].quantization, 'bf16');
            // Base fields preserved
            assert.strictEqual(configs[0].model_name, 'Qwen/Qwen3-4B');
            assert.strictEqual(configs[1].model_name, 'Qwen/Qwen3-4B');
        });

        it('produces Cartesian product for multiple axes', () => {
            const proveConfig = {
                base: { model_name: 'X' },
                sweep: {
                    quantization: ['fp8', 'bf16'],
                    instance_type: ['ml.g5.xlarge', 'ml.g5.2xlarge']
                }
            };
            const configs = handler.expandSweep(proveConfig);
            assert.strictEqual(configs.length, 4); // 2 × 2
            // Verify all combinations exist
            const combos = configs.map(c => `${c.quantization}:${c.instance_type}`);
            assert.ok(combos.includes('fp8:ml.g5.xlarge'));
            assert.ok(combos.includes('fp8:ml.g5.2xlarge'));
            assert.ok(combos.includes('bf16:ml.g5.xlarge'));
            assert.ok(combos.includes('bf16:ml.g5.2xlarge'));
        });

        it('handles missing sweep field as no sweep', () => {
            const proveConfig = {
                base: { model_name: 'X' }
            };
            const configs = handler.expandSweep(proveConfig);
            assert.strictEqual(configs.length, 1);
        });

        it('ignores empty sweep arrays', () => {
            const proveConfig = {
                base: { model_name: 'X' },
                sweep: { quantization: [] }
            };
            const configs = handler.expandSweep(proveConfig);
            assert.strictEqual(configs.length, 1);
        });

        it('sweep values override base values', () => {
            const proveConfig = {
                base: { model_name: 'X', quantization: 'fp16' },
                sweep: { quantization: ['fp8', 'bf16'] }
            };
            const configs = handler.expandSweep(proveConfig);
            assert.strictEqual(configs.length, 2);
            assert.strictEqual(configs[0].quantization, 'fp8');
            assert.strictEqual(configs[1].quantization, 'bf16');
        });
    });

    describe('computeConfigHash', () => {
        it('produces deterministic hash for same input', () => {
            const config = { model_name: 'Qwen/Qwen3-4B', instance_type: 'ml.g5.xlarge' };
            const hash1 = handler.computeConfigHash(config);
            const hash2 = handler.computeConfigHash(config);
            assert.strictEqual(hash1, hash2);
        });

        it('produces same hash regardless of key order', () => {
            const config1 = { model_name: 'X', instance_type: 'Y' };
            const config2 = { instance_type: 'Y', model_name: 'X' };
            assert.strictEqual(
                handler.computeConfigHash(config1),
                handler.computeConfigHash(config2)
            );
        });

        it('produces different hashes for different configs', () => {
            const config1 = { model_name: 'A' };
            const config2 = { model_name: 'B' };
            assert.notStrictEqual(
                handler.computeConfigHash(config1),
                handler.computeConfigHash(config2)
            );
        });

        it('returns 16-character hex string', () => {
            const config = { model_name: 'test' };
            const hash = handler.computeConfigHash(config);
            assert.strictEqual(hash.length, 16);
            assert.ok(/^[0-9a-f]{16}$/.test(hash));
        });
    });

    describe('_handleStatus (prove status reads workspace)', () => {
        it('reports no workspaces when prove dir is empty', async () => {
            // Mock homedir by checking output (just verify no crash)
            // This test verifies the function runs without error
            const originalLog = console.log;
            const logs = [];
            console.log = (...args) => logs.push(args.join(' '));
            try {
                await handler._handleStatus({});
            } finally {
                console.log = originalLog;
            }
            // Should output something about no workspaces or status
            assert.ok(logs.some(l => l.includes('Prove') || l.includes('prove') || l.includes('No')));
        });
    });
});

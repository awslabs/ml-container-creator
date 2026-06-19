// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for Python helper (.stage_helper.py) subcommand dispatch.
 *
 * Tests:
 * - Each subcommand (submit, status, cancel) is correctly recognized
 * - Missing required args produce errors
 * - --help output shows expected usage info
 * - Unknown commands produce errors
 *
 * Validates: Requirements US-1, US-2
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_PATH = path.resolve(__dirname, '../../templates/do/.stage_helper.py');

/**
 * Run the Python helper with given args and return the result.
 */
function runHelper(args, options = {}) {
    const result = spawnSync('python3', [HELPER_PATH, ...args], {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, ...options.env }
    });
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status
    };
}

// ── Subcommand Recognition ───────────────────────────────────────────────────

describe('stage_helper.py subcommand dispatch', () => {
    before(function () {
        // Skip all tests if python3 is not available
        const check = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
        if (check.status !== 0) {
            this.skip();
        }
    });

    it('exits with error when no subcommand is provided', () => {
        const result = runHelper([]);
        assert.notStrictEqual(result.exitCode, 0, 'Should exit non-zero without subcommand');
    });

    it('recognizes submit subcommand (errors on missing required args)', () => {
        const result = runHelper(['submit']);
        assert.notStrictEqual(result.exitCode, 0);
        // argparse produces error about required args
        assert.ok(
            result.stderr.includes('--model-name') || result.stderr.includes('required'),
            'Should mention missing required argument'
        );
    });

    it('recognizes status subcommand (errors on missing --job-name)', () => {
        const result = runHelper(['status']);
        assert.notStrictEqual(result.exitCode, 0);
        assert.ok(
            result.stderr.includes('--job-name') || result.stderr.includes('required'),
            'Should mention missing --job-name'
        );
    });

    it('recognizes cancel subcommand (errors on missing --job-name)', () => {
        const result = runHelper(['cancel']);
        assert.notStrictEqual(result.exitCode, 0);
        assert.ok(
            result.stderr.includes('--job-name') || result.stderr.includes('required'),
            'Should mention missing --job-name'
        );
    });

    it('shows help with --help flag', () => {
        const result = runHelper(['--help']);
        assert.strictEqual(result.exitCode, 0);
        assert.ok(
            result.stdout.includes('submit') || result.stdout.includes('Processing Job'),
            'Help should mention submit subcommand'
        );
    });

    it('submit --help shows all required arguments', () => {
        const result = runHelper(['submit', '--help']);
        assert.strictEqual(result.exitCode, 0);
        assert.ok(result.stdout.includes('--model-name'), 'Should show --model-name');
        assert.ok(result.stdout.includes('--bucket'), 'Should show --bucket');
        assert.ok(result.stdout.includes('--project'), 'Should show --project');
        assert.ok(result.stdout.includes('--role-arn'), 'Should show --role-arn');
        assert.ok(result.stdout.includes('--region'), 'Should show --region');
        assert.ok(result.stdout.includes('--no-wait'), 'Should show --no-wait');
        assert.ok(result.stdout.includes('--force'), 'Should show --force');
    });

    it('rejects unknown subcommands', () => {
        const result = runHelper(['unknown-cmd']);
        assert.notStrictEqual(result.exitCode, 0);
    });
});

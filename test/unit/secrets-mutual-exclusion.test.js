// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '../../bin/cli.js');

/**
 * Helper to run the CLI with given args and capture output.
 * Returns { stdout, stderr, exitCode }.
 */
async function runCli(args) {
    try {
        const { stdout, stderr } = await execFileAsync('node', [CLI_PATH, ...args], {
            timeout: 10000,
            env: { ...process.env, NODE_ENV: 'test' }
        });
        return { stdout, stderr, exitCode: 0 };
    } catch (error) {
        return {
            stdout: error.stdout || '',
            stderr: error.stderr || '',
            exitCode: error.code || 1
        };
    }
}

describe('CLI mutual exclusion validation (Requirement 7.6)', function () {
    this.timeout(15000);
    describe('--hf-token and --hf-token-arn', () => {
        it('rejects when both --hf-token and --hf-token-arn are provided', async () => {
            const result = await runCli([
                '--hf-token', 'hf_test123',
                '--hf-token-arn', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf',
                '--skip-prompts'
            ]);

            assert.notStrictEqual(result.exitCode, 0, 'Should exit with non-zero status');
            assert.ok(
                result.stderr.includes('Cannot specify both --hf-token and --hf-token-arn'),
                `Expected mutual exclusion error in stderr, got: ${result.stderr}`
            );
        });

        it('allows --hf-token alone without error', async () => {
            const result = await runCli([
                '--hf-token', 'hf_test123',
                '--skip-prompts',
                '--deployment-config', 'http-flask'
            ]);

            assert.ok(
                !result.stderr.includes('Cannot specify both --hf-token and --hf-token-arn'),
                'Should not produce mutual exclusion error'
            );
        });

        it('allows --hf-token-arn alone without error', async () => {
            const result = await runCli([
                '--hf-token-arn', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf',
                '--skip-prompts',
                '--deployment-config', 'http-flask'
            ]);

            assert.ok(
                !result.stderr.includes('Cannot specify both --hf-token and --hf-token-arn'),
                'Should not produce mutual exclusion error'
            );
        });
    });

    describe('--ngc-token and --ngc-token-arn', () => {
        it('rejects when both --ngc-token and --ngc-token-arn are provided', async () => {
            const result = await runCli([
                '--ngc-token', 'nvapi-test123',
                '--ngc-token-arn', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/ci-AbCdEf',
                '--skip-prompts'
            ]);

            assert.notStrictEqual(result.exitCode, 0, 'Should exit with non-zero status');
            assert.ok(
                result.stderr.includes('Cannot specify both --ngc-token and --ngc-token-arn'),
                `Expected mutual exclusion error in stderr, got: ${result.stderr}`
            );
        });

        it('allows --ngc-token alone without error', async () => {
            const result = await runCli([
                '--ngc-token', 'nvapi-test123',
                '--skip-prompts',
                '--deployment-config', 'http-flask'
            ]);

            assert.ok(
                !result.stderr.includes('Cannot specify both --ngc-token and --ngc-token-arn'),
                'Should not produce mutual exclusion error'
            );
        });

        it('allows --ngc-token-arn alone without error', async () => {
            const result = await runCli([
                '--ngc-token-arn', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/ci-AbCdEf',
                '--skip-prompts',
                '--deployment-config', 'http-flask'
            ]);

            assert.ok(
                !result.stderr.includes('Cannot specify both --ngc-token and --ngc-token-arn'),
                'Should not produce mutual exclusion error'
            );
        });
    });

    describe('error message format', () => {
        it('displays error with ❌ prefix for hf-token conflict', async () => {
            const result = await runCli([
                '--hf-token', 'hf_test',
                '--hf-token-arn', 'arn:aws:secretsmanager:us-east-1:123:secret:mlcc/hf-token/x-Ab',
                '--skip-prompts'
            ]);

            assert.ok(
                result.stderr.includes('❌'),
                'Error message should start with ❌ emoji'
            );
        });

        it('displays error with ❌ prefix for ngc-token conflict', async () => {
            const result = await runCli([
                '--ngc-token', 'nvapi-test',
                '--ngc-token-arn', 'arn:aws:secretsmanager:us-east-1:123:secret:mlcc/ngc-token/x-Ab',
                '--skip-prompts'
            ]);

            assert.ok(
                result.stderr.includes('❌'),
                'Error message should start with ❌ emoji'
            );
        });
    });
});

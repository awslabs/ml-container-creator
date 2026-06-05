// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for Python helper (.tune_helper.py) subcommand dispatch.
 *
 * Tests:
 * - Each subcommand (submit, status, resolve, stage-hf, validate) is correctly routed
 * - JSON output format for each subcommand
 * - Error handling for missing SDK
 * - Unknown commands produce errors
 * - Missing required args produce errors
 *
 * Validates: Requirements 5.1, 5.2
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_PATH = path.resolve(__dirname, '../../templates/do/.tune_helper.py');

/**
 * Run the Python helper with given args and return the result.
 */
function runHelper(args, options = {}) {
    const result = spawnSync('python3', [HELPER_PATH, ...args], {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, ...options.env },
        input: options.input || undefined
    });
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status
    };
}

/**
 * Parse JSON from stdout, returning null if parsing fails.
 */
function parseOutput(stdout) {
    try {
        return JSON.parse(stdout.trim());
    } catch {
        return null;
    }
}

// ── Subcommand Recognition ───────────────────────────────────────────────────

describe('tune_helper.py subcommand dispatch', () => {
    before(function () {
        // Skip all tests if python3 is not available
        const result = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
        if (result.status !== 0) {
            this.skip();
        }
        // Verify the helper script exists
        if (!fs.existsSync(HELPER_PATH)) {
            this.skip();
        }
    });

    describe('subcommand recognition', () => {
        it('recognizes the submit subcommand', () => {
            // submit requires args, so missing args should produce an error exit
            // but the subcommand itself should be recognized (not "unknown command")
            const result = runHelper(['submit']);
            // argparse exits with code 2 for missing required args
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--model-id'),
                'should mention required --model-id arg');
        });

        it('recognizes the status subcommand', () => {
            const result = runHelper(['status']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--job-name'),
                'should mention required --job-name arg');
        });

        it('recognizes the resolve subcommand', () => {
            const result = runHelper(['resolve']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--job-name'),
                'should mention required --job-name arg');
        });

        it('recognizes the stage-hf subcommand', () => {
            const result = runHelper(['stage-hf']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--hf-org'),
                'should mention required --hf-org arg');
        });

        it('recognizes the validate subcommand', () => {
            const result = runHelper(['validate']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--schema'),
                'should mention required --schema arg');
        });

        it('recognizes the discover subcommand', () => {
            // discover has no required args (all optional), so it should dispatch
            // and fail due to missing family/filter (not argparse error)
            const result = runHelper(['discover'], {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    AWS_ACCESS_KEY_ID: '',
                    AWS_SECRET_ACCESS_KEY: ''
                }
            });
            // Should not exit with code 2 (argparse error) — subcommand is recognized
            assert.notStrictEqual(result.exitCode, 2,
                'should not be an argparse error — discover subcommand is recognized');
        });
    });

    // ── Unknown Commands ─────────────────────────────────────────────────────

    describe('unknown commands', () => {
        it('exits with error when no subcommand is given', () => {
            const result = runHelper([]);
            assert.notStrictEqual(result.exitCode, 0);
        });

        it('exits with error for unknown subcommand', () => {
            const result = runHelper(['unknown-cmd']);
            assert.notStrictEqual(result.exitCode, 0);
        });

        it('exits with error for misspelled subcommand', () => {
            const result = runHelper(['submitt']);
            assert.notStrictEqual(result.exitCode, 0);
        });
    });

    // ── Missing Required Args ────────────────────────────────────────────────

    describe('missing required arguments', () => {
        it('submit requires --model-id, --technique, --training-type, --dataset-s3-uri, --output-bucket, --role-arn, --job-name, --project-name', () => {
            const result = runHelper(['submit', '--model-id', 'test-model']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--technique'),
                'should mention missing --technique');
        });

        it('status requires --job-name and --region', () => {
            const result = runHelper(['status', '--job-name', 'test-job']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--region'),
                'should mention missing --region');
        });

        it('resolve requires --job-name, --region, and --training-type', () => {
            const result = runHelper(['resolve', '--job-name', 'test-job', '--region', 'us-east-1']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--training-type'),
                'should mention missing --training-type');
        });

        it('stage-hf requires --hf-org, --hf-name, --output-bucket, --project-name, --region', () => {
            const result = runHelper(['stage-hf', '--hf-org', 'test-org']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--hf-name'),
                'should mention missing --hf-name');
        });

        it('validate requires --schema', () => {
            const result = runHelper(['validate']);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('--schema'),
                'should mention missing --schema');
        });
    });

    // ── Discover Subcommand ──────────────────────────────────────────────────

    describe('discover subcommand', () => {
        it('exits with error when no family or filter is provided', () => {
            const result = runHelper(['discover'], {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    AWS_ACCESS_KEY_ID: '',
                    AWS_SECRET_ACCESS_KEY: '',
                    AWS_REGION: ''
                }
            });
            assert.strictEqual(result.exitCode, 1);
            const output = parseOutput(result.stdout);
            assert.notStrictEqual(output, null, 'should produce valid JSON output');
            assert.ok(output.error.includes('No family or filter provided'),
                'should report that no family or filter was provided');
        });

        it('accepts --family argument without argparse error', () => {
            const result = runHelper(['discover', '--family', 'qwen-3'], {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    AWS_ACCESS_KEY_ID: '',
                    AWS_SECRET_ACCESS_KEY: '',
                    AWS_REGION: 'us-east-1'
                }
            });
            // Should not exit with code 2 (argparse error)
            assert.notStrictEqual(result.exitCode, 2,
                'should not be an argparse error — --family is accepted');
            // Will exit 1 because boto3 will fail without credentials
            // but the subcommand was dispatched correctly
        });

        it('accepts --filter argument without argparse error', () => {
            const result = runHelper(['discover', '--filter', 'huggingface-llm'], {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    AWS_ACCESS_KEY_ID: '',
                    AWS_SECRET_ACCESS_KEY: '',
                    AWS_REGION: 'us-east-1'
                }
            });
            assert.notStrictEqual(result.exitCode, 2,
                'should not be an argparse error — --filter is accepted');
        });

        it('accepts --region argument without argparse error', () => {
            const result = runHelper(['discover', '--family', 'llama-3', '--region', 'us-west-2'], {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    AWS_ACCESS_KEY_ID: '',
                    AWS_SECRET_ACCESS_KEY: ''
                }
            });
            assert.notStrictEqual(result.exitCode, 2,
                'should not be an argparse error — --region is accepted');
        });

        it('produces JSON error output on Hub discovery failure', function () {
            this.timeout(15000);
            const result = runHelper(['discover', '--family', 'qwen-3'], {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    AWS_ACCESS_KEY_ID: 'fake',
                    AWS_SECRET_ACCESS_KEY: 'fake',
                    AWS_REGION: 'us-east-1'
                }
            });
            assert.strictEqual(result.exitCode, 1);
            const output = parseOutput(result.stdout);
            assert.notStrictEqual(output, null, 'should produce valid JSON output');
            assert.ok('error' in output, 'should have error field');
            assert.ok(output.error.includes('Hub discovery failed'),
                'should report Hub discovery failure');
        });
    });

    // ── Validate Subcommand (end-to-end, no SDK needed) ──────────────────────

    describe('validate subcommand — end-to-end', () => {
        const sftSchema = JSON.stringify({
            required: ['prompt', 'completion'],
            types: { prompt: 'string', completion: 'string' }
        });

        const dpoSchema = JSON.stringify({
            required: ['prompt', 'chosen', 'rejected'],
            types: { prompt: 'string', chosen: 'string', rejected: 'string' }
        });

        it('validates a correct SFT dataset from stdin', () => {
            const input = [
                '{"prompt": "What is AI?", "completion": "Artificial intelligence."}',
                '{"prompt": "Hello", "completion": "Hi there!"}'
            ].join('\n');

            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.notStrictEqual(output, null, 'should produce valid JSON output');
            assert.strictEqual(output.valid, true);
            assert.strictEqual(output.error, null);
            assert.strictEqual(output.line_number, null);
            assert.strictEqual(output.malformed_line, null);
        });

        it('validates a correct DPO dataset from stdin', () => {
            const input = '{"prompt": "Explain X", "chosen": "Good", "rejected": "Bad"}\n';
            const result = runHelper(
                ['validate', '--schema', dpoSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, true);
        });

        it('reports missing required key', () => {
            const input = '{"prompt": "What is AI?"}\n';
            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, false);
            assert.ok(output.error.includes('missing required key "completion"'));
            assert.strictEqual(output.line_number, 1);
            assert.ok(output.malformed_line.includes('"prompt"'));
        });

        it('reports wrong type for a field', () => {
            const input = '{"prompt": 123, "completion": "A"}\n';
            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, false);
            assert.ok(output.error.includes('wrong type'));
            assert.ok(output.error.includes('"string"'));
            assert.ok(output.error.includes('"number"'));
        });

        it('reports invalid JSON on a line', () => {
            const input = 'not valid json\n';
            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, false);
            assert.ok(output.error.includes('not valid JSON'));
            assert.strictEqual(output.line_number, 1);
            assert.strictEqual(output.malformed_line, 'not valid json');
        });

        it('reports non-object JSON (array)', () => {
            const input = '[1, 2, 3]\n';
            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, false);
            assert.ok(output.error.includes('must be a JSON object'));
        });

        it('reports error on correct line number', () => {
            const input = [
                '{"prompt": "Q1", "completion": "A1"}',
                '{"prompt": "Q2", "completion": "A2"}',
                '{"prompt": "Q3"}'
            ].join('\n');

            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, false);
            assert.strictEqual(output.line_number, 3);
            assert.ok(output.error.includes('Line 3'));
        });

        it('only inspects first 10 lines', () => {
            const validLines = Array.from({ length: 10 }, (_, i) =>
                `{"prompt": "Q${i}", "completion": "A${i}"}`
            );
            // Line 11 is invalid but should not be inspected
            const input = [...validLines, '{"prompt": "missing"}'].join('\n');

            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, true);
        });

        it('validates from a file using --file flag', () => {
            const tmpFile = path.join(os.tmpdir(), 'tune-test-dataset.jsonl');
            fs.writeFileSync(tmpFile, [
                '{"prompt": "Q1", "completion": "A1"}',
                '{"prompt": "Q2", "completion": "A2"}'
            ].join('\n'));

            try {
                const result = runHelper([
                    'validate', '--schema', sftSchema, '--file', tmpFile
                ]);
                assert.strictEqual(result.exitCode, 0);
                const output = parseOutput(result.stdout);
                assert.strictEqual(output.valid, true);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        it('reports error for non-existent file', () => {
            const result = runHelper([
                'validate', '--schema', sftSchema, '--file', '/tmp/nonexistent-dataset-xyz.jsonl'
            ]);
            assert.strictEqual(result.exitCode, 1);
            const output = parseOutput(result.stdout);
            assert.ok(output.error.includes('not found'));
        });

        it('reports error for invalid schema JSON', () => {
            const result = runHelper(
                ['validate', '--schema', 'not-json'],
                { input: '{"prompt": "Q", "completion": "A"}\n' }
            );
            assert.strictEqual(result.exitCode, 1);
            const output = parseOutput(result.stdout);
            assert.ok(output.error.includes('Invalid schema JSON'));
        });

        it('includes expected_format in error output', () => {
            const input = '{"prompt": "Q"}\n';
            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, false);
            assert.ok(output.expected_format !== undefined,
                'should include expected_format field');
            assert.ok(output.expected_format.includes('prompt'));
            assert.ok(output.expected_format.includes('completion'));
        });

        it('skips empty lines during validation', () => {
            const input = [
                '{"prompt": "Q1", "completion": "A1"}',
                '',
                '{"prompt": "Q2", "completion": "A2"}'
            ].join('\n');

            const result = runHelper(
                ['validate', '--schema', sftSchema],
                { input }
            );
            assert.strictEqual(result.exitCode, 0);
            const output = parseOutput(result.stdout);
            assert.strictEqual(output.valid, true);
        });
    });

    // ── JSON Output Format ───────────────────────────────────────────────────

    describe('JSON output format', () => {
        it('validate success output has correct structure', () => {
            const schema = JSON.stringify({
                required: ['prompt', 'completion'],
                types: { prompt: 'string', completion: 'string' }
            });
            const input = '{"prompt": "Q", "completion": "A"}\n';

            const result = runHelper(
                ['validate', '--schema', schema],
                { input }
            );
            const output = parseOutput(result.stdout);
            assert.notStrictEqual(output, null);
            assert.ok('valid' in output, 'should have valid field');
            assert.ok('error' in output, 'should have error field');
            assert.ok('line_number' in output, 'should have line_number field');
            assert.ok('malformed_line' in output, 'should have malformed_line field');
        });

        it('validate error output has correct structure', () => {
            const schema = JSON.stringify({
                required: ['prompt', 'completion'],
                types: { prompt: 'string', completion: 'string' }
            });
            const input = '{"prompt": "Q"}\n';

            const result = runHelper(
                ['validate', '--schema', schema],
                { input }
            );
            const output = parseOutput(result.stdout);
            assert.notStrictEqual(output, null);
            assert.strictEqual(output.valid, false);
            assert.strictEqual(typeof output.error, 'string');
            assert.strictEqual(typeof output.line_number, 'number');
            assert.strictEqual(typeof output.malformed_line, 'string');
            assert.ok('expected_format' in output, 'should have expected_format field');
        });

        it('error exit produces JSON with error field', () => {
            const result = runHelper([
                'validate', '--schema', '{invalid', '--file', '-'
            ], { input: '' });
            assert.strictEqual(result.exitCode, 1);
            const output = parseOutput(result.stdout);
            assert.notStrictEqual(output, null, 'error output should be valid JSON');
            assert.ok('error' in output, 'should have error field');
            assert.strictEqual(typeof output.error, 'string');
        });
    });

    // ── SDK Dependency Check ─────────────────────────────────────────────────

    describe('SDK dependency handling', () => {
        it('submit dispatches to cmd_submit and exits non-zero without valid SDK modules', function () {
            this.timeout(15000);
            // The submit subcommand is correctly routed (argparse accepts it)
            // but fails because the required SDK trainer modules are not available.
            // This verifies the dispatch works and the command exits with error.
            const result = runHelper([
                'submit',
                '--model-id', 'test-model',
                '--technique', 'sft',
                '--training-type', 'lora',
                '--dataset-s3-uri', 's3://bucket/data.jsonl',
                '--output-bucket', 'my-bucket',
                '--role-arn', 'arn:aws:iam::123456789012:role/test',
                '--job-name', 'test-job',
                '--project-name', 'test-project'
            ]);
            // Should exit non-zero (either SDK missing or module import error)
            assert.notStrictEqual(result.exitCode, 0,
                'should exit with error when SDK modules are unavailable');
            // Should NOT exit with 2 (argparse error) — the subcommand was recognized
            assert.notStrictEqual(result.exitCode, 2,
                'should not be an argparse error — subcommand was dispatched');
        });

        it('status dispatches to cmd_status and exits non-zero without AWS credentials', function () {
            this.timeout(15000);
            const result = runHelper([
                'status',
                '--job-name', 'test-job-name',
                '--region', 'us-east-1'
            ], {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    AWS_ACCESS_KEY_ID: '',
                    AWS_SECRET_ACCESS_KEY: '',
                    AWS_DEFAULT_REGION: 'us-east-1'
                }
            });
            // Should exit non-zero (boto3 will fail without credentials)
            assert.notStrictEqual(result.exitCode, 0,
                'should exit with error without valid AWS credentials');
            assert.notStrictEqual(result.exitCode, 2,
                'should not be an argparse error — subcommand was dispatched');
        });
    });

    // ── Submit Argument Validation ───────────────────────────────────────────

    describe('submit argument validation', () => {
        it('rejects invalid technique choice', () => {
            const result = runHelper([
                'submit',
                '--model-id', 'test-model',
                '--technique', 'invalid-technique',
                '--training-type', 'lora',
                '--dataset-s3-uri', 's3://bucket/data.jsonl',
                '--output-bucket', 'my-bucket',
                '--role-arn', 'arn:aws:iam::123456789012:role/test',
                '--job-name', 'test-job',
                '--project-name', 'test-project'
            ]);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('invalid choice'),
                'should report invalid choice for technique');
        });

        it('rejects invalid training-type choice', () => {
            const result = runHelper([
                'submit',
                '--model-id', 'test-model',
                '--technique', 'sft',
                '--training-type', 'invalid-type',
                '--dataset-s3-uri', 's3://bucket/data.jsonl',
                '--output-bucket', 'my-bucket',
                '--role-arn', 'arn:aws:iam::123456789012:role/test',
                '--job-name', 'test-job',
                '--project-name', 'test-project'
            ]);
            assert.strictEqual(result.exitCode, 2);
            assert.ok(result.stderr.includes('invalid choice'),
                'should report invalid choice for training-type');
        });

        it('accepts valid technique choices: sft, dpo, rlaif, rlvr', function () {
            this.timeout(60000);
            for (const technique of ['sft', 'dpo', 'rlaif', 'rlvr']) {
                const result = runHelper([
                    'submit',
                    '--model-id', 'test-model',
                    '--technique', technique,
                    '--training-type', 'lora',
                    '--dataset-s3-uri', 's3://bucket/data.jsonl',
                    '--output-bucket', 'my-bucket',
                    '--role-arn', 'arn:aws:iam::123456789012:role/test',
                    '--job-name', 'test-job',
                    '--project-name', 'test-project'
                ], {
                    env: {
                        PYTHONPATH: '/nonexistent',
                        PATH: process.env.PATH,
                        HOME: process.env.HOME
                    }
                });
                // Should not exit with code 2 (argparse error)
                // It may exit with 1 (SDK not found) which is fine
                assert.notStrictEqual(result.exitCode, 2,
                    `technique "${technique}" should be accepted by argparse`);
            }
        });

        it('accepts valid training-type choices: lora, full-rank', function () {
            this.timeout(30000);
            for (const trainingType of ['lora', 'full-rank']) {
                const result = runHelper([
                    'submit',
                    '--model-id', 'test-model',
                    '--technique', 'sft',
                    '--training-type', trainingType,
                    '--dataset-s3-uri', 's3://bucket/data.jsonl',
                    '--output-bucket', 'my-bucket',
                    '--role-arn', 'arn:aws:iam::123456789012:role/test',
                    '--job-name', 'test-job',
                    '--project-name', 'test-project'
                ], {
                    env: {
                        PYTHONPATH: '/nonexistent',
                        PATH: process.env.PATH,
                        HOME: process.env.HOME
                    }
                });
                assert.notStrictEqual(result.exitCode, 2,
                    `training-type "${trainingType}" should be accepted by argparse`);
            }
        });
    });
});

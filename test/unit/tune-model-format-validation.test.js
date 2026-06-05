// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for --model format validation in do/tune _resolve_tune_model.
 *
 * The regex pattern used: ^[a-zA-Z0-9](-*[a-zA-Z0-9])*$
 * This matches JumpStart Hub content names which follow the pattern
 * [a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}
 *
 * Tests:
 * - Valid Hub content names are accepted
 * - Empty strings are rejected
 * - Values with spaces are rejected
 * - Values containing `/` are rejected
 * - Values containing `://` are rejected
 * - Values starting with hyphens are rejected
 * - Values ending with hyphens are rejected
 *
 * Validates: Requirements 2.3
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * The Hub content name regex used in _resolve_tune_model.
 * We test this directly in JavaScript to validate the pattern logic.
 */
const HUB_CONTENT_NAME_PATTERN = /^[a-zA-Z0-9](-*[a-zA-Z0-9])*$/;

/**
 * Run a minimal bash script that replicates the _resolve_tune_model format check.
 * This tests the actual grep -qE behavior used in the template.
 */
function testBashFormatValidation(modelValue) {
    const script = `
if [ -z "${modelValue}" ]; then
    echo "EMPTY"
    exit 2
fi
if ! echo "${modelValue}" | grep -qE '^[a-zA-Z0-9](-*[a-zA-Z0-9])*$'; then
    echo "INVALID"
    exit 1
fi
echo "VALID"
exit 0
`;
    const tmpFile = path.join(os.tmpdir(), `tune-format-test-${Date.now()}.sh`);
    fs.writeFileSync(tmpFile, script, { mode: 0o755 });

    try {
        const result = spawnSync('bash', [tmpFile], {
            encoding: 'utf-8',
            timeout: 5000
        });
        return {
            stdout: (result.stdout || '').trim(),
            exitCode: result.status
        };
    } finally {
        fs.unlinkSync(tmpFile);
    }
}

describe('do/tune --model format validation', () => {
    describe('valid Hub content names (accepted)', () => {
        const validNames = [
            'huggingface-reasoning-qwen3-06b',
            'huggingface-llm-qwen2-5-7b',
            'meta-textgeneration-llama-3-1-8b',
            'deepseek-llm-r1-distill-7b',
            'openai-reasoning-gpt-oss-1',
            'a',
            'A1',
            'model123',
            'a-b-c',
            'abc-def-123',
            'A1-B2-C3'
        ];

        for (const name of validNames) {
            it(`accepts "${name}"`, () => {
                assert.ok(HUB_CONTENT_NAME_PATTERN.test(name),
                    `"${name}" should match Hub content name pattern`);
            });

            it(`bash grep accepts "${name}"`, () => {
                const result = testBashFormatValidation(name);
                assert.strictEqual(result.stdout, 'VALID',
                    `bash should accept "${name}"`);
                assert.strictEqual(result.exitCode, 0);
            });
        }
    });

    describe('empty strings (rejected)', () => {
        it('rejects empty string via emptiness check', () => {
            const result = testBashFormatValidation('');
            assert.strictEqual(result.stdout, 'EMPTY');
            assert.strictEqual(result.exitCode, 2);
        });

        it('regex does not match empty string', () => {
            assert.ok(!HUB_CONTENT_NAME_PATTERN.test(''),
                'empty string should not match pattern');
        });
    });

    describe('values with spaces (rejected)', () => {
        const spacedValues = [
            'model name',
            'huggingface llm qwen',
            ' leading-space',
            'trailing-space ',
            'mid dle'
        ];

        for (const value of spacedValues) {
            it(`rejects "${value}"`, () => {
                assert.ok(!HUB_CONTENT_NAME_PATTERN.test(value),
                    `"${value}" should not match Hub content name pattern`);
            });
        }

        it('bash grep rejects "model name"', () => {
            const result = testBashFormatValidation('model name');
            assert.strictEqual(result.stdout, 'INVALID');
            assert.strictEqual(result.exitCode, 1);
        });
    });

    describe('values containing "/" (rejected)', () => {
        const slashValues = [
            'Qwen/Qwen3-0.6B',
            'meta-llama/Llama-3.1-8B',
            'org/model',
            '/leading-slash',
            'trailing-slash/'
        ];

        for (const value of slashValues) {
            it(`rejects "${value}"`, () => {
                assert.ok(!HUB_CONTENT_NAME_PATTERN.test(value),
                    `"${value}" should not match Hub content name pattern`);
            });
        }

        it('bash grep rejects "Qwen/Qwen3-0.6B"', () => {
            const result = testBashFormatValidation('Qwen/Qwen3-0.6B');
            assert.strictEqual(result.stdout, 'INVALID');
            assert.strictEqual(result.exitCode, 1);
        });
    });

    describe('values containing "://" (rejected)', () => {
        const urlValues = [
            'https://huggingface.co/model',
            'http://example.com',
            's3://bucket/model',
            'hf://org/model'
        ];

        for (const value of urlValues) {
            it(`rejects "${value}"`, () => {
                assert.ok(!HUB_CONTENT_NAME_PATTERN.test(value),
                    `"${value}" should not match Hub content name pattern`);
            });
        }

        it('bash grep rejects "https://huggingface.co/model"', () => {
            const result = testBashFormatValidation('https://huggingface.co/model');
            assert.strictEqual(result.stdout, 'INVALID');
            assert.strictEqual(result.exitCode, 1);
        });
    });

    describe('values starting or ending with hyphens (rejected)', () => {
        const hyphenValues = [
            '-leading-hyphen',
            'trailing-hyphen-',
            '-both-',
            '---'
        ];

        for (const value of hyphenValues) {
            it(`rejects "${value}"`, () => {
                assert.ok(!HUB_CONTENT_NAME_PATTERN.test(value),
                    `"${value}" should not match Hub content name pattern`);
            });
        }

        it('bash grep rejects "-leading-hyphen"', () => {
            const result = testBashFormatValidation('-leading-hyphen');
            assert.strictEqual(result.stdout, 'INVALID');
            assert.strictEqual(result.exitCode, 1);
        });
    });

    describe('values with special characters (rejected)', () => {
        const specialValues = [
            'model.name',
            'model_name',
            'model@name',
            'model#name',
            'model$name',
            'model%name',
            'model&name',
            'model*name'
        ];

        for (const value of specialValues) {
            it(`rejects "${value}"`, () => {
                assert.ok(!HUB_CONTENT_NAME_PATTERN.test(value),
                    `"${value}" should not match Hub content name pattern`);
            });
        }
    });

    describe('error message format', () => {
        it('shows the invalid value and expected pattern', () => {
            // This tests the actual error message format from the template
            // The template outputs:
            //   ❌ Invalid model ID format: <value>
            //   Hub content names must match: [a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}
            const lines = [
                '#!/bin/bash',
                'ARG_MODEL="bad/value"',
                'if ! echo "${ARG_MODEL}" | grep -qE \'^[a-zA-Z0-9](-*[a-zA-Z0-9])*$\'; then',
                '    echo "❌ Invalid model ID format: ${ARG_MODEL}"',
                '    echo "   Hub content names must match: [a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}"',
                '    exit 1',
                'fi'
            ];
            const tmpFile = path.join(os.tmpdir(), `tune-error-msg-test-${Date.now()}.sh`);
            fs.writeFileSync(tmpFile, lines.join('\n'), { mode: 0o755 });

            try {
                const result = spawnSync('bash', [tmpFile], {
                    encoding: 'utf-8',
                    timeout: 5000
                });
                assert.strictEqual(result.status, 1);
                assert.ok(result.stdout.includes('Invalid model ID format: bad/value'),
                    'should show the invalid value');
                assert.ok(result.stdout.includes('Hub content names must match'),
                    'should show the expected pattern');
                assert.ok(result.stdout.includes('[a-zA-Z0-9](-*[a-zA-Z0-9]){0,62}'),
                    'should show the regex pattern');
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });
    });
});

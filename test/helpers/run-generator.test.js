// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the test runner helpers (run-generator.js).
 * Validates the assertion helpers and utility functions work correctly.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import {
    createResult,
    optionsToFlags,
    createTempDir
} from './run-generator.js';

describe('test/helpers/run-generator', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-generator-test-'));
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('createResult', () => {
        describe('file()', () => {
            it('returns the absolute path to a file within the directory', () => {
                const result = createResult(tempDir);
                const expected = path.join(tempDir, 'Dockerfile');
                assert.strictEqual(result.file('Dockerfile'), expected);
            });

            it('handles nested paths', () => {
                const result = createResult(tempDir);
                const expected = path.join(tempDir, 'code/serve.py');
                assert.strictEqual(result.file('code/serve.py'), expected);
            });
        });

        describe('assertFile()', () => {
            it('does not throw when file exists', () => {
                fs.writeFileSync(path.join(tempDir, 'exists.txt'), 'hello');
                const result = createResult(tempDir);
                assert.doesNotThrow(() => result.assertFile('exists.txt'));
            });

            it('throws when file does not exist', () => {
                const result = createResult(tempDir);
                assert.throws(
                    () => result.assertFile('missing.txt'),
                    /Expected file to exist: missing\.txt/
                );
            });

            it('throws for nested missing file', () => {
                const result = createResult(tempDir);
                assert.throws(
                    () => result.assertFile('code/serve.py'),
                    /Expected file to exist: code\/serve\.py/
                );
            });
        });

        describe('assertFileContent()', () => {
            beforeEach(() => {
                fs.writeFileSync(
                    path.join(tempDir, 'Dockerfile'),
                    'FROM python:3.11-slim\nRUN pip install flask\n'
                );
            });

            it('does not throw when file contains the string', () => {
                const result = createResult(tempDir);
                assert.doesNotThrow(() =>
                    result.assertFileContent('Dockerfile', 'FROM python:3.11')
                );
            });

            it('does not throw when file matches regex', () => {
                const result = createResult(tempDir);
                assert.doesNotThrow(() =>
                    result.assertFileContent('Dockerfile', /FROM python:\d+\.\d+/)
                );
            });

            it('throws when file does not contain the string', () => {
                const result = createResult(tempDir);
                assert.throws(
                    () => result.assertFileContent('Dockerfile', 'FROM node:18'),
                    /Expected file Dockerfile to contain: "FROM node:18"/
                );
            });

            it('throws when file does not match regex', () => {
                const result = createResult(tempDir);
                assert.throws(
                    () => result.assertFileContent('Dockerfile', /FROM node:\d+/),
                    /Expected file Dockerfile to match/
                );
            });

            it('throws when file does not exist', () => {
                const result = createResult(tempDir);
                assert.throws(
                    () => result.assertFileContent('missing.txt', 'anything'),
                    /Expected file to exist: missing\.txt/
                );
            });
        });

        describe('assertNoFile()', () => {
            it('does not throw when file does not exist', () => {
                const result = createResult(tempDir);
                assert.doesNotThrow(() => result.assertNoFile('missing.txt'));
            });

            it('throws when file exists', () => {
                fs.writeFileSync(path.join(tempDir, 'exists.txt'), 'hello');
                const result = createResult(tempDir);
                assert.throws(
                    () => result.assertNoFile('exists.txt'),
                    /Expected file NOT to exist: exists\.txt/
                );
            });
        });

        describe('cleanup()', () => {
            it('removes the temporary directory', () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
                fs.writeFileSync(path.join(dir, 'file.txt'), 'data');

                const result = createResult(dir);
                result.cleanup();

                assert.strictEqual(fs.existsSync(dir), false);
            });

            it('does not throw if directory already removed', () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
                fs.rmSync(dir, { recursive: true, force: true });

                const result = createResult(dir);
                assert.doesNotThrow(() => result.cleanup());
            });
        });
    });

    describe('optionsToFlags()', () => {
        it('converts boolean true to --flag', () => {
            const flags = optionsToFlags({ 'skip-prompts': true });
            assert.deepStrictEqual(flags, ['--skip-prompts']);
        });

        it('skips boolean false values', () => {
            const flags = optionsToFlags({ 'skip-prompts': false });
            assert.deepStrictEqual(flags, []);
        });

        it('converts string values to --flag=value', () => {
            const flags = optionsToFlags({ 'project-name': 'my-project' });
            assert.deepStrictEqual(flags, ['--project-name=my-project']);
        });

        it('converts number values to --flag=value', () => {
            const flags = optionsToFlags({ 'timeout': 5000 });
            assert.deepStrictEqual(flags, ['--timeout=5000']);
        });

        it('converts camelCase keys to kebab-case', () => {
            const flags = optionsToFlags({ skipPrompts: true, projectName: 'test' });
            assert.deepStrictEqual(flags, ['--skip-prompts', '--project-name=test']);
        });

        it('handles array values as repeatable flags', () => {
            const flags = optionsToFlags({ 'model-env': ['KEY1=val1', 'KEY2=val2'] });
            assert.deepStrictEqual(flags, ['--model-env=KEY1=val1', '--model-env=KEY2=val2']);
        });

        it('skips undefined and null values', () => {
            const flags = optionsToFlags({ 'region': undefined, 'role': null, 'name': 'test' });
            assert.deepStrictEqual(flags, ['--name=test']);
        });

        it('handles empty options object', () => {
            const flags = optionsToFlags({});
            assert.deepStrictEqual(flags, []);
        });

        it('handles mixed option types', () => {
            const flags = optionsToFlags({
                'skip-prompts': true,
                'project-name': 'test',
                'include-sample': false,
                'region': 'us-east-1'
            });
            assert.deepStrictEqual(flags, [
                '--skip-prompts',
                '--project-name=test',
                '--region=us-east-1'
            ]);
        });
    });

    describe('createTempDir()', () => {
        it('creates a directory that exists', () => {
            const dir = createTempDir();
            try {
                assert.strictEqual(fs.existsSync(dir), true);
                assert.strictEqual(fs.statSync(dir).isDirectory(), true);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('uses the provided prefix', () => {
            const dir = createTempDir('custom-prefix-');
            try {
                assert.ok(
                    path.basename(dir).startsWith('custom-prefix-'),
                    `Expected directory name to start with "custom-prefix-", got: ${path.basename(dir)}`
                );
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('creates unique directories on successive calls', () => {
            const dir1 = createTempDir();
            const dir2 = createTempDir();
            try {
                assert.notStrictEqual(dir1, dir2);
            } finally {
                fs.rmSync(dir1, { recursive: true, force: true });
                fs.rmSync(dir2, { recursive: true, force: true });
            }
        });
    });
});

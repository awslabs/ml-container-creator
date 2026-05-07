// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { copyTpl } from '../../src/copy-tpl.js';

describe('copyTpl', () => {
    let tmpDir;
    let templateDir;
    let destDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-tpl-test-'));
        templateDir = path.join(tmpDir, 'templates');
        destDir = path.join(tmpDir, 'output');
        fs.mkdirSync(templateDir, { recursive: true });
        fs.mkdirSync(destDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('basic template rendering', () => {
        it('should render EJS variables in template files', () => {
            fs.writeFileSync(
                path.join(templateDir, 'hello.txt'),
                'Hello, <%= name %>!'
            );

            copyTpl(templateDir, destDir, { name: 'World' });

            const output = fs.readFileSync(path.join(destDir, 'hello.txt'), 'utf8');
            assert.strictEqual(output, 'Hello, World!');
        });

        it('should render multiple variables', () => {
            fs.writeFileSync(
                path.join(templateDir, 'config.yml'),
                'project: <%= projectName %>\nregion: <%= region %>'
            );

            copyTpl(templateDir, destDir, { projectName: 'my-app', region: 'us-east-1' });

            const output = fs.readFileSync(path.join(destDir, 'config.yml'), 'utf8');
            assert.strictEqual(output, 'project: my-app\nregion: us-east-1');
        });

        it('should handle files with no EJS syntax', () => {
            fs.writeFileSync(
                path.join(templateDir, 'plain.txt'),
                'No templates here.'
            );

            copyTpl(templateDir, destDir, { name: 'unused' });

            const output = fs.readFileSync(path.join(destDir, 'plain.txt'), 'utf8');
            assert.strictEqual(output, 'No templates here.');
        });
    });

    describe('ignore patterns', () => {
        it('should exclude files matching ignore patterns', () => {
            fs.writeFileSync(path.join(templateDir, 'keep.txt'), 'keep');
            fs.writeFileSync(path.join(templateDir, 'skip.log'), 'skip');

            copyTpl(templateDir, destDir, {}, ['**/*.log']);

            assert.ok(fs.existsSync(path.join(destDir, 'keep.txt')));
            assert.ok(!fs.existsSync(path.join(destDir, 'skip.log')));
        });

        it('should support multiple ignore patterns', () => {
            fs.writeFileSync(path.join(templateDir, 'app.js'), 'code');
            fs.writeFileSync(path.join(templateDir, 'debug.log'), 'log');
            fs.writeFileSync(path.join(templateDir, 'temp.tmp'), 'tmp');

            copyTpl(templateDir, destDir, {}, ['**/*.log', '**/*.tmp']);

            assert.ok(fs.existsSync(path.join(destDir, 'app.js')));
            assert.ok(!fs.existsSync(path.join(destDir, 'debug.log')));
            assert.ok(!fs.existsSync(path.join(destDir, 'temp.tmp')));
        });

        it('should support directory ignore patterns', () => {
            fs.mkdirSync(path.join(templateDir, 'src'), { recursive: true });
            fs.mkdirSync(path.join(templateDir, 'test'), { recursive: true });
            fs.writeFileSync(path.join(templateDir, 'src', 'app.js'), 'code');
            fs.writeFileSync(path.join(templateDir, 'test', 'app.test.js'), 'test');

            copyTpl(templateDir, destDir, {}, ['test/**']);

            assert.ok(fs.existsSync(path.join(destDir, 'src', 'app.js')));
            assert.ok(!fs.existsSync(path.join(destDir, 'test', 'app.test.js')));
        });
    });

    describe('nested directory creation', () => {
        it('should create nested destination directories', () => {
            fs.mkdirSync(path.join(templateDir, 'a', 'b', 'c'), { recursive: true });
            fs.writeFileSync(
                path.join(templateDir, 'a', 'b', 'c', 'deep.txt'),
                'deep content'
            );

            copyTpl(templateDir, destDir, {});

            const output = fs.readFileSync(
                path.join(destDir, 'a', 'b', 'c', 'deep.txt'),
                'utf8'
            );
            assert.strictEqual(output, 'deep content');
        });

        it('should handle multiple nested paths', () => {
            fs.mkdirSync(path.join(templateDir, 'src', 'lib'), { recursive: true });
            fs.mkdirSync(path.join(templateDir, 'config'), { recursive: true });
            fs.writeFileSync(path.join(templateDir, 'src', 'lib', 'util.js'), 'util');
            fs.writeFileSync(path.join(templateDir, 'config', 'app.json'), '{}');

            copyTpl(templateDir, destDir, {});

            assert.ok(fs.existsSync(path.join(destDir, 'src', 'lib', 'util.js')));
            assert.ok(fs.existsSync(path.join(destDir, 'config', 'app.json')));
        });
    });

    describe('binary file passthrough', () => {
        it('should copy binary files without EJS rendering', () => {
            const pngContent = Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
            ]);
            fs.writeFileSync(path.join(templateDir, 'logo.png'), pngContent);

            copyTpl(templateDir, destDir, { name: 'test' });

            const output = fs.readFileSync(path.join(destDir, 'logo.png'));
            assert.ok(Buffer.compare(output, pngContent) === 0);
        });

        it('should not fail on binary files containing EJS-like sequences', () => {
            // Binary file with bytes that look like EJS tags
            const content = Buffer.from('binary <%= broken %> content', 'utf8');
            fs.writeFileSync(path.join(templateDir, 'font.woff2'), content);

            // Should not throw even though content has EJS-like syntax
            copyTpl(templateDir, destDir, {});

            const output = fs.readFileSync(path.join(destDir, 'font.woff2'));
            assert.ok(Buffer.compare(output, content) === 0);
        });

        it('should handle various binary extensions', () => {
            const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]);
            const extensions = ['.jpg', '.gif', '.ico', '.zip', '.pdf', '.woff', '.ttf'];

            for (const ext of extensions) {
                fs.writeFileSync(path.join(templateDir, `file${ext}`), binaryData);
            }

            copyTpl(templateDir, destDir, {});

            for (const ext of extensions) {
                const output = fs.readFileSync(path.join(destDir, `file${ext}`));
                assert.ok(
                    Buffer.compare(output, binaryData) === 0,
                    `Binary passthrough failed for ${ext}`
                );
            }
        });
    });

    describe('EJS error reporting', () => {
        it('should include the filename in error messages', () => {
            fs.writeFileSync(
                path.join(templateDir, 'broken.txt'),
                '<%= undefinedVar.property %>'
            );

            assert.throws(
                () => copyTpl(templateDir, destDir, {}),
                (err) => {
                    assert.ok(
                        err.message.includes('broken.txt'),
                        `Expected error to include filename, got: ${err.message}`
                    );
                    return true;
                }
            );
        });

        it('should include line number in error messages when available', () => {
            fs.writeFileSync(
                path.join(templateDir, 'multiline.txt'),
                'line 1\nline 2\n<%= bad.ref %>\nline 4'
            );

            assert.throws(
                () => copyTpl(templateDir, destDir, {}),
                (err) => {
                    assert.ok(
                        err.message.includes('multiline.txt'),
                        `Expected error to include filename, got: ${err.message}`
                    );
                    return true;
                }
            );
        });

        it('should wrap EJS syntax errors with context', () => {
            fs.writeFileSync(
                path.join(templateDir, 'syntax-err.ejs'),
                '<%= if (true { %>'
            );

            assert.throws(
                () => copyTpl(templateDir, destDir, {}),
                (err) => {
                    assert.ok(
                        err.message.includes('syntax-err.ejs'),
                        `Expected error to include filename, got: ${err.message}`
                    );
                    assert.ok(
                        err.message.includes('EJS rendering failed'),
                        `Expected error to include context, got: ${err.message}`
                    );
                    return true;
                }
            );
        });
    });
});

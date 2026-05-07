// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AwsProfileParser
 *
 * Tests INI parsing, profile extraction, deduplication, and graceful
 * handling of missing files.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import AwsProfileParser from '../../src/lib/aws-profile-parser.js';

describe('AwsProfileParser', () => {

    let tmpDir;
    let configPath;
    let credentialsPath;

    beforeEach(() => {
        tmpDir = join(os.tmpdir(), `aws-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
        configPath = join(tmpDir, 'config');
        credentialsPath = join(tmpDir, 'credentials');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('getProfiles()', () => {

        it('returns empty array when both files are missing', () => {
            const parser = new AwsProfileParser({
                configPath: join(tmpDir, 'nonexistent-config'),
                credentialsPath: join(tmpDir, 'nonexistent-credentials')
            });

            const profiles = parser.getProfiles();
            assert.deepStrictEqual(profiles, []);
        });

        it('parses [default] and [profile X] sections from config file', () => {
            writeFileSync(configPath, [
                '[default]',
                'region = us-east-1',
                '',
                '[profile dev]',
                'region = us-west-2',
                '',
                '[profile prod]',
                'region = eu-west-1'
            ].join('\n'));

            const parser = new AwsProfileParser({
                configPath,
                credentialsPath: join(tmpDir, 'nonexistent')
            });

            const profiles = parser.getProfiles();
            assert.deepStrictEqual(profiles, ['default', 'dev', 'prod']);
        });

        it('parses [X] sections from credentials file', () => {
            writeFileSync(credentialsPath, [
                '[default]',
                'aws_access_key_id = AKIA...',
                '',
                '[staging]',
                'aws_access_key_id = AKIA...'
            ].join('\n'));

            const parser = new AwsProfileParser({
                configPath: join(tmpDir, 'nonexistent'),
                credentialsPath
            });

            const profiles = parser.getProfiles();
            assert.deepStrictEqual(profiles, ['default', 'staging']);
        });

        it('merges and deduplicates profiles from both files', () => {
            writeFileSync(configPath, [
                '[default]',
                'region = us-east-1',
                '',
                '[profile dev]',
                'region = us-west-2'
            ].join('\n'));

            writeFileSync(credentialsPath, [
                '[default]',
                'aws_access_key_id = AKIA...',
                '',
                '[dev]',
                'aws_access_key_id = AKIA...',
                '',
                '[staging]',
                'aws_access_key_id = AKIA...'
            ].join('\n'));

            const parser = new AwsProfileParser({ configPath, credentialsPath });

            const profiles = parser.getProfiles();
            assert.deepStrictEqual(profiles, ['default', 'dev', 'staging']);
        });

        it('sorts default first when present', () => {
            writeFileSync(credentialsPath, [
                '[zebra]',
                'aws_access_key_id = AKIA...',
                '',
                '[alpha]',
                'aws_access_key_id = AKIA...',
                '',
                '[default]',
                'aws_access_key_id = AKIA...'
            ].join('\n'));

            const parser = new AwsProfileParser({
                configPath: join(tmpDir, 'nonexistent'),
                credentialsPath
            });

            const profiles = parser.getProfiles();
            assert.strictEqual(profiles[0], 'default');
            assert.deepStrictEqual(profiles, ['default', 'alpha', 'zebra']);
        });

        it('returns alphabetically sorted profiles when default is not present', () => {
            writeFileSync(credentialsPath, [
                '[zebra]',
                'aws_access_key_id = AKIA...',
                '',
                '[alpha]',
                'aws_access_key_id = AKIA...'
            ].join('\n'));

            const parser = new AwsProfileParser({
                configPath: join(tmpDir, 'nonexistent'),
                credentialsPath
            });

            const profiles = parser.getProfiles();
            assert.deepStrictEqual(profiles, ['alpha', 'zebra']);
        });
    });

    describe('_parseIniFile()', () => {

        it('returns empty Map for missing file', () => {
            const parser = new AwsProfileParser();
            const result = parser._parseIniFile(join(tmpDir, 'nonexistent'));
            assert.ok(result instanceof Map);
            assert.strictEqual(result.size, 0);
        });

        it('parses sections with key-value pairs', () => {
            writeFileSync(configPath, [
                '[default]',
                'region = us-east-1',
                'output = json',
                '',
                '[profile dev]',
                'region = us-west-2'
            ].join('\n'));

            const parser = new AwsProfileParser();
            const result = parser._parseIniFile(configPath);

            assert.strictEqual(result.size, 2);
            assert.deepStrictEqual(result.get('default'), { region: 'us-east-1', output: 'json' });
            assert.deepStrictEqual(result.get('profile dev'), { region: 'us-west-2' });
        });

        it('skips comments and empty lines', () => {
            writeFileSync(configPath, [
                '# This is a comment',
                '; This is also a comment',
                '',
                '[default]',
                '# inline comment line',
                'region = us-east-1'
            ].join('\n'));

            const parser = new AwsProfileParser();
            const result = parser._parseIniFile(configPath);

            assert.strictEqual(result.size, 1);
            assert.deepStrictEqual(result.get('default'), { region: 'us-east-1' });
        });

        it('handles values with equals signs', () => {
            writeFileSync(configPath, [
                '[default]',
                'some_key = value=with=equals'
            ].join('\n'));

            const parser = new AwsProfileParser();
            const result = parser._parseIniFile(configPath);

            assert.deepStrictEqual(result.get('default'), { some_key: 'value=with=equals' });
        });
    });

    describe('_extractProfileNames()', () => {

        it('extracts profile names from config-style sections', () => {
            const parsed = new Map([
                ['default', {}],
                ['profile dev', {}],
                ['profile prod', {}]
            ]);

            const parser = new AwsProfileParser();
            const names = parser._extractProfileNames(parsed, true);

            assert.deepStrictEqual(names, ['default', 'dev', 'prod']);
        });

        it('extracts profile names from credentials-style sections', () => {
            const parsed = new Map([
                ['default', {}],
                ['dev', {}],
                ['prod', {}]
            ]);

            const parser = new AwsProfileParser();
            const names = parser._extractProfileNames(parsed, false);

            assert.deepStrictEqual(names, ['default', 'dev', 'prod']);
        });

        it('ignores non-profile sections in config mode', () => {
            const parsed = new Map([
                ['default', {}],
                ['profile dev', {}],
                ['sso-session my-sso', {}],
                ['services my-services', {}]
            ]);

            const parser = new AwsProfileParser();
            const names = parser._extractProfileNames(parsed, true);

            assert.deepStrictEqual(names, ['default', 'dev']);
        });

        it('handles empty profile prefix gracefully', () => {
            const parsed = new Map([
                ['profile ', {}]
            ]);

            const parser = new AwsProfileParser();
            const names = parser._extractProfileNames(parsed, true);

            assert.deepStrictEqual(names, []);
        });
    });

    describe('_getConfigPath() and _getCredentialsPath()', () => {

        it('returns overridden paths when provided', () => {
            const parser = new AwsProfileParser({
                configPath: '/custom/config',
                credentialsPath: '/custom/credentials'
            });

            assert.strictEqual(parser._getConfigPath(), '/custom/config');
            assert.strictEqual(parser._getCredentialsPath(), '/custom/credentials');
        });

        it('returns default AWS paths when no overrides', () => {
            const parser = new AwsProfileParser();
            const home = os.homedir();

            assert.strictEqual(parser._getConfigPath(), join(home, '.aws', 'config'));
            assert.strictEqual(parser._getCredentialsPath(), join(home, '.aws', 'credentials'));
        });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SecretsCommandHandler Unit Tests
 *
 * Tests the _handleCreate method, _constructSecretName, _mergeTags,
 * interactive flow, JSON mode, flag mode, and error handling.
 *
 * Requirements: 2.1–2.13
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import SecretsCommandHandler from '../../src/lib/secrets-command-handler.js';

describe('SecretsCommandHandler', () => {
    let handler;
    let execAwsCalls;
    let originalExitCode;

    beforeEach(() => {
        execAwsCalls = [];
        originalExitCode = process.exitCode;
        process.exitCode = undefined;
    });

    afterEach(() => {
        process.exitCode = originalExitCode;
    });

    function createHandler({ promptAnswers = [], bootstrapProfile = null, execAwsResult = {} } = {}) {
        let promptCallIndex = 0;
        const mockPromptFn = async (_prompts) => {
            const answers = promptAnswers[promptCallIndex] || {};
            promptCallIndex++;
            return answers;
        };

        const mockExecAwsFn = (command, profile) => {
            execAwsCalls.push({ command, profile });
            if (execAwsResult instanceof Error) {
                throw execAwsResult;
            }
            return execAwsResult;
        };

        handler = new SecretsCommandHandler({
            promptFn: mockPromptFn,
            execAwsFn: mockExecAwsFn
        });

        // Override bootstrap config to return mock profile
        handler._bootstrapConfig = {
            getActiveProfile: () => bootstrapProfile
        };

        return handler;
    }

    describe('_constructSecretName', () => {
        it('returns mlcc/<type>/<label> format', () => {
            const h = createHandler();
            assert.strictEqual(h._constructSecretName('hf-token', 'production'), 'mlcc/hf-token/production');
        });

        it('handles labels with special characters', () => {
            const h = createHandler();
            assert.strictEqual(h._constructSecretName('ngc-token', 'my-team'), 'mlcc/ngc-token/my-team');
        });

        it('handles single-character labels', () => {
            const h = createHandler();
            assert.strictEqual(h._constructSecretName('hf-token', 'x'), 'mlcc/hf-token/x');
        });
    });

    describe('_mergeTags', () => {
        it('always includes the three system tags', () => {
            const h = createHandler();
            const tags = h._mergeTags([], 'hf-token');
            assert.strictEqual(tags.length, 3);
            assert.deepStrictEqual(tags[0], { Key: 'mlcc:managed-by', Value: 'ml-container-creator' });
            assert.deepStrictEqual(tags[1], { Key: 'mlcc:created-by', Value: 'secrets' });
            assert.deepStrictEqual(tags[2], { Key: 'mlcc:secret-type', Value: 'hf-token' });
        });

        it('preserves user tags without mlcc: prefix', () => {
            const h = createHandler();
            const userTags = [
                { Key: 'team', Value: 'ml-platform' },
                { Key: 'environment', Value: 'production' }
            ];
            const tags = h._mergeTags(userTags, 'ngc-token');
            assert.strictEqual(tags.length, 5);
            assert.ok(tags.some(t => t.Key === 'team' && t.Value === 'ml-platform'));
            assert.ok(tags.some(t => t.Key === 'environment' && t.Value === 'production'));
        });

        it('removes user tags with mlcc: prefix and warns', () => {
            const h = createHandler();
            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            const userTags = [
                { Key: 'mlcc:managed-by', Value: 'user-override' },
                { Key: 'team', Value: 'data-science' }
            ];
            const tags = h._mergeTags(userTags, 'hf-token');

            console.log = origLog;

            // System tags + 1 preserved user tag
            assert.strictEqual(tags.length, 4);
            assert.ok(tags.some(t => t.Key === 'mlcc:managed-by' && t.Value === 'ml-container-creator'));
            assert.ok(tags.some(t => t.Key === 'team' && t.Value === 'data-science'));
            assert.ok(logs.some(l => l.includes('reserved')));
        });

        it('removes non-system mlcc: prefix tags and warns', () => {
            const h = createHandler();
            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            const userTags = [
                { Key: 'mlcc:custom-tag', Value: 'some-value' }
            ];
            const tags = h._mergeTags(userTags, 'hf-token');

            console.log = origLog;

            // Only system tags, custom mlcc: tag removed
            assert.strictEqual(tags.length, 3);
            assert.ok(!tags.some(t => t.Key === 'mlcc:custom-tag'));
            assert.ok(logs.some(l => l.includes('mlcc:custom-tag')));
        });

        it('handles null/undefined userTags gracefully', () => {
            const h = createHandler();
            const tags = h._mergeTags(null, 'hf-token');
            assert.strictEqual(tags.length, 3);
        });

        it('handles empty array userTags', () => {
            const h = createHandler();
            const tags = h._mergeTags([], 'ngc-token');
            assert.strictEqual(tags.length, 3);
            assert.deepStrictEqual(tags[2], { Key: 'mlcc:secret-type', Value: 'ngc-token' });
        });
    });

    describe('_handleCreate with flags', () => {
        it('creates a secret with valid flags', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: { ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf' }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({
                type: 'hf-token',
                name: 'prod',
                secretValue: 'hf_abc123'
            });

            console.log = origLog;

            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('secretsmanager create-secret'));
            assert.ok(execAwsCalls[0].command.includes('--name mlcc/hf-token/prod'));
            assert.strictEqual(execAwsCalls[0].profile, 'dev');
            assert.ok(logs.some(l => l.includes('✅ Secret created successfully')));
            assert.ok(logs.some(l => l.includes('arn:aws:secretsmanager')));
        });

        it('fails with missing required flags', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({ type: 'hf-token', name: 'prod' });

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('--secret-value')));
        });

        it('fails with unknown secret type', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({ type: 'unknown-type', name: 'test', secretValue: 'val' });

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('Unknown secret type')));
        });

        it('fails when no bootstrap profile is active', async () => {
            const h = createHandler({
                bootstrapProfile: null
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({ type: 'hf-token', name: 'prod', secretValue: 'val' });

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('No active bootstrap profile')));
        });

        it('handles AWS API failure gracefully', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: new Error('ResourceExistsException: secret already exists')
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({ type: 'hf-token', name: 'prod', secretValue: 'val' });

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('Failed to create secret')));
        });

        it('includes description and kms-key-id in command when provided', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: { ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf' }
            });

            await h._handleCreate({
                type: 'hf-token',
                name: 'prod',
                secretValue: 'hf_abc123',
                description: 'Production HF token',
                kmsKeyId: 'alias/my-key'
            });

            assert.ok(execAwsCalls[0].command.includes('--description'));
            assert.ok(execAwsCalls[0].command.includes('--kms-key-id alias/my-key'));
        });
    });

    describe('_handleCreate with --json flag', () => {
        it('creates a secret from inline JSON', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-west-2' } },
                execAwsResult: { ARN: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:mlcc/ngc-token/ci-AbCdEf' }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({
                json: '{"type":"ngc-token","name":"ci","secretValue":"nvapi-abc"}'
            });

            console.log = origLog;

            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('--name mlcc/ngc-token/ci'));
            assert.ok(logs.some(l => l.includes('✅ Secret created successfully')));
        });

        it('creates a secret from file:// path', async () => {
            const testDir = path.join(tmpdir(), `mlcc-test-${  Date.now()}`);
            mkdirSync(testDir, { recursive: true });
            const testFile = path.join(testDir, 'secret.json');
            writeFileSync(testFile, JSON.stringify({
                type: 'hf-token',
                name: 'from-file',
                secretValue: 'hf_file_token'
            }));

            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: { ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/from-file-AbCdEf' }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({ json: `file://${testFile}` });

            console.log = origLog;

            assert.ok(execAwsCalls[0].command.includes('--name mlcc/hf-token/from-file'));
            assert.ok(logs.some(l => l.includes('✅ Secret created successfully')));

            rmSync(testDir, { recursive: true, force: true });
        });

        it('fails with invalid JSON', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({ json: 'not-valid-json' });

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('Invalid JSON')));
        });

        it('fails when file:// path does not exist', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({ json: 'file:///nonexistent/path/secret.json' });

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('File not found')));
        });

        it('merges user tags from JSON and preserves non-mlcc: tags', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: { ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/tagged-AbCdEf' }
            });

            await h._handleCreate({
                json: JSON.stringify({
                    type: 'hf-token',
                    name: 'tagged',
                    secretValue: 'hf_val',
                    tags: [
                        { Key: 'team', Value: 'ml' },
                        { Key: 'mlcc:managed-by', Value: 'user-attempt' }
                    ]
                })
            });

            // The command should have been called with tags that include system + user non-mlcc tags
            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('--tags'));
        });
    });

    describe('_handleCreate interactive mode', () => {
        it('prompts for type, name, value, and description', async () => {
            const h = createHandler({
                promptAnswers: [
                    { secretType: 'hf-token' },
                    { label: 'interactive-test' },
                    { value: 'hf_interactive_val' },
                    { description: '' }
                ],
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: { ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/interactive-test-AbCdEf' }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleCreate({});

            console.log = origLog;

            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('--name mlcc/hf-token/interactive-test'));
            assert.ok(logs.some(l => l.includes('✅ Secret created successfully')));
        });
    });

    describe('_handleList', () => {
        it('displays secrets when they exist', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    SecretList: [
                        {
                            Name: 'mlcc/hf-token/production',
                            ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf',
                            Tags: [
                                { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                                { Key: 'mlcc:secret-type', Value: 'hf-token' }
                            ],
                            CreatedDate: '2024-01-15T10:30:00Z',
                            LastAccessedDate: '2024-06-01T08:00:00Z'
                        },
                        {
                            Name: 'mlcc/ngc-token/ci-pipeline',
                            ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/ngc-token/ci-pipeline-XyZaBC',
                            Tags: [
                                { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                                { Key: 'mlcc:secret-type', Value: 'ngc-token' }
                            ],
                            CreatedDate: '2024-03-20T14:00:00Z',
                            LastAccessedDate: null
                        }
                    ]
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleList();

            console.log = origLog;

            // Verify the command used correct filters and region
            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('secretsmanager list-secrets'));
            assert.ok(execAwsCalls[0].command.includes('Key=tag-key,Values=mlcc:managed-by'));
            assert.ok(execAwsCalls[0].command.includes('Key=tag-value,Values=ml-container-creator'));
            assert.ok(execAwsCalls[0].command.includes('--region us-east-1'));
            assert.strictEqual(execAwsCalls[0].profile, 'dev');

            // Verify output contains secret details
            const output = logs.join('\n');
            assert.ok(output.includes('mlcc/hf-token/production'));
            assert.ok(output.includes('arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf'));
            assert.ok(output.includes('hf-token'));
            assert.ok(output.includes('mlcc/ngc-token/ci-pipeline'));
            assert.ok(output.includes('ngc-token'));

            // Verify header shows count
            assert.ok(output.includes('Managed Secrets (2)'));
        });

        it('displays helpful message when no secrets exist', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-west-2' } },
                execAwsResult: { SecretList: [] }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleList();

            console.log = origLog;

            const output = logs.join('\n');
            assert.ok(output.includes('No mlcc-managed secrets found'));
            assert.ok(output.includes('secrets create'));
        });

        it('fails when no bootstrap profile is active', async () => {
            const h = createHandler({
                bootstrapProfile: null
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleList();

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('No active bootstrap profile')));
        });

        it('handles AWS API failure gracefully', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: new Error('AccessDeniedException: not authorized')
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleList();

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('Failed to list secrets')));
        });

        it('never displays secret values in output', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    SecretList: [
                        {
                            Name: 'mlcc/hf-token/production',
                            ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf',
                            Tags: [{ Key: 'mlcc:secret-type', Value: 'hf-token' }],
                            CreatedDate: '2024-01-15T10:30:00Z',
                            LastAccessedDate: '2024-06-01T08:00:00Z'
                        }
                    ]
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleList();

            console.log = origLog;

            // The command should NOT call get-secret-value
            const output = logs.join('\n');
            assert.ok(!execAwsCalls[0].command.includes('get-secret-value'));
            // Output should not contain any secret value patterns
            assert.ok(!output.includes('SecretString'));
            assert.ok(!output.includes('SecretBinary'));
        });

        it('handles secrets with missing Tags gracefully', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    SecretList: [
                        {
                            Name: 'mlcc/hf-token/no-tags',
                            ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/no-tags-AbCdEf',
                            Tags: null,
                            CreatedDate: '2024-01-15T10:30:00Z',
                            LastAccessedDate: null
                        }
                    ]
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleList();

            console.log = origLog;

            const output = logs.join('\n');
            assert.ok(output.includes('mlcc/hf-token/no-tags'));
            assert.ok(output.includes('unknown'));
            assert.ok(output.includes('Never'));
        });

        it('handles empty SecretList response from AWS', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {}
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleList();

            console.log = origLog;

            const output = logs.join('\n');
            assert.ok(output.includes('No mlcc-managed secrets found'));
        });

        it('uses the active bootstrap profile region', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'prod', config: { awsProfile: 'production', awsRegion: 'eu-west-1' } },
                execAwsResult: { SecretList: [] }
            });

            await h._handleList();

            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('--region eu-west-1'));
            assert.strictEqual(execAwsCalls[0].profile, 'production');
        });
    });

    describe('_handleDescribe', () => {
        it('displays secret metadata for a valid managed secret', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    Name: 'mlcc/hf-token/production',
                    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf',
                    Description: 'Production HuggingFace token',
                    Tags: [
                        { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                        { Key: 'mlcc:created-by', Value: 'secrets' },
                        { Key: 'mlcc:secret-type', Value: 'hf-token' },
                        { Key: 'team', Value: 'ml-platform' }
                    ],
                    CreatedDate: '2024-01-15T10:30:00Z',
                    LastChangedDate: '2024-03-01T14:00:00Z',
                    LastAccessedDate: '2024-06-01T08:00:00Z',
                    RotationEnabled: false
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe('mlcc/hf-token/production');

            console.log = origLog;

            const output = logs.join('\n');

            // Verify correct AWS command was called
            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('secretsmanager describe-secret'));
            assert.ok(execAwsCalls[0].command.includes('--secret-id mlcc/hf-token/production'));
            assert.ok(execAwsCalls[0].command.includes('--region us-east-1'));
            assert.strictEqual(execAwsCalls[0].profile, 'dev');

            // Verify output contains all metadata fields
            assert.ok(output.includes('mlcc/hf-token/production'));
            assert.ok(output.includes('arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf'));
            assert.ok(output.includes('Production HuggingFace token'));
            assert.ok(output.includes('hf-token'));
            assert.ok(output.includes('Disabled'));

            // Verify tags are displayed
            assert.ok(output.includes('mlcc:managed-by = ml-container-creator'));
            assert.ok(output.includes('team = ml-platform'));
        });

        it('displays rotation configuration when enabled', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    Name: 'mlcc/hf-token/rotated',
                    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/rotated-AbCdEf',
                    Description: '',
                    Tags: [
                        { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                        { Key: 'mlcc:secret-type', Value: 'hf-token' }
                    ],
                    CreatedDate: '2024-01-15T10:30:00Z',
                    LastChangedDate: '2024-03-01T14:00:00Z',
                    LastAccessedDate: null,
                    RotationEnabled: true,
                    RotationRules: {
                        AutomaticallyAfterDays: 30,
                        Duration: '2h',
                        ScheduleExpression: 'rate(30 days)'
                    }
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe('mlcc/hf-token/rotated');

            console.log = origLog;

            const output = logs.join('\n');
            assert.ok(output.includes('Enabled'));
            assert.ok(output.includes('Every 30 days'));
            assert.ok(output.includes('2h'));
            assert.ok(output.includes('rate(30 days)'));
        });

        it('fails when no name or ARN is provided', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe(undefined);

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('Missing secret name or ARN')));
        });

        it('fails when no bootstrap profile is active', async () => {
            const h = createHandler({
                bootstrapProfile: null
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe('mlcc/hf-token/prod');

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('No active bootstrap profile')));
        });

        it('fails when secret is not found (AWS error)', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: new Error('ResourceNotFoundException: secret not found')
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe('mlcc/hf-token/nonexistent');

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('Secret not found')));
            assert.ok(logs.some(l => l.includes('ResourceNotFoundException')));
        });

        it('fails when secret is not a managed secret (missing mlcc:managed-by tag)', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    Name: 'some-other-secret',
                    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:some-other-secret-AbCdEf',
                    Tags: [
                        { Key: 'owner', Value: 'other-team' }
                    ],
                    CreatedDate: '2024-01-15T10:30:00Z'
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe('some-other-secret');

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('not managed by ml-container-creator')));
        });

        it('fails when secret has no tags at all', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    Name: 'untagged-secret',
                    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:untagged-secret-AbCdEf',
                    Tags: null,
                    CreatedDate: '2024-01-15T10:30:00Z'
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe('untagged-secret');

            console.log = origLog;

            assert.strictEqual(process.exitCode, 1);
            assert.ok(logs.some(l => l.includes('not managed by ml-container-creator')));
        });

        it('never calls GetSecretValue', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    Name: 'mlcc/hf-token/production',
                    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf',
                    Tags: [
                        { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                        { Key: 'mlcc:secret-type', Value: 'hf-token' }
                    ],
                    CreatedDate: '2024-01-15T10:30:00Z',
                    RotationEnabled: false
                }
            });

            await h._handleDescribe('mlcc/hf-token/production');

            // Verify only describe-secret was called, never get-secret-value
            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('describe-secret'));
            assert.ok(!execAwsCalls[0].command.includes('get-secret-value'));
        });

        it('handles secret with ARN as input', async () => {
            const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/production-AbCdEf';
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    Name: 'mlcc/hf-token/production',
                    ARN: arn,
                    Tags: [
                        { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                        { Key: 'mlcc:secret-type', Value: 'hf-token' }
                    ],
                    CreatedDate: '2024-01-15T10:30:00Z',
                    RotationEnabled: false
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe(arn);

            console.log = origLog;

            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes(`--secret-id ${arn}`));
            assert.ok(!process.exitCode);
        });

        it('displays (none) when description is empty', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    Name: 'mlcc/hf-token/no-desc',
                    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/no-desc-AbCdEf',
                    Description: '',
                    Tags: [
                        { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                        { Key: 'mlcc:secret-type', Value: 'hf-token' }
                    ],
                    CreatedDate: '2024-01-15T10:30:00Z',
                    RotationEnabled: false
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe('mlcc/hf-token/no-desc');

            console.log = origLog;

            const output = logs.join('\n');
            assert.ok(output.includes('(none)'));
        });

        it('displays Never when LastAccessedDate is null', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } },
                execAwsResult: {
                    Name: 'mlcc/hf-token/new-secret',
                    ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/new-secret-AbCdEf',
                    Tags: [
                        { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                        { Key: 'mlcc:secret-type', Value: 'hf-token' }
                    ],
                    CreatedDate: '2024-01-15T10:30:00Z',
                    LastChangedDate: null,
                    LastAccessedDate: null,
                    RotationEnabled: false
                }
            });

            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h._handleDescribe('mlcc/hf-token/new-secret');

            console.log = origLog;

            const output = logs.join('\n');
            assert.ok(output.includes('Never'));
            assert.ok(output.includes('N/A'));
        });

        it('uses the active bootstrap profile region', async () => {
            const h = createHandler({
                bootstrapProfile: { name: 'prod', config: { awsProfile: 'production', awsRegion: 'eu-west-1' } },
                execAwsResult: {
                    Name: 'mlcc/hf-token/eu-secret',
                    ARN: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:mlcc/hf-token/eu-secret-AbCdEf',
                    Tags: [
                        { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                        { Key: 'mlcc:secret-type', Value: 'hf-token' }
                    ],
                    CreatedDate: '2024-01-15T10:30:00Z',
                    RotationEnabled: false
                }
            });

            await h._handleDescribe('mlcc/hf-token/eu-secret');

            assert.strictEqual(execAwsCalls.length, 1);
            assert.ok(execAwsCalls[0].command.includes('--region eu-west-1'));
            assert.strictEqual(execAwsCalls[0].profile, 'production');
        });
    });

    describe('subcommand dispatch', () => {
        it('dispatches to _handleCreate for "create" action', async () => {
            let createCalled = false;
            const h = createHandler({
                bootstrapProfile: { name: 'default', config: { awsProfile: 'dev', awsRegion: 'us-east-1' } }
            });
            h._handleCreate = async () => { createCalled = true; };

            await h.handle(['create'], {});
            assert.ok(createCalled);
        });

        it('dispatches to _handleList for "list" action', async () => {
            let listCalled = false;
            const h = createHandler();
            h._handleList = async () => { listCalled = true; };

            await h.handle(['list'], {});
            assert.ok(listCalled);
        });

        it('dispatches to _handleDescribe for "describe" action', async () => {
            let describeCalled = false;
            let describeArg;
            const h = createHandler();
            h._handleDescribe = async (arg) => { describeCalled = true; describeArg = arg; };

            await h.handle(['describe', 'mlcc/hf-token/prod'], {});
            assert.ok(describeCalled);
            assert.strictEqual(describeArg, 'mlcc/hf-token/prod');
        });

        it('shows help for unknown subcommand', async () => {
            const h = createHandler();
            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h.handle(['unknown'], {});

            console.log = origLog;
            assert.ok(logs.some(l => l.includes('Unknown secrets subcommand')));
        });

        it('shows help when no args provided', async () => {
            const h = createHandler();
            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);

            await h.handle([], {});

            console.log = origLog;
            assert.ok(logs.some(l => l.includes('USAGE')));
        });
    });
});

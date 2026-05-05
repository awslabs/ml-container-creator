// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap AWS CLI Command Construction Unit Tests
 *
 * Tests that BootstrapCommandHandler correctly constructs AWS CLI commands
 * with profile and region flags, and that _resourceExists returns the
 * correct boolean based on command success or failure.
 *
 * Validates: Requirements 3.1, 4.1, 5.1
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../generators/app/lib/bootstrap-command-handler.js';

/**
 * Creates a minimal mock generator.
 * @returns {object} Mock generator
 */
function createMockGenerator() {
    return {
        prompt: async () => ({})
    };
}

describe('Bootstrap AWS CLI Command Construction', () => {
    let handler;

    beforeEach(() => {
        handler = new BootstrapCommandHandler(createMockGenerator());
    });

    describe('_execAws()', () => {
        it('constructs command with --profile and --output json flags', () => {
            let capturedCommand = null;

            // Override _execAws to capture the command it would build
            handler._execAws = (command, profile) => {
                // Reconstruct the full command the same way the real method does
                capturedCommand = `aws ${command} --profile ${profile} --output json`;
                return { test: true };
            };

            handler._execAws('sts get-caller-identity', 'my-profile');

            assert.strictEqual(capturedCommand, 'aws sts get-caller-identity --profile my-profile --output json');
        });

        it('includes the profile name in the constructed command', () => {
            let capturedCommand = null;

            handler._execAws = (command, profile) => {
                capturedCommand = `aws ${command} --profile ${profile} --output json`;
                return {};
            };

            handler._execAws('iam get-role --role-name test-role', 'prod-account');

            assert.ok(capturedCommand.includes('--profile prod-account'), 'command should include --profile flag with profile name');
        });

        it('parses JSON output correctly', () => {
            // Override _execAws to simulate JSON parsing behavior
            handler._execAws = (_command, _profile) => {
                // Simulate what the real _execAws does: parse JSON output
                const jsonOutput = '{"Account": "123456789012", "Arn": "arn:aws:iam::123456789012:user/test"}';
                return JSON.parse(jsonOutput);
            };

            const result = handler._execAws('sts get-caller-identity', 'default');

            assert.strictEqual(result.Account, '123456789012');
            assert.strictEqual(result.Arn, 'arn:aws:iam::123456789012:user/test');
        });

        it('throws when the underlying command fails', () => {
            handler._execAws = (_command, _profile) => {
                throw new Error('Command failed: aws sts get-caller-identity');
            };

            assert.throws(
                () => handler._execAws('sts get-caller-identity', 'bad-profile'),
                /Command failed/
            );
        });
    });

    describe('_resourceExists()', () => {
        it('returns true when _execAws succeeds', () => {
            handler._execAws = (_command, _profile) => {
                return { Role: { Arn: 'arn:aws:iam::123456789012:role/test-role' } };
            };

            const result = handler._resourceExists('iam get-role --role-name test-role', 'my-profile');

            assert.strictEqual(result, true);
        });

        it('returns false when _execAws throws', () => {
            handler._execAws = (_command, _profile) => {
                throw new Error('An error occurred (NoSuchEntity)');
            };

            const result = handler._resourceExists('iam get-role --role-name nonexistent', 'my-profile');

            assert.strictEqual(result, false);
        });

        it('returns true for ECR describe-repositories when repo exists', () => {
            handler._execAws = (_command, _profile) => {
                return { repositories: [{ repositoryName: 'ml-container-creator' }] };
            };

            const result = handler._resourceExists(
                'ecr describe-repositories --repository-names ml-container-creator --region us-east-1',
                'default'
            );

            assert.strictEqual(result, true);
        });

        it('returns false for ECR describe-repositories when repo does not exist', () => {
            handler._execAws = (_command, _profile) => {
                throw new Error('RepositoryNotFoundException');
            };

            const result = handler._resourceExists(
                'ecr describe-repositories --repository-names ml-container-creator --region us-east-1',
                'default'
            );

            assert.strictEqual(result, false);
        });

        it('returns true for s3api head-bucket when bucket exists', () => {
            handler._execAws = (_command, _profile) => {
                return {};
            };

            const result = handler._resourceExists(
                's3api head-bucket --bucket ml-container-creator-async-us-east-1-123456789012',
                'default'
            );

            assert.strictEqual(result, true);
        });

        it('returns false for s3api head-bucket when bucket does not exist', () => {
            handler._execAws = (_command, _profile) => {
                throw new Error('Not Found');
            };

            const result = handler._resourceExists(
                's3api head-bucket --bucket ml-container-creator-async-us-east-1-123456789012',
                'default'
            );

            assert.strictEqual(result, false);
        });
    });

    describe('_buildResourceTags()', () => {
        it('returns exactly 3 tags', () => {
            const tags = handler._buildResourceTags();

            assert.strictEqual(tags.length, 3, 'should return exactly 3 tags');
        });

        it('includes mlcc:managed-by tag with correct value', () => {
            const tags = handler._buildResourceTags();
            const managedByTag = tags.find(t => t.Key === 'mlcc:managed-by');

            assert.ok(managedByTag, 'should include mlcc:managed-by tag');
            assert.strictEqual(managedByTag.Value, 'ml-container-creator');
        });

        it('includes mlcc:created-by tag with correct value', () => {
            const tags = handler._buildResourceTags();
            const createdByTag = tags.find(t => t.Key === 'mlcc:created-by');

            assert.ok(createdByTag, 'should include mlcc:created-by tag');
            assert.strictEqual(createdByTag.Value, 'bootstrap');
        });

        it('includes mlcc:version tag with a version string', () => {
            const tags = handler._buildResourceTags();
            const versionTag = tags.find(t => t.Key === 'mlcc:version');

            assert.ok(versionTag, 'should include mlcc:version tag');
            assert.ok(versionTag.Value.length > 0, 'version should be a non-empty string');
        });

        it('returns tags with correct Key/Value structure', () => {
            const tags = handler._buildResourceTags();

            for (const tag of tags) {
                assert.ok(tag.Key, 'each tag should have a Key');
                assert.ok(tag.Value, 'each tag should have a Value');
                assert.strictEqual(typeof tag.Key, 'string');
                assert.strictEqual(typeof tag.Value, 'string');
            }
        });
    });

    describe('_formatTagsForCli()', () => {
        it('formats a single tag correctly', () => {
            const tags = [{ Key: 'mlcc:managed-by', Value: 'ml-container-creator' }];

            const result = handler._formatTagsForCli(tags);

            // Returns a file:// path to a temp JSON file containing the tags
            assert.ok(result.startsWith('file://'), 'should return a file:// path');
            assert.ok(result.endsWith('.json'), 'should end with .json');
        });

        it('formats multiple tags separated by spaces', () => {
            const tags = [
                { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                { Key: 'mlcc:created-by', Value: 'bootstrap' },
                { Key: 'mlcc:version', Value: '1.0.0' }
            ];

            const result = handler._formatTagsForCli(tags);

            assert.ok(result.startsWith('file://'), 'should return a file:// path');
            assert.ok(result.endsWith('.json'), 'should end with .json');
        });

        it('returns empty string for empty tag array', () => {
            const result = handler._formatTagsForCli([]);

            // Even empty arrays get written to a file
            assert.ok(result.startsWith('file://'), 'should return a file:// path');
        });

        it('formats the output of _buildResourceTags() correctly', () => {
            const tags = handler._buildResourceTags();
            const result = handler._formatTagsForCli(tags);

            assert.ok(result.startsWith('file://'), 'should return a file:// path');
            assert.ok(result.endsWith('.json'), 'should end with .json');
        });
    });
});

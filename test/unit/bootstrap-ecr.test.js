// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap ECR Repository Setup Unit Tests
 *
 * Tests the _setupEcrRepository() method of BootstrapCommandHandler:
 * - Repository reuse when repository already exists
 * - Repository creation with image scanning, AES256 encryption, and tags
 * - Lifecycle policy application for untagged image expiration
 * - Correct AWS CLI command construction including region
 * - Return value is always 'ml-container-creator'
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const REPO_NAME = 'ml-container-creator';

/**
 * Creates a mock generator with a configurable prompt response.
 * @param {object} promptResponse - The response to return from prompt()
 * @returns {object} Mock generator
 */
// eslint-disable-next-line no-unused-vars
function createMockGenerator(promptResponse = {}) {
    return {
        prompt: async () => promptResponse
    };
}

/**
 * Sets up a handler with mocked _execAws and _resourceExists,
 * tracking all _execAws calls for assertion.
 *
 * @param {object} opts
 * @param {boolean} opts.repoExists - Whether _resourceExists returns true
 * @param {Function} [opts.execAwsImpl] - Custom _execAws implementation
 * @returns {{ handler, execAwsCalls, logs, restore }}
 */
function setupHandler({ repoExists = false, execAwsImpl } = {}) {
    const handler = new BootstrapCommandHandler();
    handler._currentProfile = 'test-profile';
    handler._currentRegion = 'us-east-1';

    const execAwsCalls = [];
    const logs = [];

    // Capture console.log output
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    // Override _resourceExists
    handler._resourceExists = (_command, _profile) => repoExists;

    // Override _execAws
    if (execAwsImpl) {
        handler._execAws = (command, profile) => {
            execAwsCalls.push({ command, profile });
            return execAwsImpl(command, profile);
        };
    } else {
        handler._execAws = (command, profile) => {
            execAwsCalls.push({ command, profile });
            return {};
        };
    }

    // Override _writeJsonTempFile to inline JSON so command strings contain expected text
    handler._writeJsonTempFile = (jsonObj, _prefix) => JSON.stringify(jsonObj);

    // Provide a restore function to reset console.log
    const restore = () => { console.log = origLog; };

    return { handler, execAwsCalls, logs, restore };
}

describe('Bootstrap ECR Repository Setup', () => {
    describe('when repository already exists (_resourceExists returns true)', () => {
        it('should return "ml-container-creator" and display "reused" message', async () => {
            const { handler, execAwsCalls, logs, restore } = setupHandler({ repoExists: true });

            try {
                const repoName = await handler._setupEcrRepository();

                assert.strictEqual(repoName, REPO_NAME, 'should return the repository name');

                // Should NOT have called ecr create-repository
                const createCalls = execAwsCalls.filter(c => c.command.includes('ecr create-repository'));
                assert.strictEqual(createCalls.length, 0, 'should not call ecr create-repository');

                // Should NOT have called ecr put-lifecycle-policy
                const lifecycleCalls = execAwsCalls.filter(c => c.command.includes('ecr put-lifecycle-policy'));
                assert.strictEqual(lifecycleCalls.length, 0, 'should not call ecr put-lifecycle-policy');

                // Should display "reused" message
                assert.ok(logs.some(l => l.includes('reused')), 'should display "reused" message');
                assert.ok(logs.some(l => l.includes(REPO_NAME)), 'should mention repository name in output');
            } finally {
                restore();
            }
        });
    });

    describe('when repository does not exist', () => {
        it('should create it with image scanning, AES256 encryption, and tags', async () => {
            const { handler, execAwsCalls, logs, restore } = setupHandler({ repoExists: false });

            try {
                const repoName = await handler._setupEcrRepository();

                assert.strictEqual(repoName, REPO_NAME, 'should return the repository name');

                // Should have called ecr create-repository
                const createCalls = execAwsCalls.filter(c => c.command.includes('ecr create-repository'));
                assert.strictEqual(createCalls.length, 1, 'should call ecr create-repository once');

                const createCmd = createCalls[0].command;
                assert.ok(
                    createCmd.includes(`--repository-name ${REPO_NAME}`),
                    'create-repository command should include --repository-name'
                );
                assert.ok(
                    createCmd.includes('--image-scanning-configuration scanOnPush=true'),
                    'create-repository command should enable image scanning on push'
                );
                assert.ok(
                    createCmd.includes('--encryption-configuration encryptionType=AES256'),
                    'create-repository command should use AES256 encryption'
                );
                assert.ok(
                    createCmd.includes('--tags'),
                    'create-repository command should include --tags'
                );

                // Should display "created" message
                assert.ok(logs.some(l => l.includes('created')), 'should display "created" message');
            } finally {
                restore();
            }
        });

        it('should apply lifecycle policy to expire untagged images after 30 days', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ repoExists: false });

            try {
                await handler._setupEcrRepository();

                // Should have called ecr put-lifecycle-policy
                const lifecycleCalls = execAwsCalls.filter(c => c.command.includes('ecr put-lifecycle-policy'));
                assert.strictEqual(lifecycleCalls.length, 1, 'should call ecr put-lifecycle-policy once');

                const lifecycleCmd = lifecycleCalls[0].command;
                assert.ok(
                    lifecycleCmd.includes(`--repository-name ${REPO_NAME}`),
                    'put-lifecycle-policy command should include --repository-name'
                );
                assert.ok(
                    lifecycleCmd.includes('--lifecycle-policy-text'),
                    'put-lifecycle-policy command should include --lifecycle-policy-text'
                );

                // Verify the lifecycle policy content includes key fields
                assert.ok(
                    lifecycleCmd.includes('untagged'),
                    'lifecycle policy should target untagged images'
                );
                assert.ok(
                    lifecycleCmd.includes('30'),
                    'lifecycle policy should specify 30 days'
                );
                assert.ok(
                    lifecycleCmd.includes('expire'),
                    'lifecycle policy action should be expire'
                );
            } finally {
                restore();
            }
        });
    });

    describe('return value', () => {
        it('should always return "ml-container-creator" when repo exists', async () => {
            const { handler, restore } = setupHandler({ repoExists: true });

            try {
                const repoName = await handler._setupEcrRepository();
                assert.strictEqual(repoName, REPO_NAME, 'should return "ml-container-creator"');
            } finally {
                restore();
            }
        });

        it('should always return "ml-container-creator" when repo is created', async () => {
            const { handler, restore } = setupHandler({ repoExists: false });

            try {
                const repoName = await handler._setupEcrRepository();
                assert.strictEqual(repoName, REPO_NAME, 'should return "ml-container-creator"');
            } finally {
                restore();
            }
        });
    });

    describe('region in AWS CLI commands', () => {
        it('should include region in the describe-repositories and create-repository commands', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ repoExists: false });

            // Capture the _resourceExists call to verify region
            const resourceExistsCalls = [];
            handler._resourceExists = (command, profile) => {
                resourceExistsCalls.push({ command, profile });
                return false;
            };

            try {
                await handler._setupEcrRepository();

                // Verify _resourceExists was called with region in the describe-repositories command
                assert.strictEqual(resourceExistsCalls.length, 1, 'should call _resourceExists once');
                assert.ok(
                    resourceExistsCalls[0].command.includes('ecr describe-repositories'),
                    'resource check should use ecr describe-repositories'
                );
                assert.ok(
                    resourceExistsCalls[0].command.includes('--region us-east-1'),
                    'describe-repositories command should include --region'
                );

                // Verify create-repository includes region
                const createCalls = execAwsCalls.filter(c => c.command.includes('ecr create-repository'));
                assert.strictEqual(createCalls.length, 1, 'should call ecr create-repository once');
                assert.ok(
                    createCalls[0].command.includes('--region us-east-1'),
                    'create-repository command should include --region'
                );

                // Verify put-lifecycle-policy includes region
                const lifecycleCalls = execAwsCalls.filter(c => c.command.includes('ecr put-lifecycle-policy'));
                assert.strictEqual(lifecycleCalls.length, 1, 'should call ecr put-lifecycle-policy once');
                assert.ok(
                    lifecycleCalls[0].command.includes('--region us-east-1'),
                    'put-lifecycle-policy command should include --region'
                );
            } finally {
                restore();
            }
        });
    });
});

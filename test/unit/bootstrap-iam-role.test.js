// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap IAM Role Setup Unit Tests
 *
 * Tests the _setupIamRole() method of BootstrapCommandHandler:
 * - Role reuse when role already exists
 * - Role creation flow (create-role, put-role-policy, tag-role)
 * - Fallback to user-provided ARN on AccessDenied error
 * - Error propagation for non-permission errors
 * - Trust policy and execution policy display before creation
 * - Correct AWS CLI command construction for each step
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const ROLE_NAME = 'mlcc-sagemaker-execution-role';
const EXISTING_ROLE_ARN = 'arn:aws:iam::123456789012:role/mlcc-sagemaker-execution-role';
const USER_PROVIDED_ARN = 'arn:aws:iam::123456789012:role/my-custom-role';

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
 * @param {boolean} opts.roleExists - Whether _resourceExists returns true
 * @param {object} opts.promptResponse - Response from generator.prompt()
 * @param {Function} [opts.execAwsImpl] - Custom _execAws implementation
 * @returns {{ handler, execAwsCalls, logs }}
 */
function setupHandler({ roleExists = false, promptResponse = {}, execAwsImpl } = {}) {
    const handler = new BootstrapCommandHandler({ promptFn: async () => promptResponse });
    handler._currentProfile = 'test-profile';

    const execAwsCalls = [];
    const logs = [];

    // Capture console.log output
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    // Override _resourceExists
    handler._resourceExists = (_command, _profile) => roleExists;

    // Override _execAws
    if (execAwsImpl) {
        handler._execAws = (command, profile) => {
            execAwsCalls.push({ command, profile });
            return execAwsImpl(command, profile);
        };
    } else {
        handler._execAws = (command, profile) => {
            execAwsCalls.push({ command, profile });
            // Default: return role object for get-role, empty for others
            if (command.includes('iam get-role')) {
                return { Role: { Arn: EXISTING_ROLE_ARN } };
            }
            if (command.includes('iam create-role')) {
                return { Role: { Arn: EXISTING_ROLE_ARN } };
            }
            return {};
        };
    }

    // Override _writeJsonTempFile to inline JSON so command strings contain expected text
    handler._writeJsonTempFile = (jsonObj, _prefix) => JSON.stringify(jsonObj);

    // Provide a restore function to reset console.log
    const restore = () => { console.log = origLog; };

    return { handler, execAwsCalls, logs, restore };
}

describe('Bootstrap IAM Role Setup', () => {
    describe('when role already exists (_resourceExists returns true)', () => {
        it('should return existing role ARN and display "reused" message', async () => {
            const { handler, execAwsCalls, logs, restore } = setupHandler({ roleExists: true });

            try {
                const roleArn = await handler._setupIamRole({});

                assert.strictEqual(roleArn, EXISTING_ROLE_ARN, 'should return the existing role ARN');

                // Should have called _execAws with iam get-role to fetch the ARN
                const getRoleCalls = execAwsCalls.filter(c => c.command.includes('iam get-role'));
                assert.strictEqual(getRoleCalls.length, 1, 'should call iam get-role once to fetch ARN');
                assert.ok(getRoleCalls[0].command.includes(ROLE_NAME), 'get-role command should include role name');

                // Should NOT have called create-role
                const createCalls = execAwsCalls.filter(c => c.command.includes('iam create-role'));
                assert.strictEqual(createCalls.length, 0, 'should not call iam create-role');

                // Per BL-019: should ALWAYS update inline policy when reusing
                const policyCalls = execAwsCalls.filter(c => c.command.includes('iam put-role-policy'));
                assert.strictEqual(policyCalls.length, 1, 'should call iam put-role-policy to update policy on reuse');

                // Per BL-019: should ALWAYS update tags when reusing
                const tagCalls = execAwsCalls.filter(c => c.command.includes('iam tag-role'));
                assert.strictEqual(tagCalls.length, 1, 'should call iam tag-role to update tags on reuse');

                // Should display "reused" message
                assert.ok(logs.some(l => l.includes('reused')), 'should display "reused" message');
                assert.ok(logs.some(l => l.includes(ROLE_NAME)), 'should mention role name in output');
            } finally {
                restore();
            }
        });
    });

    describe('when role does not exist', () => {
        it('should create role, attach policy, tag it, and return new role ARN', async () => {
            const { handler, execAwsCalls, logs, restore } = setupHandler({ roleExists: false });

            try {
                const roleArn = await handler._setupIamRole({});

                assert.strictEqual(roleArn, EXISTING_ROLE_ARN, 'should return the newly created role ARN');

                // Should have called create-role
                const createCalls = execAwsCalls.filter(c => c.command.includes('iam create-role'));
                assert.strictEqual(createCalls.length, 1, 'should call iam create-role once');

                // Should have called put-role-policy
                const policyCalls = execAwsCalls.filter(c => c.command.includes('iam put-role-policy'));
                assert.strictEqual(policyCalls.length, 1, 'should call iam put-role-policy once');

                // Should have called tag-role
                const tagCalls = execAwsCalls.filter(c => c.command.includes('iam tag-role'));
                assert.strictEqual(tagCalls.length, 1, 'should call iam tag-role once');

                // Should display "created" message
                assert.ok(logs.some(l => l.includes('created')), 'should display "created" message');
            } finally {
                restore();
            }
        });

        it('should display trust policy and execution policy before creation', async () => {
            const { handler, logs, restore } = setupHandler({ roleExists: false });

            try {
                await handler._setupIamRole({});

                // Should display trust policy
                assert.ok(
                    logs.some(l => l.includes('Trust Policy')),
                    'should display "Trust Policy" heading'
                );

                // Should display execution policy
                assert.ok(
                    logs.some(l => l.includes('Execution Policy')),
                    'should display "Execution Policy" heading'
                );

                // Should display sagemaker.amazonaws.com in trust policy
                assert.ok(
                    logs.some(l => l.includes('sagemaker.amazonaws.com')),
                    'should display SageMaker service principal in trust policy'
                );
            } finally {
                restore();
            }
        });

        it('should call _execAws with correct iam create-role command', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ roleExists: false });

            try {
                await handler._setupIamRole({});

                const createCall = execAwsCalls.find(c => c.command.includes('iam create-role'));
                assert.ok(createCall, 'should have a create-role call');
                assert.ok(
                    createCall.command.includes(`--role-name ${ROLE_NAME}`),
                    'create-role command should include --role-name with correct role name'
                );
                assert.ok(
                    createCall.command.includes('--assume-role-policy-document'),
                    'create-role command should include --assume-role-policy-document'
                );
                assert.strictEqual(
                    createCall.profile,
                    'test-profile',
                    'create-role should use the current profile'
                );
            } finally {
                restore();
            }
        });

        it('should call _execAws with correct iam put-role-policy command', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ roleExists: false });

            try {
                await handler._setupIamRole({});

                const policyCall = execAwsCalls.find(c => c.command.includes('iam put-role-policy'));
                assert.ok(policyCall, 'should have a put-role-policy call');
                assert.ok(
                    policyCall.command.includes(`--role-name ${ROLE_NAME}`),
                    'put-role-policy command should include --role-name'
                );
                assert.ok(
                    policyCall.command.includes('--policy-name mlcc-execution-policy'),
                    'put-role-policy command should include --policy-name mlcc-execution-policy'
                );
                assert.ok(
                    policyCall.command.includes('--policy-document'),
                    'put-role-policy command should include --policy-document'
                );
                assert.strictEqual(
                    policyCall.profile,
                    'test-profile',
                    'put-role-policy should use the current profile'
                );
            } finally {
                restore();
            }
        });

        it('should call _execAws with correct iam tag-role command', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ roleExists: false });

            try {
                await handler._setupIamRole({});

                const tagCall = execAwsCalls.find(c => c.command.includes('iam tag-role'));
                assert.ok(tagCall, 'should have a tag-role call');
                assert.ok(
                    tagCall.command.includes(`--role-name ${ROLE_NAME}`),
                    'tag-role command should include --role-name'
                );
                assert.ok(
                    tagCall.command.includes('--tags'),
                    'tag-role command should include --tags'
                );
                assert.ok(
                    tagCall.command.includes('mlcc:managed-by'),
                    'tag-role command should include mlcc:managed-by tag'
                );
                assert.ok(
                    tagCall.command.includes('mlcc:created-by'),
                    'tag-role command should include mlcc:created-by tag'
                );
                assert.ok(
                    tagCall.command.includes('mlcc:version'),
                    'tag-role command should include mlcc:version tag'
                );
                assert.strictEqual(
                    tagCall.profile,
                    'test-profile',
                    'tag-role should use the current profile'
                );
            } finally {
                restore();
            }
        });
    });

    describe('when role creation fails with AccessDenied', () => {
        it('should prompt user for existing role ARN', async () => {
            const { handler, logs, restore } = setupHandler({
                roleExists: false,
                promptResponse: { roleArn: USER_PROVIDED_ARN },
                execAwsImpl: (command) => {
                    if (command.includes('iam create-role')) {
                        throw new Error('AccessDenied: User is not authorized to perform iam:CreateRole');
                    }
                    return {};
                }
            });

            try {
                const roleArn = await handler._setupIamRole({});

                assert.strictEqual(roleArn, USER_PROVIDED_ARN, 'should return the user-provided role ARN');

                // Should display permission denied message
                assert.ok(
                    logs.some(l => l.includes('Permission denied') || l.includes('permission denied')),
                    'should display permission denied message'
                );
            } finally {
                restore();
            }
        });
    });

    describe('when role creation fails with other error', () => {
        it('should throw the error', async () => {
            const { handler, restore } = setupHandler({
                roleExists: false,
                execAwsImpl: (command) => {
                    if (command.includes('iam create-role')) {
                        throw new Error('InternalServiceError: Something went wrong');
                    }
                    return {};
                }
            });

            try {
                await assert.rejects(
                    () => handler._setupIamRole({}),
                    /InternalServiceError/,
                    'should throw the original error for non-permission errors'
                );
            } finally {
                restore();
            }
        });
    });
});

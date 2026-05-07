// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap S3 Bucket Setup Unit Tests
 *
 * Tests the _setupS3Buckets() and _createS3Bucket() methods of BootstrapCommandHandler:
 * - Skipping bucket creation when user declines
 * - Bucket creation with correct naming pattern
 * - Bucket reuse when buckets already exist
 * - Versioning enabled on created buckets
 * - AES256 server-side encryption on created buckets
 * - Resource tags applied to created buckets
 * - LocationConstraint for non-us-east-1 regions
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import BootstrapCommandHandler from '../../src/lib/bootstrap-command-handler.js';

const REGION = 'us-east-1';
const ACCOUNT_ID = '123456789012';
const ASYNC_BUCKET = `ml-container-creator-async-${REGION}-${ACCOUNT_ID}`;
const BATCH_BUCKET = `ml-container-creator-batch-${REGION}-${ACCOUNT_ID}`;

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
 * @param {boolean} opts.useS3 - Whether the user accepts S3 bucket creation
 * @param {boolean} opts.asyncBucketExists - Whether the async bucket already exists
 * @param {boolean} opts.batchBucketExists - Whether the batch bucket already exists
 * @param {string} [opts.region] - AWS region (default: us-east-1)
 * @param {string} [opts.accountId] - AWS account ID
 * @returns {{ handler, execAwsCalls, logs, restore }}
 */
function setupHandler({
    useS3 = true,
    asyncBucketExists = false,
    batchBucketExists = false,
    region = REGION,
    accountId = ACCOUNT_ID
} = {}) {
    const handler = new BootstrapCommandHandler({ promptFn: async () => ({ useS3 }) });
    handler._currentProfile = 'test-profile';
    handler._currentRegion = region;
    handler._currentAccountId = accountId;

    const execAwsCalls = [];
    const logs = [];

    // Capture console.log output
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    // Override _resourceExists to simulate bucket existence
    handler._resourceExists = (command) => {
        const asyncName = `ml-container-creator-async-${region}-${accountId}`;
        const batchName = `ml-container-creator-batch-${region}-${accountId}`;
        if (command.includes(asyncName)) return asyncBucketExists;
        if (command.includes(batchName)) return batchBucketExists;
        return false;
    };

    // Override _execAws to track calls
    handler._execAws = (command, profile) => {
        execAwsCalls.push({ command, profile });
        return {};
    };

    // Override _writeJsonTempFile to inline JSON so command strings contain expected text
    handler._writeJsonTempFile = (jsonObj, _prefix) => JSON.stringify(jsonObj);

    // Provide a restore function to reset console.log
    const restore = () => { console.log = origLog; };

    return { handler, execAwsCalls, logs, restore };
}

describe('Bootstrap S3 Bucket Setup', () => {
    describe('when user declines S3 buckets', () => {
        it('should return null and not create any buckets', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ useS3: false });

            try {
                const result = await handler._setupS3Buckets();

                assert.strictEqual(result, null, 'should return null when user declines');

                // Should NOT have called any s3api commands
                const s3Calls = execAwsCalls.filter(c => c.command.includes('s3api'));
                assert.strictEqual(s3Calls.length, 0, 'should not call any s3api commands');
            } finally {
                restore();
            }
        });
    });

    describe('when user accepts and buckets do not exist', () => {
        it('should create both buckets with correct names', async () => {
            const { handler, execAwsCalls, logs, restore } = setupHandler({ useS3: true });

            try {
                const result = await handler._setupS3Buckets();

                assert.ok(result, 'should return a result object');
                assert.strictEqual(result.asyncS3Bucket, ASYNC_BUCKET, 'should return correct async bucket name');
                assert.strictEqual(result.batchS3Bucket, BATCH_BUCKET, 'should return correct batch bucket name');

                // Should have called s3api create-bucket for both buckets
                const createCalls = execAwsCalls.filter(c => c.command.includes('s3api create-bucket'));
                assert.strictEqual(createCalls.length, 2, 'should call s3api create-bucket twice');

                const asyncCreate = createCalls.find(c => c.command.includes(ASYNC_BUCKET));
                assert.ok(asyncCreate, 'should create async bucket');

                const batchCreate = createCalls.find(c => c.command.includes(BATCH_BUCKET));
                assert.ok(batchCreate, 'should create batch bucket');

                // Should display "created" messages
                assert.ok(logs.some(l => l.includes('created') && l.includes(ASYNC_BUCKET)), 'should display "created" for async bucket');
                assert.ok(logs.some(l => l.includes('created') && l.includes(BATCH_BUCKET)), 'should display "created" for batch bucket');
            } finally {
                restore();
            }
        });
    });

    describe('when user accepts and buckets already exist', () => {
        it('should display "reused" messages and not create buckets', async () => {
            const { handler, execAwsCalls, logs, restore } = setupHandler({
                useS3: true,
                asyncBucketExists: true,
                batchBucketExists: true
            });

            try {
                const result = await handler._setupS3Buckets();

                assert.ok(result, 'should return a result object');
                assert.strictEqual(result.asyncS3Bucket, ASYNC_BUCKET, 'should return correct async bucket name');
                assert.strictEqual(result.batchS3Bucket, BATCH_BUCKET, 'should return correct batch bucket name');

                // Should NOT have called s3api create-bucket
                const createCalls = execAwsCalls.filter(c => c.command.includes('s3api create-bucket'));
                assert.strictEqual(createCalls.length, 0, 'should not call s3api create-bucket');

                // Should NOT have called versioning, encryption, or tagging
                const versioningCalls = execAwsCalls.filter(c => c.command.includes('put-bucket-versioning'));
                assert.strictEqual(versioningCalls.length, 0, 'should not call put-bucket-versioning');

                // Should display "reused" messages
                assert.ok(logs.some(l => l.includes('reused') && l.includes(ASYNC_BUCKET)), 'should display "reused" for async bucket');
                assert.ok(logs.some(l => l.includes('reused') && l.includes(BATCH_BUCKET)), 'should display "reused" for batch bucket');
            } finally {
                restore();
            }
        });
    });

    describe('versioning', () => {
        it('should create buckets with versioning enabled', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ useS3: true });

            try {
                await handler._setupS3Buckets();

                const versioningCalls = execAwsCalls.filter(c => c.command.includes('put-bucket-versioning'));
                assert.strictEqual(versioningCalls.length, 2, 'should call put-bucket-versioning for both buckets');

                for (const call of versioningCalls) {
                    assert.ok(
                        call.command.includes('Status=Enabled'),
                        'put-bucket-versioning command should include Status=Enabled'
                    );
                }

                // Verify one call is for async and one for batch
                assert.ok(
                    versioningCalls.some(c => c.command.includes(ASYNC_BUCKET)),
                    'should enable versioning on async bucket'
                );
                assert.ok(
                    versioningCalls.some(c => c.command.includes(BATCH_BUCKET)),
                    'should enable versioning on batch bucket'
                );
            } finally {
                restore();
            }
        });
    });

    describe('encryption', () => {
        it('should create buckets with AES256 encryption', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ useS3: true });

            try {
                await handler._setupS3Buckets();

                const encryptionCalls = execAwsCalls.filter(c => c.command.includes('put-bucket-encryption'));
                assert.strictEqual(encryptionCalls.length, 2, 'should call put-bucket-encryption for both buckets');

                for (const call of encryptionCalls) {
                    assert.ok(
                        call.command.includes('AES256'),
                        'put-bucket-encryption command should include AES256'
                    );
                }

                // Verify one call is for async and one for batch
                assert.ok(
                    encryptionCalls.some(c => c.command.includes(ASYNC_BUCKET)),
                    'should enable encryption on async bucket'
                );
                assert.ok(
                    encryptionCalls.some(c => c.command.includes(BATCH_BUCKET)),
                    'should enable encryption on batch bucket'
                );
            } finally {
                restore();
            }
        });
    });

    describe('resource tags', () => {
        it('should apply resource tags to created buckets', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({ useS3: true });

            try {
                await handler._setupS3Buckets();

                const taggingCalls = execAwsCalls.filter(c => c.command.includes('put-bucket-tagging'));
                assert.strictEqual(taggingCalls.length, 2, 'should call put-bucket-tagging for both buckets');

                for (const call of taggingCalls) {
                    assert.ok(
                        call.command.includes('mlcc:managed-by'),
                        'tagging command should include mlcc:managed-by tag'
                    );
                    assert.ok(
                        call.command.includes('mlcc:created-by'),
                        'tagging command should include mlcc:created-by tag'
                    );
                    assert.ok(
                        call.command.includes('mlcc:version'),
                        'tagging command should include mlcc:version tag'
                    );
                }

                // Verify one call is for async and one for batch
                assert.ok(
                    taggingCalls.some(c => c.command.includes(ASYNC_BUCKET)),
                    'should apply tags to async bucket'
                );
                assert.ok(
                    taggingCalls.some(c => c.command.includes(BATCH_BUCKET)),
                    'should apply tags to batch bucket'
                );
            } finally {
                restore();
            }
        });
    });

    describe('bucket naming pattern', () => {
        it('should follow pattern: ml-container-creator-{type}-{region}-{accountId}', async () => {
            const customRegion = 'eu-west-1';
            const customAccount = '987654321098';
            const { handler, execAwsCalls, restore } = setupHandler({
                useS3: true,
                region: customRegion,
                accountId: customAccount
            });

            try {
                const result = await handler._setupS3Buckets();

                const expectedAsync = `ml-container-creator-async-${customRegion}-${customAccount}`;
                const expectedBatch = `ml-container-creator-batch-${customRegion}-${customAccount}`;

                assert.strictEqual(result.asyncS3Bucket, expectedAsync, 'async bucket name should follow naming pattern');
                assert.strictEqual(result.batchS3Bucket, expectedBatch, 'batch bucket name should follow naming pattern');

                // Verify create-bucket commands use correct names
                const createCalls = execAwsCalls.filter(c => c.command.includes('s3api create-bucket'));
                assert.ok(
                    createCalls.some(c => c.command.includes(expectedAsync)),
                    'create-bucket command should use correct async bucket name'
                );
                assert.ok(
                    createCalls.some(c => c.command.includes(expectedBatch)),
                    'create-bucket command should use correct batch bucket name'
                );
            } finally {
                restore();
            }
        });
    });

    describe('LocationConstraint for non-us-east-1 regions', () => {
        it('should include LocationConstraint for non-us-east-1 regions', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({
                useS3: true,
                region: 'eu-west-1'
            });

            try {
                await handler._setupS3Buckets();

                const createCalls = execAwsCalls.filter(c => c.command.includes('s3api create-bucket'));
                assert.strictEqual(createCalls.length, 2, 'should call s3api create-bucket twice');

                for (const call of createCalls) {
                    assert.ok(
                        call.command.includes('LocationConstraint=eu-west-1'),
                        'create-bucket command should include LocationConstraint for non-us-east-1 region'
                    );
                }
            } finally {
                restore();
            }
        });

        it('should NOT include LocationConstraint for us-east-1', async () => {
            const { handler, execAwsCalls, restore } = setupHandler({
                useS3: true,
                region: 'us-east-1'
            });

            try {
                await handler._setupS3Buckets();

                const createCalls = execAwsCalls.filter(c => c.command.includes('s3api create-bucket'));
                assert.strictEqual(createCalls.length, 2, 'should call s3api create-bucket twice');

                for (const call of createCalls) {
                    assert.ok(
                        !call.command.includes('LocationConstraint'),
                        'create-bucket command should NOT include LocationConstraint for us-east-1'
                    );
                }
            } finally {
                restore();
            }
        });
    });
});

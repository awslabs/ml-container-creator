// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ARN Detection Unit Tests
 *
 * Tests the isSecretsManagerArn function for correct identification
 * of Secrets Manager ARNs vs plaintext values, including edge cases.
 *
 * Requirements: 8.4, 8.5, 8.6
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { isSecretsManagerArn } from '../../src/lib/arn-detection.js';

describe('arn-detection module', () => {

    describe('isSecretsManagerArn — valid ARNs', () => {
        it('returns true for a full Secrets Manager ARN', () => {
            const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mlcc/hf-token/prod-AbCdEf';
            assert.strictEqual(isSecretsManagerArn(arn), true);
        });

        it('returns true for a minimal ARN with just the prefix', () => {
            const arn = 'arn:aws:secretsmanager:';
            assert.strictEqual(isSecretsManagerArn(arn), true);
        });

        it('returns true for an ARN in a different region', () => {
            const arn = 'arn:aws:secretsmanager:eu-west-1:987654321098:secret:mlcc/ngc-token/ci-XyZaBc';
            assert.strictEqual(isSecretsManagerArn(arn), true);
        });

        it('returns true for an ARN with special characters in the secret name', () => {
            const arn = 'arn:aws:secretsmanager:us-west-2:111222333444:secret:mlcc/hf-token/my-key-123';
            assert.strictEqual(isSecretsManagerArn(arn), true);
        });
    });

    describe('isSecretsManagerArn — non-ARN strings', () => {
        it('returns false for a plaintext token value', () => {
            assert.strictEqual(isSecretsManagerArn('hf_abcdef123456'), false);
        });

        it('returns false for an empty string', () => {
            assert.strictEqual(isSecretsManagerArn(''), false);
        });

        it('returns false for a partial ARN prefix', () => {
            assert.strictEqual(isSecretsManagerArn('arn:aws:secretsmanager'), false);
        });

        it('returns false for a different AWS service ARN', () => {
            const s3Arn = 'arn:aws:s3:::my-bucket/my-key';
            assert.strictEqual(isSecretsManagerArn(s3Arn), false);
        });

        it('returns false for an IAM ARN', () => {
            const iamArn = 'arn:aws:iam::123456789012:role/my-role';
            assert.strictEqual(isSecretsManagerArn(iamArn), false);
        });

        it('returns false for a string that contains the prefix but does not start with it', () => {
            assert.strictEqual(isSecretsManagerArn('prefix-arn:aws:secretsmanager:us-east-1:123:secret:x'), false);
        });
    });

    describe('isSecretsManagerArn — non-string inputs', () => {
        it('returns false for null', () => {
            assert.strictEqual(isSecretsManagerArn(null), false);
        });

        it('returns false for undefined', () => {
            assert.strictEqual(isSecretsManagerArn(undefined), false);
        });

        it('returns false for a number', () => {
            assert.strictEqual(isSecretsManagerArn(12345), false);
        });

        it('returns false for a boolean', () => {
            assert.strictEqual(isSecretsManagerArn(true), false);
        });

        it('returns false for an object', () => {
            assert.strictEqual(isSecretsManagerArn({ arn: 'arn:aws:secretsmanager:us-east-1:123:secret:x' }), false);
        });

        it('returns false for an array', () => {
            assert.strictEqual(isSecretsManagerArn(['arn:aws:secretsmanager:us-east-1:123:secret:x']), false);
        });
    });
});

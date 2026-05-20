// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Picker MCP Server Unit Tests
 *
 * Tests:
 * - Response formatting and field completeness
 * - Empty subscription handling
 * - Credential fallback behavior
 *
 * Feature: marketplace-model-packages
 * Validates: Requirements 6.2, 6.4
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { buildResponse } from '../../servers/marketplace-picker/index.js';

describe('Marketplace Picker MCP Server', () => {

    // ── buildResponse formatting ─────────────────────────────────────────

    describe('buildResponse — response formatting', () => {

        it('returns all required fields for each subscription', () => {
            const subscriptions = [
                {
                    arn: 'arn:aws:sagemaker:us-west-2:aws:model-package/ai21-j2-ultra/1',
                    modelName: 'ai21-j2-ultra',
                    vendor: 'AI21',
                    supportedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge'],
                    supportedContentTypes: ['application/json'],
                    status: 'Active'
                }
            ];

            const result = buildResponse(subscriptions);

            assert.strictEqual(result.subscriptions.length, 1);
            const sub = result.subscriptions[0];
            assert.ok(sub.arn, 'Should have arn');
            assert.ok(sub.modelName, 'Should have modelName');
            assert.ok(sub.vendor, 'Should have vendor');
            assert.ok(Array.isArray(sub.supportedInstanceTypes), 'Should have supportedInstanceTypes array');
            assert.ok(Array.isArray(sub.supportedContentTypes), 'Should have supportedContentTypes array');
            assert.ok(sub.status, 'Should have status');
        });

        it('returns correct message with subscription count', () => {
            const subscriptions = [
                {
                    arn: 'arn:aws:sagemaker:us-west-2:aws:model-package/model-a/1',
                    modelName: 'model-a',
                    vendor: 'VendorA',
                    supportedInstanceTypes: ['ml.g5.xlarge'],
                    supportedContentTypes: ['application/json'],
                    status: 'Active'
                },
                {
                    arn: 'arn:aws:sagemaker:us-west-2:aws:model-package/model-b/2',
                    modelName: 'model-b',
                    vendor: 'VendorB',
                    supportedInstanceTypes: ['ml.p3.2xlarge'],
                    supportedContentTypes: ['text/csv'],
                    status: 'Active'
                }
            ];

            const result = buildResponse(subscriptions);

            assert.strictEqual(result.subscriptions.length, 2);
            assert.ok(result.message.includes('2'), 'Message should mention count');
        });

        it('preserves all subscription data without modification', () => {
            const subscriptions = [
                {
                    arn: 'arn:aws:sagemaker:eu-west-1:123456789012:model-package/cohere-command/3',
                    modelName: 'cohere-command',
                    vendor: 'Cohere',
                    supportedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p3.2xlarge'],
                    supportedContentTypes: ['application/json', 'text/plain'],
                    status: 'Active'
                }
            ];

            const result = buildResponse(subscriptions);
            const sub = result.subscriptions[0];

            assert.strictEqual(sub.arn, 'arn:aws:sagemaker:eu-west-1:123456789012:model-package/cohere-command/3');
            assert.strictEqual(sub.modelName, 'cohere-command');
            assert.strictEqual(sub.vendor, 'Cohere');
            assert.deepStrictEqual(sub.supportedInstanceTypes, ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p3.2xlarge']);
            assert.deepStrictEqual(sub.supportedContentTypes, ['application/json', 'text/plain']);
            assert.strictEqual(sub.status, 'Active');
        });
    });

    // ── Empty subscription handling ──────────────────────────────────────

    describe('buildResponse — empty subscription handling', () => {

        it('returns empty array with descriptive message when no subscriptions', () => {
            const result = buildResponse([]);

            assert.deepStrictEqual(result.subscriptions, []);
            assert.ok(typeof result.message === 'string');
            assert.ok(result.message.length > 0, 'Should have a descriptive message');
            assert.ok(result.message.includes('No active'), 'Message should indicate no subscriptions found');
        });

        it('returns empty array with descriptive message for null input', () => {
            const result = buildResponse(null);

            assert.deepStrictEqual(result.subscriptions, []);
            assert.ok(result.message.includes('No active'));
        });

        it('returns empty array with descriptive message for undefined input', () => {
            const result = buildResponse(undefined);

            assert.deepStrictEqual(result.subscriptions, []);
            assert.ok(result.message.includes('No active'));
        });

        it('empty message includes marketplace URL for subscribing', () => {
            const result = buildResponse([]);

            assert.ok(result.message.includes('aws.amazon.com/marketplace'),
                'Should include marketplace URL');
        });
    });

    // ── Credential fallback behavior ─────────────────────────────────────

    describe('Credential fallback behavior', () => {

        it('_detectAwsProfiles returns array (may be empty)', async () => {
            const { _detectAwsProfiles } = await import('../../servers/marketplace-picker/index.js');
            const profiles = _detectAwsProfiles();
            assert.ok(Array.isArray(profiles), 'Should return an array');
        });

        it('_createClient creates a client without throwing', async () => {
            const { _ensureSdkLoaded, _createClient } = await import('../../servers/marketplace-picker/index.js');
            await _ensureSdkLoaded();
            const client = _createClient('us-east-1');
            assert.ok(client, 'Should create a client');
        });
    });
});

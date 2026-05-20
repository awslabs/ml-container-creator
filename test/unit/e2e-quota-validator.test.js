// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for E2E Quota Validator.
 *
 * Tests:
 * - parseInstanceType extracts instance types from args strings
 * - sumInstanceRequirements correctly sums per instance type
 * - validateQuotas returns correct results with mocked AWS client
 * - Warnings are emitted for insufficient quotas
 *
 * Validates: Requirements 3.3, 3.4
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { parseInstanceType, sumInstanceRequirements, validateQuotas } from '../../src/lib/e2e-quota-validator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function validEntry(overrides = {}) {
    return {
        id: 'rt-test-model',
        tier: 'ci',
        track: 'realtime',
        args: '--deployment-config=transformers-vllm --model-name=test/Model --instance-type=ml.g6e.xlarge --region=us-west-2',
        lifecycle: ['build', 'push', 'deploy', 'test', 'clean'],
        timeout: 1800,
        ...overrides
    };
}

function validCatalog(configs) {
    return { configs: configs || [validEntry()] };
}

function mockClient(quotaValue) {
    return {
        send: async () => ({
            Quota: { Value: quotaValue }
        })
    };
}

function mockClientError(message) {
    return {
        send: async () => {
            throw new Error(message);
        }
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('E2E Quota Validator', () => {
    describe('parseInstanceType', () => {
        it('extracts instance type from --instance-type=value format', () => {
            const args = '--deployment-config=transformers-vllm --instance-type=ml.g6e.xlarge --region=us-west-2';
            assert.strictEqual(parseInstanceType(args), 'ml.g6e.xlarge');
        });

        it('extracts instance type from --instance-type value format', () => {
            const args = '--deployment-config=transformers-vllm --instance-type ml.g5.2xlarge --region=us-west-2';
            assert.strictEqual(parseInstanceType(args), 'ml.g5.2xlarge');
        });

        it('returns null when no instance type is present', () => {
            const args = '--deployment-config=transformers-vllm --model-name=test/Model';
            assert.strictEqual(parseInstanceType(args), null);
        });

        it('returns null for empty string', () => {
            assert.strictEqual(parseInstanceType(''), null);
        });

        it('returns null for null input', () => {
            assert.strictEqual(parseInstanceType(null), null);
        });

        it('returns null for undefined input', () => {
            assert.strictEqual(parseInstanceType(undefined), null);
        });

        it('handles instance type at end of args string', () => {
            const args = '--model-name=test/Model --instance-type=ml.p5.48xlarge';
            assert.strictEqual(parseInstanceType(args), 'ml.p5.48xlarge');
        });

        it('handles instance type at start of args string', () => {
            const args = '--instance-type=ml.m5.xlarge --model-name=test/Model';
            assert.strictEqual(parseInstanceType(args), 'ml.m5.xlarge');
        });
    });

    describe('sumInstanceRequirements', () => {
        it('sums instances for a single config', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = sumInstanceRequirements('ci', catalog);
            assert.strictEqual(result.get('ml.g6e.xlarge'), 1);
        });

        it('sums instances across multiple configs with same type', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', args: '--instance-type=ml.g6e.xlarge' }),
                validEntry({ id: 'b', args: '--instance-type=ml.g6e.xlarge' }),
                validEntry({ id: 'c', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = sumInstanceRequirements('ci', catalog);
            assert.strictEqual(result.get('ml.g6e.xlarge'), 3);
        });

        it('sums instances separately for different types', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', args: '--instance-type=ml.g6e.xlarge' }),
                validEntry({ id: 'b', args: '--instance-type=ml.g5.xlarge' }),
                validEntry({ id: 'c', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = sumInstanceRequirements('ci', catalog);
            assert.strictEqual(result.get('ml.g6e.xlarge'), 2);
            assert.strictEqual(result.get('ml.g5.xlarge'), 1);
        });

        it('only counts configs matching the specified tier', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', tier: 'ci', args: '--instance-type=ml.g6e.xlarge' }),
                validEntry({ id: 'b', tier: 'nightly', args: '--instance-type=ml.g6e.xlarge' }),
                validEntry({ id: 'c', tier: 'ci', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = sumInstanceRequirements('ci', catalog);
            assert.strictEqual(result.get('ml.g6e.xlarge'), 2);
        });

        it('returns empty map when no configs match tier', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', tier: 'nightly', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = sumInstanceRequirements('ci', catalog);
            assert.strictEqual(result.size, 0);
        });

        it('skips configs without instance type in args', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', args: '--model-name=test/Model' }),
                validEntry({ id: 'b', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = sumInstanceRequirements('ci', catalog);
            assert.strictEqual(result.get('ml.g6e.xlarge'), 1);
            assert.strictEqual(result.size, 1);
        });
    });

    describe('validateQuotas', () => {
        it('returns empty array when no configs match tier', async () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', tier: 'nightly' })
            ]);
            const result = await validateQuotas('ci', catalog, 'us-west-2', { client: mockClient(10) });
            assert.deepStrictEqual(result, []);
        });

        it('returns sufficient=true when quota exceeds requirement', async () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = await validateQuotas('ci', catalog, 'us-west-2', { client: mockClient(10) });
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].instanceType, 'ml.g6e.xlarge');
            assert.strictEqual(result[0].required, 1);
            assert.strictEqual(result[0].available, 10);
            assert.strictEqual(result[0].sufficient, true);
        });

        it('returns sufficient=true when quota equals requirement', async () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = await validateQuotas('ci', catalog, 'us-west-2', { client: mockClient(1) });
            assert.strictEqual(result[0].sufficient, true);
        });

        it('returns sufficient=false when quota is less than requirement', async () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', args: '--instance-type=ml.g6e.xlarge' }),
                validEntry({ id: 'b', args: '--instance-type=ml.g6e.xlarge' }),
                validEntry({ id: 'c', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = await validateQuotas('ci', catalog, 'us-west-2', { client: mockClient(2) });
            assert.strictEqual(result[0].required, 3);
            assert.strictEqual(result[0].available, 2);
            assert.strictEqual(result[0].sufficient, false);
        });

        it('handles API errors gracefully with available=0', async () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', args: '--instance-type=ml.g6e.xlarge' })
            ]);
            const result = await validateQuotas('ci', catalog, 'us-west-2', {
                client: mockClientError('Access denied')
            });
            assert.strictEqual(result[0].available, 0);
            assert.strictEqual(result[0].sufficient, false);
        });

        it('returns results for multiple instance types', async () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', tier: 'ci', args: '--instance-type=ml.g6e.xlarge' }),
                validEntry({ id: 'b', tier: 'ci', args: '--instance-type=ml.g5.xlarge' })
            ]);
            const result = await validateQuotas('ci', catalog, 'us-west-2', { client: mockClient(5) });
            assert.strictEqual(result.length, 2);
            const types = result.map(r => r.instanceType);
            assert.ok(types.includes('ml.g6e.xlarge'));
            assert.ok(types.includes('ml.g5.xlarge'));
        });
    });
});

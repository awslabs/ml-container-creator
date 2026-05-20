// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for E2E Catalog Validator.
 *
 * Tests:
 * - Valid catalogs pass validation
 * - Missing required fields are caught
 * - Invalid enum values are caught
 * - Duplicate IDs are caught
 * - Tier filtering returns correct entries
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { validateCatalog, filterByTier } from '../../src/lib/e2e-catalog-validator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function validEntry(overrides = {}) {
    return {
        id: 'rt-test-model',
        tier: 'ci',
        track: 'realtime',
        args: '--deployment-config=transformers-vllm --model-name=test/Model --instance-type=ml.g6e.xlarge',
        lifecycle: ['build', 'push', 'deploy', 'test', 'clean'],
        timeout: 1800,
        ...overrides
    };
}

function validCatalog(configs) {
    return { configs: configs || [validEntry()] };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('E2E Catalog Validator', () => {
    describe('validateCatalog', () => {
        describe('valid catalogs', () => {
            it('accepts a valid catalog with one entry', () => {
                const result = validateCatalog(validCatalog());
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts a valid catalog with multiple entries', () => {
                const catalog = validCatalog([
                    validEntry({ id: 'rt-model-a' }),
                    validEntry({ id: 'rt-model-b', tier: 'nightly' }),
                    validEntry({ id: 'rt-model-c', tier: 'weekly', track: 'batch' })
                ]);
                const result = validateCatalog(catalog);
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts an empty configs array', () => {
                const result = validateCatalog({ configs: [] });
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts all valid tier values', () => {
                const catalog = validCatalog([
                    validEntry({ id: 'a', tier: 'ci' }),
                    validEntry({ id: 'b', tier: 'nightly' }),
                    validEntry({ id: 'c', tier: 'weekly' })
                ]);
                const result = validateCatalog(catalog);
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts all valid track values', () => {
                const catalog = validCatalog([
                    validEntry({ id: 'a', track: 'realtime' }),
                    validEntry({ id: 'b', track: 'hyperpod' }),
                    validEntry({ id: 'c', track: 'async' }),
                    validEntry({ id: 'd', track: 'batch' })
                ]);
                const result = validateCatalog(catalog);
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts timeout at minimum value of 60', () => {
                const result = validateCatalog(validCatalog([validEntry({ timeout: 60 })]));
                assert.deepStrictEqual(result, { valid: true });
            });
        });

        describe('missing required fields', () => {
            it('rejects catalog without configs property', () => {
                const result = validateCatalog({});
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.length > 0);
            });

            it('rejects entry missing id', () => {
                const entry = validEntry();
                delete entry.id;
                const result = validateCatalog(validCatalog([entry]));
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('id')));
            });

            it('rejects entry missing tier', () => {
                const entry = validEntry();
                delete entry.tier;
                const result = validateCatalog(validCatalog([entry]));
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('tier')));
            });

            it('rejects entry missing lifecycle', () => {
                const entry = validEntry();
                delete entry.lifecycle;
                const result = validateCatalog(validCatalog([entry]));
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('lifecycle')));
            });

            it('rejects entry missing timeout', () => {
                const entry = validEntry();
                delete entry.timeout;
                const result = validateCatalog(validCatalog([entry]));
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('timeout')));
            });
        });

        describe('invalid enum values', () => {
            it('rejects invalid tier value', () => {
                const result = validateCatalog(validCatalog([validEntry({ tier: 'hourly' })]));
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.length > 0);
            });

            it('rejects invalid track value', () => {
                const result = validateCatalog(validCatalog([validEntry({ track: 'streaming' })]));
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.length > 0);
            });
        });

        describe('id pattern validation', () => {
            it('rejects id with uppercase letters', () => {
                const result = validateCatalog(validCatalog([validEntry({ id: 'RT-Model' })]));
                assert.strictEqual(result.valid, false);
            });

            it('rejects id with spaces', () => {
                const result = validateCatalog(validCatalog([validEntry({ id: 'rt model' })]));
                assert.strictEqual(result.valid, false);
            });

            it('accepts id with lowercase, numbers, and hyphens', () => {
                const result = validateCatalog(validCatalog([validEntry({ id: 'rt-qwen3-4b-vllm-g6e' })]));
                assert.deepStrictEqual(result, { valid: true });
            });
        });

        describe('lifecycle validation', () => {
            it('rejects empty lifecycle array', () => {
                const result = validateCatalog(validCatalog([validEntry({ lifecycle: [] })]));
                assert.strictEqual(result.valid, false);
            });

            it('rejects lifecycle step with invalid pattern', () => {
                const result = validateCatalog(validCatalog([validEntry({ lifecycle: ['Build'] })]));
                assert.strictEqual(result.valid, false);
            });

            it('rejects lifecycle step starting with number', () => {
                const result = validateCatalog(validCatalog([validEntry({ lifecycle: ['1build'] })]));
                assert.strictEqual(result.valid, false);
            });

            it('accepts lifecycle steps with hyphens', () => {
                const result = validateCatalog(validCatalog([validEntry({ lifecycle: ['adapter-add', 'test-adapter'] })]));
                assert.deepStrictEqual(result, { valid: true });
            });
        });

        describe('timeout validation', () => {
            it('rejects timeout less than 60', () => {
                const result = validateCatalog(validCatalog([validEntry({ timeout: 30 })]));
                assert.strictEqual(result.valid, false);
            });

            it('rejects non-integer timeout', () => {
                const result = validateCatalog(validCatalog([validEntry({ timeout: 1800.5 })]));
                assert.strictEqual(result.valid, false);
            });
        });

        describe('unique ID enforcement', () => {
            it('rejects duplicate IDs', () => {
                const catalog = validCatalog([
                    validEntry({ id: 'rt-model-a' }),
                    validEntry({ id: 'rt-model-a' })
                ]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('duplicate')));
            });

            it('includes field path for duplicate ID error', () => {
                const catalog = validCatalog([
                    validEntry({ id: 'rt-model-a' }),
                    validEntry({ id: 'rt-model-a' })
                ]);
                const result = validateCatalog(catalog);
                assert.ok(result.errors.some((e) => e.path === '/configs/1/id'));
            });
        });

        describe('error structure', () => {
            it('returns errors with path and message fields', () => {
                const result = validateCatalog({});
                assert.strictEqual(result.valid, false);
                for (const err of result.errors) {
                    assert.ok('path' in err, 'error should have path');
                    assert.ok('message' in err, 'error should have message');
                }
            });
        });
    });

    describe('filterByTier', () => {
        it('returns only entries matching the specified tier', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', tier: 'ci' }),
                validEntry({ id: 'b', tier: 'nightly' }),
                validEntry({ id: 'c', tier: 'ci' })
            ]);
            const result = filterByTier(catalog, 'ci');
            assert.strictEqual(result.length, 2);
            assert.ok(result.every((c) => c.tier === 'ci'));
        });

        it('returns empty array when no entries match', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', tier: 'ci' })
            ]);
            const result = filterByTier(catalog, 'weekly');
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array for null catalog', () => {
            const result = filterByTier(null, 'ci');
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array for catalog without configs', () => {
            const result = filterByTier({}, 'ci');
            assert.deepStrictEqual(result, []);
        });

        it('returns all entries when all match the tier', () => {
            const catalog = validCatalog([
                validEntry({ id: 'a', tier: 'nightly' }),
                validEntry({ id: 'b', tier: 'nightly' })
            ]);
            const result = filterByTier(catalog, 'nightly');
            assert.strictEqual(result.length, 2);
        });
    });
});

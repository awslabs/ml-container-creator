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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, validateTuneConstraints, validateLifecycleOrdering, validateTuneCatalogReferences, filterByTier } from '../../src/lib/e2e-catalog-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_TUNE_CATALOG = path.resolve(__dirname, '../fixtures/tune-catalog-test.json');
const NONEXISTENT_TUNE_CATALOG = path.resolve(__dirname, '../fixtures/nonexistent-tune-catalog.json');

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

    describe('validateTuneConstraints', () => {
        function tuneEntry(overrides = {}) {
            return {
                id: 'rt-tune-model',
                tier: 'ci',
                track: 'realtime',
                args: '--deployment-config=transformers-vllm --model-name=test/Model --instance-type=ml.g5.xlarge --enable-lora',
                lifecycle: ['build', 'push', 'deploy', 'test', 'tune-sft', 'adapter-add', 'test-adapter', 'clean'],
                timeout: 1800,
                tuneTimeout: 3600,
                tuneConfig: {
                    tuneId: 'qwen3-4b',
                    technique: 'sft',
                    trainingType: 'lora',
                    dataset: 's3://mlcc-e2e-datasets/sft-small/train.jsonl'
                },
                ...overrides
            };
        }

        describe('valid tune entries', () => {
            it('accepts a valid entry with tune steps and tuneConfig', () => {
                const catalog = validCatalog([tuneEntry()]);
                const result = validateCatalog(catalog);
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts entry with tune steps and tuneTimeout at minimum 60', () => {
                const catalog = validCatalog([tuneEntry({ tuneTimeout: 60 })]);
                const result = validateCatalog(catalog);
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts entry without tune steps and without tuneConfig', () => {
                const catalog = validCatalog([validEntry()]);
                const result = validateCatalog(catalog);
                assert.deepStrictEqual(result, { valid: true });
            });
        });

        describe('missing tuneConfig', () => {
            it('rejects entry with tune steps but no tuneConfig', () => {
                const entry = tuneEntry();
                delete entry.tuneConfig;
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('tune lifecycle steps but no tuneConfig')));
            });

            it('includes entry id in error message for missing tuneConfig', () => {
                const entry = tuneEntry({ id: 'rt-missing-config' });
                delete entry.tuneConfig;
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.ok(result.errors.some((e) => e.message.includes('rt-missing-config')));
            });

            it('includes JSON path in error for missing tuneConfig', () => {
                const entry = tuneEntry();
                delete entry.tuneConfig;
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.ok(result.errors.some((e) => e.path === '/configs/0'));
            });
        });

        describe('missing --enable-lora in args', () => {
            it('rejects entry with tune steps but no --enable-lora in args', () => {
                const entry = tuneEntry({
                    args: '--deployment-config=transformers-vllm --model-name=test/Model --instance-type=ml.g5.xlarge'
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('args missing --enable-lora')));
            });

            it('includes JSON path for args error', () => {
                const entry = tuneEntry({
                    args: '--deployment-config=transformers-vllm --model-name=test/Model'
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.ok(result.errors.some((e) => e.path === '/configs/0/args'));
            });
        });

        describe('invalid technique/trainingType schema rejection', () => {
            it('rejects tuneConfig with invalid technique enum value', () => {
                const entry = tuneEntry({
                    tuneConfig: {
                        tuneId: 'qwen3-4b',
                        technique: 'ppo',
                        trainingType: 'lora',
                        dataset: 's3://mlcc-e2e-datasets/sft-small/train.jsonl'
                    }
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.path.includes('tuneConfig') && e.message.includes('must be equal to one of the allowed values')));
            });

            it('rejects tuneConfig with invalid trainingType enum value', () => {
                const entry = tuneEntry({
                    tuneConfig: {
                        tuneId: 'qwen3-4b',
                        technique: 'sft',
                        trainingType: 'quantized',
                        dataset: 's3://mlcc-e2e-datasets/sft-small/train.jsonl'
                    }
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.path.includes('tuneConfig') && e.message.includes('must be equal to one of the allowed values')));
            });

            it('accepts all valid technique enum values', () => {
                for (const technique of ['sft', 'dpo', 'rlaif', 'rlvr']) {
                    const entry = tuneEntry({
                        tuneConfig: {
                            tuneId: 'qwen3-4b',
                            technique,
                            trainingType: 'lora',
                            dataset: 's3://mlcc-e2e-datasets/sft-small/train.jsonl'
                        }
                    });
                    const catalog = validCatalog([entry]);
                    const result = validateCatalog(catalog, { tuneCatalogPath: NONEXISTENT_TUNE_CATALOG });
                    assert.deepStrictEqual(result, { valid: true }, `technique "${technique}" should be accepted`);
                }
            });

            it('accepts all valid trainingType enum values', () => {
                for (const trainingType of ['lora', 'full-rank']) {
                    const entry = tuneEntry({
                        tuneConfig: {
                            tuneId: 'qwen3-4b',
                            technique: 'sft',
                            trainingType,
                            dataset: 's3://mlcc-e2e-datasets/sft-small/train.jsonl'
                        }
                    });
                    const catalog = validCatalog([entry]);
                    const result = validateCatalog(catalog, { tuneCatalogPath: NONEXISTENT_TUNE_CATALOG });
                    assert.deepStrictEqual(result, { valid: true }, `trainingType "${trainingType}" should be accepted`);
                }
            });
        });

        describe('tuneTimeout validation', () => {
            it('rejects tuneTimeout less than 60', () => {
                const catalog = validCatalog([tuneEntry({ tuneTimeout: 30 })]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('tuneTimeout must be a positive integer >= 60')));
            });

            it('rejects non-integer tuneTimeout', () => {
                const catalog = validCatalog([tuneEntry({ tuneTimeout: 3600.5 })]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('tuneTimeout')));
            });

            it('rejects tuneTimeout of zero', () => {
                const catalog = validCatalog([tuneEntry({ tuneTimeout: 0 })]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
            });

            it('rejects negative tuneTimeout', () => {
                const catalog = validCatalog([tuneEntry({ tuneTimeout: -100 })]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
            });

            it('validates tuneTimeout even on entries without tune steps', () => {
                const entry = validEntry({ tuneTimeout: 30 });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('tuneTimeout')));
            });
        });

        describe('validateTuneConstraints standalone', () => {
            it('handles null catalog gracefully', () => {
                const errors = [];
                validateTuneConstraints(null, errors);
                assert.strictEqual(errors.length, 0);
            });

            it('handles catalog without configs array gracefully', () => {
                const errors = [];
                validateTuneConstraints({}, errors);
                assert.strictEqual(errors.length, 0);
            });

            it('skips entries without lifecycle array', () => {
                const errors = [];
                validateTuneConstraints({ configs: [{ id: 'test' }] }, errors);
                assert.strictEqual(errors.length, 0);
            });
        });
    });

    describe('validateLifecycleOrdering', () => {
        function tuneEntry(overrides = {}) {
            return {
                id: 'rt-tune-model',
                tier: 'ci',
                track: 'realtime',
                args: '--deployment-config=transformers-vllm --model-name=test/Model --instance-type=ml.g5.xlarge --enable-lora',
                lifecycle: ['build', 'push', 'deploy', 'test', 'tune-sft', 'adapter-add', 'test-adapter', 'clean'],
                timeout: 1800,
                tuneTimeout: 3600,
                tuneConfig: {
                    tuneId: 'qwen3-4b',
                    technique: 'sft',
                    trainingType: 'lora',
                    dataset: 's3://mlcc-e2e-datasets/sft-small/train.jsonl'
                },
                ...overrides
            };
        }

        describe('valid ordering', () => {
            it('accepts tune-group steps after test and before clean', () => {
                const catalog = validCatalog([tuneEntry()]);
                const result = validateCatalog(catalog);
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts entries without tune-group steps', () => {
                const catalog = validCatalog([validEntry()]);
                const result = validateCatalog(catalog);
                assert.deepStrictEqual(result, { valid: true });
            });

            it('accepts lifecycle without test or clean (no ordering constraint)', () => {
                const entry = tuneEntry({
                    lifecycle: ['build', 'push', 'deploy', 'tune-sft', 'adapter-add', 'test-adapter']
                });
                // Remove tuneConfig requirement check by not having tune steps trigger that path
                // Actually this entry has tune steps so it needs tuneConfig - it already has it
                const errors = [];
                validateLifecycleOrdering(validCatalog([entry]), errors);
                assert.strictEqual(errors.length, 0);
            });
        });

        describe('tune-group steps before test', () => {
            it('rejects tune-sft before test', () => {
                const entry = tuneEntry({
                    lifecycle: ['build', 'push', 'tune-sft', 'deploy', 'test', 'adapter-add', 'test-adapter', 'clean']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('"tune-sft" must come after "test"')));
            });

            it('rejects adapter-add before test', () => {
                const entry = tuneEntry({
                    lifecycle: ['build', 'adapter-add', 'push', 'deploy', 'test', 'tune-sft', 'test-adapter', 'clean']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('"adapter-add" must come after "test"')));
            });

            it('rejects test-adapter before test', () => {
                const entry = tuneEntry({
                    lifecycle: ['build', 'test-adapter', 'push', 'deploy', 'test', 'tune-sft', 'adapter-add', 'clean']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('"test-adapter" must come after "test"')));
            });
        });

        describe('tune-group steps after clean', () => {
            it('rejects tune-sft after clean', () => {
                const entry = tuneEntry({
                    lifecycle: ['build', 'push', 'deploy', 'test', 'clean', 'tune-sft', 'adapter-add', 'test-adapter']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('"tune-sft" must come before "clean"')));
            });

            it('rejects adapter-add after clean', () => {
                const entry = tuneEntry({
                    lifecycle: ['build', 'push', 'deploy', 'test', 'tune-sft', 'clean', 'adapter-add', 'test-adapter']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('"adapter-add" must come before "clean"')));
            });

            it('rejects test-adapter after clean', () => {
                const entry = tuneEntry({
                    lifecycle: ['build', 'push', 'deploy', 'test', 'tune-sft', 'adapter-add', 'clean', 'test-adapter']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('"test-adapter" must come before "clean"')));
            });
        });

        describe('error details', () => {
            it('includes entry id in error message', () => {
                const entry = tuneEntry({
                    id: 'rt-bad-order',
                    lifecycle: ['build', 'tune-sft', 'test', 'adapter-add', 'test-adapter', 'clean']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.ok(result.errors.some((e) => e.message.includes('rt-bad-order')));
            });

            it('includes JSON path for lifecycle ordering error', () => {
                const entry = tuneEntry({
                    lifecycle: ['build', 'tune-sft', 'test', 'adapter-add', 'test-adapter', 'clean']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.ok(result.errors.some((e) => e.path === '/configs/0/lifecycle'));
            });

            it('reports multiple ordering violations in the same entry', () => {
                const entry = tuneEntry({
                    lifecycle: ['tune-sft', 'adapter-add', 'test-adapter', 'build', 'test', 'clean']
                });
                const catalog = validCatalog([entry]);
                const result = validateCatalog(catalog);
                assert.strictEqual(result.valid, false);
                const lifecycleErrors = result.errors.filter((e) => e.path === '/configs/0/lifecycle');
                assert.ok(lifecycleErrors.length >= 3, `Expected at least 3 lifecycle errors, got ${lifecycleErrors.length}`);
            });
        });

        describe('validateLifecycleOrdering standalone', () => {
            it('handles null catalog gracefully', () => {
                const errors = [];
                validateLifecycleOrdering(null, errors);
                assert.strictEqual(errors.length, 0);
            });

            it('handles catalog without configs array gracefully', () => {
                const errors = [];
                validateLifecycleOrdering({}, errors);
                assert.strictEqual(errors.length, 0);
            });

            it('skips entries without lifecycle array', () => {
                const errors = [];
                validateLifecycleOrdering({ configs: [{ id: 'test' }] }, errors);
                assert.strictEqual(errors.length, 0);
            });

            it('skips entries with no tune-group steps', () => {
                const errors = [];
                validateLifecycleOrdering({ configs: [{ id: 'test', lifecycle: ['build', 'test', 'clean'] }] }, errors);
                assert.strictEqual(errors.length, 0);
            });
        });
    });

    describe('validateTuneCatalogReferences', () => {
        function tuneEntry(overrides = {}) {
            return {
                id: 'rt-tune-model',
                tier: 'ci',
                track: 'realtime',
                args: '--deployment-config=transformers-vllm --model-name=test/Model --instance-type=ml.g5.xlarge --enable-lora',
                lifecycle: ['build', 'push', 'deploy', 'test', 'tune-sft', 'adapter-add', 'test-adapter', 'clean'],
                timeout: 1800,
                tuneTimeout: 3600,
                tuneConfig: {
                    tuneId: 'qwen3-4b',
                    technique: 'sft',
                    trainingType: 'lora',
                    dataset: 's3://mlcc-e2e-datasets/sft-small/train.jsonl'
                },
                ...overrides
            };
        }

        describe('soft validation — skips if tune-catalog is unreadable', () => {
            it('returns empty errors when tune-catalog path does not exist', () => {
                const catalog = { configs: [tuneEntry()] };
                const errors = validateTuneCatalogReferences(catalog, NONEXISTENT_TUNE_CATALOG);
                assert.deepStrictEqual(errors, []);
            });

            it('returns empty errors when tune-catalog path is invalid', () => {
                const catalog = { configs: [tuneEntry()] };
                const errors = validateTuneCatalogReferences(catalog, '/invalid/path/tune-catalog.json');
                assert.deepStrictEqual(errors, []);
            });

            it('returns empty errors for null catalog', () => {
                const errors = validateTuneCatalogReferences(null, FIXTURE_TUNE_CATALOG);
                assert.deepStrictEqual(errors, []);
            });

            it('returns empty errors for catalog without configs array', () => {
                const errors = validateTuneCatalogReferences({}, FIXTURE_TUNE_CATALOG);
                assert.deepStrictEqual(errors, []);
            });
        });

        describe('tuneId validation', () => {
            it('accepts entry with valid tuneId that exists in tune-catalog', () => {
                const catalog = { configs: [tuneEntry({ tuneConfig: { tuneId: 'qwen3-4b', technique: 'sft', trainingType: 'lora', dataset: 's3://test' } })] };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.deepStrictEqual(errors, []);
            });

            it('rejects entry with tuneId not found in tune-catalog', () => {
                const catalog = { configs: [tuneEntry({ tuneConfig: { tuneId: 'nonexistent-model', technique: 'sft', trainingType: 'lora', dataset: 's3://test' } })] };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].message.includes('not found in tune-catalog'));
                assert.ok(errors[0].message.includes('nonexistent-model'));
                assert.strictEqual(errors[0].path, '/configs/0/tuneConfig/tuneId');
            });

            it('includes entry id in error message for invalid tuneId', () => {
                const catalog = { configs: [tuneEntry({ id: 'rt-bad-ref', tuneConfig: { tuneId: 'missing-model', technique: 'sft', trainingType: 'lora', dataset: 's3://test' } })] };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.ok(errors[0].message.includes('rt-bad-ref'));
            });
        });

        describe('technique validation', () => {
            it('accepts entry with technique supported by the model', () => {
                const catalog = { configs: [tuneEntry({ tuneConfig: { tuneId: 'qwen3-4b', technique: 'dpo', trainingType: 'lora', dataset: 's3://test' } })] };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.deepStrictEqual(errors, []);
            });

            it('rejects entry with technique not supported by the model', () => {
                const catalog = { configs: [tuneEntry({ tuneConfig: { tuneId: 'qwen3-4b', technique: 'rlvr', trainingType: 'lora', dataset: 's3://test' } })] };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].message.includes('technique "rlvr" not supported'));
                assert.ok(errors[0].message.includes('qwen3-4b'));
                assert.strictEqual(errors[0].path, '/configs/0/tuneConfig/technique');
            });
        });

        describe('trainingType validation', () => {
            it('accepts entry with trainingType supported for the model/technique', () => {
                const catalog = { configs: [tuneEntry({ tuneConfig: { tuneId: 'qwen2-5-14b-instruct', technique: 'sft', trainingType: 'full-rank', dataset: 's3://test' } })] };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.deepStrictEqual(errors, []);
            });

            it('rejects entry with trainingType not supported for the model/technique', () => {
                const catalog = { configs: [tuneEntry({ tuneConfig: { tuneId: 'qwen3-4b', technique: 'sft', trainingType: 'full-rank', dataset: 's3://test' } })] };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].message.includes('trainingType "full-rank" not supported'));
                assert.ok(errors[0].message.includes('qwen3-4b/sft'));
                assert.strictEqual(errors[0].path, '/configs/0/tuneConfig/trainingType');
            });
        });

        describe('entries without tuneConfig are skipped', () => {
            it('skips entries without tuneConfig', () => {
                const catalog = { configs: [{ id: 'rt-no-tune', tier: 'ci', track: 'realtime', args: '--test', lifecycle: ['build', 'test', 'clean'], timeout: 1800 }] };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.deepStrictEqual(errors, []);
            });
        });

        describe('multiple entries', () => {
            it('validates all entries with tuneConfig and reports errors for each', () => {
                const catalog = {
                    configs: [
                        tuneEntry({ id: 'rt-good', tuneConfig: { tuneId: 'qwen3-4b', technique: 'sft', trainingType: 'lora', dataset: 's3://test' } }),
                        tuneEntry({ id: 'rt-bad-id', tuneConfig: { tuneId: 'nonexistent', technique: 'sft', trainingType: 'lora', dataset: 's3://test' } }),
                        tuneEntry({ id: 'rt-bad-technique', tuneConfig: { tuneId: 'qwen3-4b', technique: 'rlvr', trainingType: 'lora', dataset: 's3://test' } })
                    ]
                };
                const errors = validateTuneCatalogReferences(catalog, FIXTURE_TUNE_CATALOG);
                assert.strictEqual(errors.length, 2);
                assert.ok(errors[0].path.includes('/configs/1/'));
                assert.ok(errors[1].path.includes('/configs/2/'));
            });
        });

        describe('integration with validateCatalog', () => {
            it('validateCatalog uses custom tuneCatalogPath option', () => {
                const catalog = {
                    configs: [tuneEntry({ tuneConfig: { tuneId: 'nonexistent-model', technique: 'sft', trainingType: 'lora', dataset: 's3://test' } })]
                };
                const result = validateCatalog(catalog, { tuneCatalogPath: FIXTURE_TUNE_CATALOG });
                assert.strictEqual(result.valid, false);
                assert.ok(result.errors.some((e) => e.message.includes('not found in tune-catalog')));
            });

            it('validateCatalog silently skips cross-reference when tune-catalog is unreadable', () => {
                const catalog = {
                    configs: [tuneEntry()]
                };
                const result = validateCatalog(catalog, { tuneCatalogPath: NONEXISTENT_TUNE_CATALOG });
                assert.deepStrictEqual(result, { valid: true });
            });
        });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for TP degree auto-resolution at prove-time.
 * Requirements: FTP-1 (extension) — task 6.5
 *
 * When tp_degree is not explicitly set in the prove target config,
 * resolveProveTpDegree looks up the instance catalog's GPU count and
 * uses it as tp_degree. This mirrors the generation-time logic from
 * template-variable-resolver.js (task 6.2) but at prove-time.
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { resolveProveTpDegree } from '../../src/lib/path-prover-brain.js';

// Mock catalog data for testing (avoids filesystem dependency)
const MOCK_CATALOG = {
    catalog: {
        'ml.g5.xlarge': { gpus: 1, family: 'g5' },
        'ml.g5.2xlarge': { gpus: 1, family: 'g5' },
        'ml.g5.12xlarge': { gpus: 4, family: 'g5' },
        'ml.g5.48xlarge': { gpus: 8, family: 'g5' },
        'ml.p6-b200.48xlarge': { gpus: 8, family: 'p6' }
    }
};

describe('Feature: ftp-benchmark-support — Prove-Time TP Degree Auto-Resolution (Task 6.5)', () => {

    describe('resolves tp_degree from instance catalog GPU count', () => {
        it('sets tp_degree to 8 for ml.g5.48xlarge (8 GPUs)', () => {
            const config = {
                instance_type: 'ml.g5.48xlarge',
                deployment_config: 'transformers-vllm',
                model_name: 'test/model'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, 8);
            assert.strictEqual(config._tpAutoResolved, true);
            assert.strictEqual(config._tpAutoResolvedFrom, 'ml.g5.48xlarge');
        });

        it('sets tp_degree to 4 for ml.g5.12xlarge (4 GPUs)', () => {
            const config = {
                instance_type: 'ml.g5.12xlarge',
                deployment_config: 'transformers-vllm'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, 4);
            assert.strictEqual(config._tpAutoResolved, true);
        });

        it('sets tp_degree to 8 for ml.p6-b200.48xlarge (8 GPUs)', () => {
            const config = {
                instance_type: 'ml.p6-b200.48xlarge',
                deployment_config: 'transformers-vllm'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, 8);
            assert.strictEqual(config._tpAutoResolved, true);
            assert.strictEqual(config._tpAutoResolvedFrom, 'ml.p6-b200.48xlarge');
        });

        it('sets tp_degree to 1 for ml.g5.xlarge (1 GPU)', () => {
            const config = {
                instance_type: 'ml.g5.xlarge',
                deployment_config: 'transformers-vllm'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, 1);
            assert.strictEqual(config._tpAutoResolved, true);
        });
    });

    describe('respects explicit tp_degree (does NOT override)', () => {
        it('does NOT override when tp_degree is set to 4', () => {
            const config = {
                instance_type: 'ml.g5.48xlarge',
                tp_degree: 4,
                deployment_config: 'transformers-vllm'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, 4);
            assert.strictEqual(config._tpAutoResolved, undefined);
        });

        it('does NOT override when tp_degree is set to 1', () => {
            const config = {
                instance_type: 'ml.g5.48xlarge',
                tp_degree: 1,
                deployment_config: 'transformers-vllm'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, 1);
            assert.strictEqual(config._tpAutoResolved, undefined);
        });

        it('does NOT override when tp_degree is a string "8"', () => {
            const config = {
                instance_type: 'ml.g5.48xlarge',
                tp_degree: '8',
                deployment_config: 'transformers-vllm'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, '8');
            assert.strictEqual(config._tpAutoResolved, undefined);
        });
    });

    describe('edge cases', () => {
        it('returns config unchanged when config is null', () => {
            const result = resolveProveTpDegree(null, MOCK_CATALOG);
            assert.strictEqual(result, null);
        });

        it('returns config unchanged when instance_type is missing', () => {
            const config = {
                deployment_config: 'transformers-vllm',
                model_name: 'test/model'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, undefined);
            assert.strictEqual(config._tpAutoResolved, undefined);
        });

        it('returns config unchanged when instance_type is not in catalog', () => {
            const config = {
                instance_type: 'ml.x99.superlarge',
                deployment_config: 'transformers-vllm'
            };
            resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(config.tp_degree, undefined);
            assert.strictEqual(config._tpAutoResolved, undefined);
        });

        it('returns config unchanged when catalog is null and file not found', () => {
            const config = {
                instance_type: 'ml.g5.48xlarge',
                deployment_config: 'transformers-vllm'
            };
            // Pass an empty catalog (simulates file not found)
            resolveProveTpDegree(config, { catalog: {} });
            assert.strictEqual(config.tp_degree, undefined);
            assert.strictEqual(config._tpAutoResolved, undefined);
        });

        it('mutates config in place and returns same reference', () => {
            const config = {
                instance_type: 'ml.g5.48xlarge',
                deployment_config: 'transformers-vllm'
            };
            const returned = resolveProveTpDegree(config, MOCK_CATALOG);
            assert.strictEqual(returned, config);
        });
    });

    describe('loads real instance catalog when no override provided', () => {
        it('resolves TP from real catalog for ml.g5.48xlarge', () => {
            const config = {
                instance_type: 'ml.g5.48xlarge',
                deployment_config: 'transformers-vllm'
            };
            // No catalog override — loads from filesystem
            resolveProveTpDegree(config);
            assert.strictEqual(config.tp_degree, 8);
            assert.strictEqual(config._tpAutoResolved, true);
        });

        it('resolves TP from real catalog for ml.g5.48xlarge', () => {
            const config = {
                instance_type: 'ml.g5.48xlarge',
                deployment_config: 'transformers-vllm'
            };
            resolveProveTpDegree(config);
            assert.strictEqual(config.tp_degree, 8);
            assert.strictEqual(config._tpAutoResolved, true);
        });
    });
});

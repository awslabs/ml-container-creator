// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for tuneModelId resolution in template-variable-resolver.js.
 *
 * Tests:
 * - Match case: HuggingFace ID maps to catalog key (Hub content name)
 * - No-match case: HuggingFace ID not in catalog sets tuneModelId to null
 * - Non-transformers case: tuneSupported=false skips lookup, tuneModelId is null
 *
 * Validates: Requirements 1.1, 1.2, 6.2, 6.3
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { _ensureTemplateVariables } from '../../src/lib/template-variable-resolver.js';

describe('tuneModelId resolution in _ensureTemplateVariables', () => {
    describe('match case — HuggingFace ID maps to catalog key', () => {
        it('resolves tuneModelId to Hub content name for a known model', async () => {
            const answers = {
                modelName: 'Qwen/Qwen3-4B',
                framework: 'transformers'
            };

            await _ensureTemplateVariables(answers, null);

            assert.strictEqual(answers.tuneSupported, true);
            assert.strictEqual(answers.tuneModelId, 'huggingface-reasoning-qwen3-4b');
        });

        it('resolves tuneModelId for a Qwen 2.5 model', async () => {
            const answers = {
                modelName: 'Qwen/Qwen2.5-7B-Instruct',
                framework: 'transformers'
            };

            await _ensureTemplateVariables(answers, null);

            assert.strictEqual(answers.tuneSupported, true);
            assert.strictEqual(answers.tuneModelId, 'huggingface-llm-qwen2-5-7b-instruct');
        });

        it('resolves tuneModelId for a DeepSeek model', async () => {
            const answers = {
                modelName: 'deepseek-ai/DeepSeek-R1-Distill-Llama-8B',
                framework: 'transformers'
            };

            await _ensureTemplateVariables(answers, null);

            assert.strictEqual(answers.tuneSupported, true);
            assert.strictEqual(answers.tuneModelId, 'deepseek-llm-r1-distill-llama-8b');
        });

        it('resolves tuneModelId for a Meta Llama model', async () => {
            const answers = {
                modelName: 'meta-llama/Llama-3.1-8B-Instruct',
                framework: 'transformers'
            };

            await _ensureTemplateVariables(answers, null);

            assert.strictEqual(answers.tuneSupported, true);
            assert.strictEqual(answers.tuneModelId, 'meta-textgeneration-llama-3-1-8b-instruct');
        });
    });

    describe('no-match case — HuggingFace ID not in catalog', () => {
        it('sets tuneModelId to null when model is not in tune catalog', async () => {
            const answers = {
                modelName: 'some-org/unknown-model-7b',
                framework: 'transformers'
            };

            await _ensureTemplateVariables(answers, null);

            assert.strictEqual(answers.tuneSupported, false);
            assert.strictEqual(answers.tuneModelId, null);
        });

        it('sets tuneModelId to null when modelName is empty', async () => {
            const answers = {
                modelName: '',
                framework: 'transformers'
            };

            await _ensureTemplateVariables(answers, null);

            assert.strictEqual(answers.tuneModelId, null);
        });
    });

    describe('non-transformers case — tuneSupported=false skips lookup', () => {
        it('sets tuneModelId to null when tuneSupported is explicitly false', async () => {
            const answers = {
                modelName: 'Qwen/Qwen3-4B',
                framework: 'transformers',
                tuneSupported: false
            };

            await _ensureTemplateVariables(answers, null);

            // tuneSupported was pre-set to false, so lookup is skipped
            assert.strictEqual(answers.tuneSupported, false);
            assert.strictEqual(answers.tuneModelId, null);
        });

        it('sets tuneModelId to null for non-transformers architecture', async () => {
            const answers = {
                modelName: 'some-model',
                architecture: 'triton',
                framework: 'triton'
            };

            await _ensureTemplateVariables(answers, null);

            assert.strictEqual(answers.tuneSupported, false);
            assert.strictEqual(answers.tuneModelId, null);
        });

        it('does not override tuneModelId if already set', async () => {
            const answers = {
                modelName: 'Qwen/Qwen3-4B',
                framework: 'transformers',
                tuneModelId: 'custom-override-id'
            };

            await _ensureTemplateVariables(answers, null);

            // Should not override the pre-set value
            assert.strictEqual(answers.tuneModelId, 'custom-override-id');
        });
    });
});

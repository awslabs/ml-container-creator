// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive engine-feature answer normalization (fix for the review finding
 * that declining a feature in interactive mode still emitted it).
 *
 * normalizeEngineFeatureAnswers() collapses `__engine_feature__<name>` prompt
 * answers into `engineFeatureVars`, emitting ONLY values the user changed from
 * the engine's declared default — matching --server-env's "only what you pass".
 */
import { describe, it } from 'mocha';
import assert from 'node:assert';
import { normalizeEngineFeatureAnswers } from '../../src/lib/prompt-runner.js';

describe('normalizeEngineFeatureAnswers (interactive engine-feature emission)', () => {

    it('a declined boolean (left at its false default) is NOT emitted', () => {
        // RadixAttention default is "false"; the user accepted the default.
        const answers = { backend: 'sglang', __engine_feature__radix_attention: false };
        normalizeEngineFeatureAnswers(answers);
        assert.strictEqual(answers.engineFeatureVars, undefined,
            'declining the only feature must leave no engineFeatureVars');
        assert.ok(!('__engine_feature__radix_attention' in answers),
            'the namespaced prompt key must be stripped');
    });

    it('an enabled boolean (changed from the default) IS emitted', () => {
        const answers = { backend: 'sglang', __engine_feature__radix_attention: true };
        normalizeEngineFeatureAnswers(answers);
        assert.deepStrictEqual(answers.engineFeatureVars, { radix_attention: 'true' },
            'enabling the feature emits it as a string value');
    });

    it('an enum left at its default (auto) is NOT emitted', () => {
        const answers = { backend: 'lmi', __engine_feature__rolling_batch_backend: 'auto' };
        normalizeEngineFeatureAnswers(answers);
        assert.strictEqual(answers.engineFeatureVars, undefined,
            'keeping the enum default emits nothing');
    });

    it('an enum changed from the default IS emitted', () => {
        const answers = { backend: 'lmi', __engine_feature__rolling_batch_backend: 'vllm' };
        normalizeEngineFeatureAnswers(answers);
        assert.deepStrictEqual(answers.engineFeatureVars, { rolling_batch_backend: 'vllm' });
    });

    it('a CLI-provided value wins over the prompt answer', () => {
        // --engine-feature already set radix_attention=true; the prompt (somehow)
        // also carries a value. The CLI value is preserved, prompt ignored.
        const answers = {
            backend: 'sglang',
            engineFeatureVars: { radix_attention: 'true' },
            __engine_feature__radix_attention: false
        };
        normalizeEngineFeatureAnswers(answers);
        assert.deepStrictEqual(answers.engineFeatureVars, { radix_attention: 'true' },
            'CLI-provided engineFeatureVars take precedence over the prompt');
    });

    it('no engine-feature answers → no engineFeatureVars (clean no-op)', () => {
        const answers = { backend: 'sglang', modelName: 'x' };
        normalizeEngineFeatureAnswers(answers);
        assert.strictEqual(answers.engineFeatureVars, undefined);
    });
});

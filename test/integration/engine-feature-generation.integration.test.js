// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration: --engine-feature survives the FULL generation pipeline.
 *
 * The unit test (test/unit/engine-feature-generation.test.js) proves the pieces
 * in isolation (resolver, EJS render). THIS test proves the glue: it spawns the
 * real CLI via runGenerator with `--engine-feature`, lets config-loader →
 * config-manager → app.js run end-to-end, and asserts the resolved env var lands
 * in the generated `do/config` ON DISK. That closes the integration gap an
 * independent review flagged — a regression in the glue (config-manager dropping
 * the key, flag-forwarding break, de-dup bug) would otherwise pass every
 * isolated unit test silently.
 *
 * Deterministic/offline: runGenerator defaults to --skip-prompts and sets
 * VALIDATE_ENV_VARS=false; we pass a concrete model + instance so no MCP/network
 * resolution is needed. Mirrors test/integration/profile-backward-compat.test.js.
 */
import { describe, it, after } from 'mocha';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('Integration: --engine-feature → do/config (end-to-end)', () => {
    const cleanups = [];
    after(() => {
        for (const c of cleanups) {
            try { c(); } catch { /* best-effort temp cleanup */ }
        }
    });

    function generate(options) {
        const result = runGenerator({
            'deployment-config': 'transformers-sglang',
            'model-name': 'Qwen/Qwen3-0.6B',
            'instance-type': 'ml.g5.xlarge',
            ...options
        });
        cleanups.push(result.cleanup);
        return result;
    }

    it('SGLang radix_attention=true lands in do/config as the real env var', () => {
        const result = generate({ 'engine-feature': ['radix_attention=true'] });
        const config = readFileSync(result.file('do/config'), 'utf8');
        assert.match(config, /export SGLANG_ENABLE_RADIX_CACHE=\$\{SGLANG_ENABLE_RADIX_CACHE:-true\}/,
            'do/config must export the resolved SGLang RadixAttention env var');
    });

    it('LMI rolling_batch_backend=vllm lands in do/config as OPTION_ROLLING_BATCH', () => {
        const result = runGenerator({
            'deployment-config': 'transformers-lmi',
            'model-name': 'Qwen/Qwen3-0.6B',
            'instance-type': 'ml.g5.xlarge',
            'engine-feature': ['rolling_batch_backend=vllm']
        });
        cleanups.push(result.cleanup);
        const config = readFileSync(result.file('do/config'), 'utf8');
        assert.match(config, /export OPTION_ROLLING_BATCH=\$\{OPTION_ROLLING_BATCH:-vllm\}/,
            'do/config must export the resolved LMI backend env var');
    });

    it('engine-feature + server-env targeting the same var emit ONE export line (de-dup, last-wins)', () => {
        // --engine-feature resolves to OPTION_ROLLING_BATCH=vllm; --server-env sets
        // the same underlying var to auto. Only one export line must survive, and
        // the engine-feature value (pushed later) wins.
        const result = runGenerator({
            'deployment-config': 'transformers-lmi',
            'model-name': 'Qwen/Qwen3-0.6B',
            'instance-type': 'ml.g5.xlarge',
            'engine-feature': ['rolling_batch_backend=vllm'],
            'server-env': ['OPTION_ROLLING_BATCH=auto']
        });
        cleanups.push(result.cleanup);
        const config = readFileSync(result.file('do/config'), 'utf8');
        const lines = config.split('\n').filter((l) => l.includes('export OPTION_ROLLING_BATCH='));
        assert.equal(lines.length, 1, `expected exactly one OPTION_ROLLING_BATCH export, got ${lines.length}:\n${lines.join('\n')}`);
        assert.match(lines[0], /:-vllm\}/, 'the engine-feature value (vllm) must win over the server-env value');
    });

    it('a feature-less engine (vLLM) with no --engine-feature generates cleanly, no feature var', () => {
        const result = runGenerator({
            'deployment-config': 'transformers-vllm',
            'model-name': 'Qwen/Qwen3-0.6B',
            'instance-type': 'ml.g5.xlarge'
        });
        cleanups.push(result.cleanup);
        const config = readFileSync(result.file('do/config'), 'utf8');
        assert.doesNotMatch(config, /SGLANG_ENABLE_RADIX_CACHE|OPTION_ROLLING_BATCH/,
            'vLLM project must not carry another engine\'s feature var');
    });

    it('an invalid --engine-feature value fails generation (manifest-validated)', () => {
        // rolling_batch_backend is an enum; "nope" is not an allowed value. The
        // generator must reject it (non-zero exit) rather than emit garbage.
        assert.throws(() => {
            const result = runGenerator({
                'deployment-config': 'transformers-lmi',
                'model-name': 'Qwen/Qwen3-0.6B',
                'instance-type': 'ml.g5.xlarge',
                'engine-feature': ['rolling_batch_backend=nope']
            });
            cleanups.push(result.cleanup);
        }, /engine-feature|rolling_batch_backend|must be one of/i,
        'generation must fail with a clear message on an invalid engine-feature value');
    });

    it('an unknown feature for the selected engine fails generation', () => {
        assert.throws(() => {
            const result = runGenerator({
                'deployment-config': 'transformers-vllm',
                'model-name': 'Qwen/Qwen3-0.6B',
                'instance-type': 'ml.g5.xlarge',
                'engine-feature': ['radix_attention=true']  // vLLM has no engine_features
            });
            cleanups.push(result.cleanup);
        }, /no feature 'radix_attention'|engine-feature/i,
        'requesting a feature the engine does not declare must fail generation');
    });
});

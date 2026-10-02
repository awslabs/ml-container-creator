// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BL127 — prompt-runner respects an explicit enableLora=false opt-out.
 *
 * Regression: enableLora was hardcoded `true` unconditionally on every
 * `mcc generate`/`mcc regenerate`, clobbering an explicit ENABLE_LORA=false from
 * do/config, CLI flags, or existingConfig. This crash-looped LoRA-incapable
 * architectures (e.g. KimiK3ForConditionalGeneration) that could never be
 * disabled.
 *
 * These tests exercise PromptRunner._resolveEnableLora — the pure resolution
 * used by run() to seed the generate-time `enableLora` answer — covering both
 * the generate path (explicitConfig) and the regenerate path (existingConfig),
 * for boolean and string ("false"/"true") value shapes.
 *
 * Feature: BL127
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import PromptRunner from '../../src/lib/prompt-runner.js';

/** A PromptRunner instance is enough to call the pure _resolveEnableLora. */
function makeRunner() {
    return new PromptRunner({
        configManager: null,
        options: {},
        registryConfigManager: null,
        baseConfig: {},
        promptFn: async () => ({})
    });
}

describe('BL127 — PromptRunner._resolveEnableLora opt-out', () => {
    const runner = makeRunner();

    describe('default (neither source sets it)', () => {
        it('defaults to true when both configs are empty', () => {
            assert.strictEqual(runner._resolveEnableLora({}, {}), true);
        });

        it('defaults to true when enableLora is undefined/null', () => {
            assert.strictEqual(runner._resolveEnableLora({ enableLora: undefined }, { enableLora: null }), true);
        });
    });

    describe('generate path — explicitConfig opt-out (CLI/env/do-config)', () => {
        it('respects explicit boolean false', () => {
            assert.strictEqual(runner._resolveEnableLora({ enableLora: false }, {}), false);
        });

        it('respects explicit string "false" (env var / do/config shape)', () => {
            assert.strictEqual(runner._resolveEnableLora({ enableLora: 'false' }, {}), false);
        });

        it('respects explicit boolean true', () => {
            assert.strictEqual(runner._resolveEnableLora({ enableLora: true }, {}), true);
        });

        it('respects explicit string "true"', () => {
            assert.strictEqual(runner._resolveEnableLora({ enableLora: 'true' }, {}), true);
        });

        it('explicit opt-out wins even when existingConfig had it enabled', () => {
            assert.strictEqual(runner._resolveEnableLora({ enableLora: false }, { enableLora: true }), false);
        });
    });

    describe('regenerate path — existingConfig preserves prior value', () => {
        it('preserves existing boolean false when no explicit value is set', () => {
            assert.strictEqual(runner._resolveEnableLora({}, { enableLora: false }), false);
        });

        it('preserves existing string "false" when no explicit value is set', () => {
            assert.strictEqual(runner._resolveEnableLora({}, { enableLora: 'false' }), false);
        });

        it('preserves existing true when no explicit value is set', () => {
            assert.strictEqual(runner._resolveEnableLora({}, { enableLora: true }), true);
        });

        it('explicit opt-in overrides an existing opt-out (explicit wins)', () => {
            assert.strictEqual(runner._resolveEnableLora({ enableLora: true }, { enableLora: false }), true);
        });
    });
});

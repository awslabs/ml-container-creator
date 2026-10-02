// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * --engine-feature end-to-end generation (ADR-004 §c, Option A: config-only).
 *
 * Verifies that an engine-specific feature requested via --engine-feature
 * NAME=VALUE (or the interactive prompt) is:
 *   1. resolved to the engine's REAL env var via the serve-plugin manifest,
 *   2. validated generically (unknown name / bad enum / bad boolean rejected),
 *   3. emitted into orderedEnvVars → rendered as an `export` line in do/config,
 * all data-driven from the manifests — no engine-name branching, no frozen
 * engine literals beyond the two shipped deviations themselves.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import {
    resolveEngineFeatureVars,
    engineFeature
} from '../../src/lib/serve-manifest-reader.js';
import { engineFeaturePrompts } from '../../src/lib/prompts/model-prompts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_TEMPLATE = readFileSync(
    resolve(__dirname, '../../templates/do/config'),
    'utf-8'
);

/** Base template variables required for do/config rendering (mirrors server-env test). */
function baseVars(overrides = {}) {
    return {
        projectName: 'test-project',
        deploymentConfig: 'transformers-sglang',
        framework: 'transformers',
        modelServer: 'sglang',
        awsRegion: 'us-east-1',
        buildTarget: 'local',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        modelName: 'meta-llama/Llama-2-7b-hf',
        hfToken: 'hf_test_token',
        hfTokenArn: '',
        ngcApiKey: '',
        ngcTokenArn: '',
        roleArn: '',
        modelFormat: '',
        baseImage: '',
        orderedEnvVars: [],
        codebuildComputeType: '',
        inferenceAmiVersion: '',
        ...overrides
    };
}

describe('--engine-feature end-to-end (ADR-004 §c)', () => {

    describe('resolution: feature name → the engine\'s real env var', () => {
        it('SGLang radix_attention resolves to its declared env var', () => {
            const decl = engineFeature('sglang', 'radix_attention');
            const { resolved, errors } = resolveEngineFeatureVars('sglang', { radix_attention: 'true' });
            assert.equal(errors.length, 0);
            assert.deepEqual(resolved, [{ key: decl.env_var, value: 'true' }]);
        });

        it('LMI rolling_batch_backend resolves to its declared env var', () => {
            const decl = engineFeature('lmi', 'rolling_batch_backend');
            const { resolved, errors } = resolveEngineFeatureVars('lmi', { rolling_batch_backend: 'vllm' });
            assert.equal(errors.length, 0);
            assert.deepEqual(resolved, [{ key: decl.env_var, value: 'vllm' }]);
        });

        it('an engine with no engine_features resolves nothing and errors on a request', () => {
            // vLLM declares no engine_features — the deviation. Asking for one errors.
            const { resolved, errors } = resolveEngineFeatureVars('vllm', { radix_attention: 'true' });
            assert.equal(resolved.length, 0);
            assert.equal(errors.length, 1);
            assert.match(errors[0], /no feature 'radix_attention'/);
        });

        it('no requested features resolves to nothing (clean no-op)', () => {
            assert.deepEqual(resolveEngineFeatureVars('sglang', {}), { resolved: [], errors: [] });
        });
    });

    describe('validation: rejects malformed values (derived from type/values)', () => {
        it('rejects a non-true/false boolean', () => {
            const { errors } = resolveEngineFeatureVars('sglang', { radix_attention: 'maybe' });
            assert.equal(errors.length, 1);
            assert.match(errors[0], /boolean/);
        });

        it('rejects an enum value outside the declared set', () => {
            const { errors } = resolveEngineFeatureVars('lmi', { rolling_batch_backend: 'nope' });
            assert.equal(errors.length, 1);
            // Message lists the allowed values (derived from the manifest).
            const allowed = engineFeature('lmi', 'rolling_batch_backend').values;
            for (const v of allowed) assert.match(errors[0], new RegExp(v));
        });

        it('accepts every declared enum value for the feature (data-driven)', () => {
            const allowed = engineFeature('lmi', 'rolling_batch_backend').values;
            for (const v of allowed) {
                const { resolved, errors } = resolveEngineFeatureVars('lmi', { rolling_batch_backend: v });
                assert.equal(errors.length, 0, `value ${v} should be accepted`);
                assert.equal(resolved[0].value, v);
            }
        });
    });

    describe('emission: resolved feature renders as an export line in do/config', () => {
        it('SGLang radix_attention becomes an export line via orderedEnvVars', () => {
            const { resolved } = resolveEngineFeatureVars('sglang', { radix_attention: 'true' });
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({ orderedEnvVars: resolved }));
            const envVar = engineFeature('sglang', 'radix_attention').env_var;
            assert.ok(
                output.includes(`export ${envVar}=`),
                `do/config should export ${envVar}`
            );
            // Uses the runtime-override pattern like every other ordered env var.
            assert.match(
                output,
                new RegExp(`export ${envVar}=\\$\\{${envVar}:-true\\}`),
                'should use the ${KEY:-value} runtime-override pattern'
            );
        });

        it('LMI rolling_batch_backend becomes an export line via orderedEnvVars', () => {
            const { resolved } = resolveEngineFeatureVars('lmi', { rolling_batch_backend: 'vllm' });
            const output = ejs.render(CONFIG_TEMPLATE, baseVars({
                deploymentConfig: 'transformers-lmi', modelServer: 'lmi', orderedEnvVars: resolved
            }));
            const envVar = engineFeature('lmi', 'rolling_batch_backend').env_var;
            assert.ok(output.includes(`export ${envVar}=`), `do/config should export ${envVar}`);
        });
    });

    describe('interactive prompts are built per engine, gated by selection', () => {
        it('one prompt per declared feature, each widget derived from its type', () => {
            // Data-driven: every prompt corresponds to a real declared feature, and
            // its widget type matches the declaration (boolean→confirm, enum→list).
            assert.ok(engineFeaturePrompts.length >= 2,
                'at least the two shipped engine features produce prompts');
            for (const p of engineFeaturePrompts) {
                assert.ok(p.name.startsWith('__engine_feature__'),
                    'prompt uses the engine-feature answer namespace');
                assert.ok(['confirm', 'list', 'input'].includes(p.type),
                    `prompt type ${p.type} is a derived widget`);
                assert.equal(typeof p.when, 'function', 'prompt is engine-gated via when()');
            }
        });

        it('a feature prompt is shown ONLY for the engine that declares it', () => {
            // radix_attention is SGLang's — shown for sglang, hidden for vllm/lmi.
            const radix = engineFeaturePrompts.find(p => p.name === '__engine_feature__radix_attention');
            assert.ok(radix, 'radix_attention prompt exists');
            assert.equal(radix.when({ backend: 'sglang' }), true);
            assert.equal(radix.when({ backend: 'vllm' }), false);
            assert.equal(radix.when({ backend: 'lmi' }), false);
        });

        it('enum feature prompt offers exactly the declared values as choices', () => {
            const backendPrompt = engineFeaturePrompts.find(p => p.name === '__engine_feature__rolling_batch_backend');
            assert.ok(backendPrompt, 'rolling_batch_backend prompt exists');
            assert.equal(backendPrompt.type, 'list');
            assert.deepEqual(backendPrompt.choices, engineFeature('lmi', 'rolling_batch_backend').values);
        });
    });
});

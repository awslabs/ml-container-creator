// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * llama.cpp serve-engine plugin — behavioral tests.
 *
 * llama.cpp runs on the AWS DLC for llama.cpp, a CONTAINER-OWNS-ENTRYPOINT
 * engine (like lmi/djl, unlike vllm/sglang): the DLC reads SM_LLAMA_CPP_* env
 * vars and maps them to llama.cpp args ITSELF, then runs its own llama-server
 * entrypoint. These tests assert the plugin's contract through the readers and
 * the rendered serve script — behavior, not frozen snapshots — so they stay
 * meaningful as the catalog and versions evolve:
 *   - the manifest round-trips through the serve-manifest readers (prefix,
 *     non-speculative, engine_features), and
 *   - the generated serve script hands off to the DLC entrypoint rather than
 *     translating env vars into --flags (the vllm/sglang pattern), which for a
 *     DLC-owned-entrypoint engine would be a double-translation bug.
 *
 * ADR-004 parity + engine_features coverage for llama-cpp is ALSO exercised
 * generically by bl105-serve-manifest.test.js (data-driven over serve.d/); this
 * file adds the llama.cpp-SPECIFIC assertions that generic parity cannot make.
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    readEnvVarPrefix,
    engineFeature,
    engineFeatures,
    resolveEngineFeatureVars,
    effectiveSupportedAlgorithms,
    serveEngineRuntimeVarsUnion
} from '../../src/lib/serve-manifest-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SERVE_D = resolve(ROOT, 'templates', 'code', 'serve.d');
const SERVE_TEMPLATE_PATH = resolve(ROOT, 'templates', 'code', 'serve');
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf8');

function loadManifest() {
    return JSON.parse(readFileSync(resolve(SERVE_D, 'llama-cpp', 'manifest.json'), 'utf8'));
}

describe('llama.cpp serve-engine plugin', () => {
    describe('manifest contract (via the readers)', () => {
        it('declares the SM_LLAMA_CPP_ prefix the AWS DLC actually reads', () => {
            assert.strictEqual(readEnvVarPrefix('llama-cpp'), 'SM_LLAMA_CPP_');
        });

        it('is honestly non-speculative (the serving path has no speculative decoding)', () => {
            const m = loadManifest();
            assert.strictEqual(m.speculative_decoding, false);
            assert.deepStrictEqual(m.supported_algorithms, []);
            assert.deepStrictEqual(m.algorithm_map, {});
            // The effective set is empty at any version (fail-open returns the flat []).
            assert.deepStrictEqual(effectiveSupportedAlgorithms('llama-cpp', null), []);
        });

        it('declares the llama.cpp-specific engine_features (gpu_layers, threads, flash_attn)', () => {
            const features = engineFeatures('llama-cpp');
            assert.deepStrictEqual(
                Object.keys(features).sort(),
                ['flash_attn', 'gpu_layers', 'threads']
            );
            // Each feature's env var is what the DLC reads, under the engine prefix.
            for (const name of Object.keys(features)) {
                assert.ok(
                    features[name].env_var.startsWith('SM_LLAMA_CPP_'),
                    `${name} env_var must start with SM_LLAMA_CPP_`
                );
            }
            assert.strictEqual(engineFeature('llama-cpp', 'gpu_layers').type, 'int');
            assert.strictEqual(engineFeature('llama-cpp', 'flash_attn').type, 'boolean');
        });
    });

    describe('engine-feature resolution emits the DLC env vars', () => {
        it('resolves gpu_layers / threads / flash_attn to their SM_LLAMA_CPP_* env vars', () => {
            const { resolved, errors } = resolveEngineFeatureVars('llama-cpp', {
                gpu_layers: '-1',
                threads: '32',
                flash_attn: 'true'
            });
            assert.deepStrictEqual(errors, []);
            const map = Object.fromEntries(resolved.map(({ key, value }) => [key, value]));
            assert.strictEqual(map.SM_LLAMA_CPP_N_GPU_LAYERS, '-1');
            assert.strictEqual(map.SM_LLAMA_CPP_THREADS, '32');
            assert.strictEqual(map.SM_LLAMA_CPP_FLASH_ATTN, 'true');
        });

        it('rejects a non-integer gpu_layers and a non-boolean flash_attn (validated from the declaration)', () => {
            const bad = resolveEngineFeatureVars('llama-cpp', { gpu_layers: 'all', flash_attn: 'yes' });
            assert.strictEqual(bad.resolved.length, 0);
            assert.strictEqual(bad.errors.length, 2);
        });
    });

    describe('runtime-owned var derivation', () => {
        it('contributes SM_LLAMA_CPP_CTX_SIZE to the regenerate-preserved union (from dimension_map)', () => {
            const union = serveEngineRuntimeVarsUnion();
            assert.ok(
                union.includes('SM_LLAMA_CPP_CTX_SIZE'),
                'the llama-cpp dimension_map (max_model_len → CTX_SIZE) must surface as SM_LLAMA_CPP_CTX_SIZE'
            );
        });
    });

    describe('serve dispatch — container owns the entrypoint (no --flag translation)', () => {
        function renderServe() {
            return ejs.render(SERVE_TEMPLATE, {
                modelSource: 'huggingface',
                modelServer: 'llama-cpp',
                modelName: 'Qwen/Qwen3-4B-GGUF',
                artifactUri: '',
                modelLoadStrategy: 'runtime'
            }, { filename: SERVE_TEMPLATE_PATH });
        }

        it('renders the llama-cpp wrapper via the dispatch branch', () => {
            const rendered = renderServe();
            assert.ok(rendered.length > 0);
            assert.ok(
                rendered.includes('AWS DLC for llama.cpp'),
                'serve script should include the llama.cpp wrapper content'
            );
        });

        it('hands off to the DLC entrypoint instead of building --flags or exec-ing a server', () => {
            const rendered = renderServe();
            // The DLC owns llama-server; our wrapper must NOT exec a server or
            // translate SM_LLAMA_CPP_* into CLI flags (that is the vllm/sglang
            // pattern and would double-translate for this engine).
            assert.ok(
                !/exec .*llama-server/.test(rendered),
                'the llama-cpp wrapper must not exec llama-server — the DLC owns the entrypoint'
            );
            assert.ok(
                !/SERVER_ARGS\+=/.test(renderedLlamaSection(rendered)),
                'the llama-cpp branch must not build SERVER_ARGS (no env→flag translation)'
            );
        });

        it('does NOT run the vllm-style model-resolution preamble for llama-cpp', () => {
            const rendered = renderServe();
            // The _MODEL_VAR resolve_model() preamble is for translating engines;
            // llama-cpp takes the early branch and skips it.
            assert.ok(
                !rendered.includes('export "${_MODEL_VAR}='),
                'llama-cpp must take the early DLC branch, not the _MODEL_VAR preamble'
            );
        });

        // Extract just the portion of the rendered serve script contributed by
        // the llama-cpp branch, so the SERVER_ARGS assertion is scoped (the full
        // template defines SERVER_ARGS in the non-llama-cpp else branch, which is
        // not emitted when modelServer === 'llama-cpp').
        function renderedLlamaSection(rendered) {
            const marker = 'AWS DLC for llama.cpp';
            const idx = rendered.indexOf(marker);
            return idx === -1 ? rendered : rendered.slice(idx);
        }
    });
});

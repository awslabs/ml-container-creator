// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Rendering-level unit tests for speculative decoding (BL085).
 *
 * Tests cover:
 * - Disabled no-op: HP_SPECULATIVE_ENABLED=false injects no SPECULATIVE_* env vars
 *   into deployment.yaml, and the render is byte-identical to the feature-absent render.
 * - vLLM enabled (draft-model): correct `--speculative-config` SPECULATIVE_CONFIG JSON assembled.
 * - SGLang enabled (eagle): correct discrete env vars assembled (UPPERCASE algorithm).
 * - s3:// draft-model guard: serve scripts print the error and exit 1.
 * - Compatibility: LoRA + speculative coexist; multi-GPU draft_tensor_parallel_size.
 *
 * Feature: v16-w3-01-bl085-speculative-decoding
 * Validates: Requirements 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEPLOYMENT_TEMPLATE_PATH = resolve(__dirname, '../../templates/hyperpod/deployment.yaml');
const DEPLOYMENT_TEMPLATE = readFileSync(DEPLOYMENT_TEMPLATE_PATH, 'utf8');

const SERVE_TEMPLATE_PATH = resolve(__dirname, '../../templates/code/serve');
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderDeployment(overrides = {}) {
    const defaults = {
        projectName: 'test-model',
        hyperPodNamespace: 'default',
        framework: 'transformers',
        modelServer: 'vllm',
        hyperPodReplicas: 1,
        awsRegion: 'us-east-1',
        instanceType: 'ml.g5.xlarge',
        fsxVolumeHandle: '',
        HP_GPU_COUNT: '1',
        HP_NODE_SELECTOR: '',
        HP_EFA_ENABLED: 'false',
        HP_MEM_REQUEST: '',
        HP_CPU_REQUEST: '',
        HP_QUEUE: ''
    };
    return ejs.render(DEPLOYMENT_TEMPLATE, { ...defaults, ...overrides });
}

function renderServe(overrides = {}) {
    const vars = {
        modelServer: 'vllm',
        modelSource: 'huggingface',
        modelName: 'meta-llama/Llama-3.1-8B-Instruct',
        artifactUri: '',
        modelLoadStrategy: 'runtime',
        ...overrides
    };
    return ejs.render(SERVE_TEMPLATE, vars, { filename: SERVE_TEMPLATE_PATH });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: v16-w3-01-bl085-speculative-decoding — deployment.yaml rendering', () => {

    // ── Property 1: Disabled render is a byte-identical no-op (Req 2.3, 6.1) ──

    describe('disabled path injects no speculative env vars (Req 2.3, 6.1)', () => {

        it('HP_SPECULATIVE_ENABLED=false: no SPECULATIVE_* env vars for vLLM', () => {
            const out = renderDeployment({ modelServer: 'vllm', HP_SPECULATIVE_ENABLED: 'false' });
            assert.ok(!out.includes('SPECULATIVE_CONFIG'), 'must not inject SPECULATIVE_CONFIG');
            assert.ok(!out.includes('SPECULATIVE_ALGORITHM'), 'must not inject SPECULATIVE_ALGORITHM');
        });

        it('HP_SPECULATIVE_ENABLED=false: no SPECULATIVE_* env vars for SGLang', () => {
            const out = renderDeployment({ modelServer: 'sglang', HP_SPECULATIVE_ENABLED: 'false' });
            assert.ok(!out.includes('SPECULATIVE_ALGORITHM'), 'must not inject SPECULATIVE_ALGORITHM');
            assert.ok(!out.includes('SPECULATIVE_DRAFT_MODEL_PATH'), 'must not inject draft model path');
        });

        it('speculative absent entirely: no SPECULATIVE_* env vars', () => {
            const out = renderDeployment({ modelServer: 'vllm' });
            assert.ok(!out.includes('SPECULATIVE_'), 'must not inject any SPECULATIVE_* env var');
        });

        it('disabled render is byte-identical to feature-absent render (Property 1)', () => {
            const absent = renderDeployment({ modelServer: 'vllm' });
            const disabled = renderDeployment({ modelServer: 'vllm', HP_SPECULATIVE_ENABLED: 'false' });
            assert.strictEqual(disabled, absent, 'disabled render must be byte-identical to feature-absent render');
        });
    });

    // ── Property 2: vLLM enabled emits the mapped --speculative-config JSON (Req 2.1, 6.2) ──

    describe('vLLM draft-model assembles the correct SPECULATIVE_CONFIG JSON (Req 2.1, 6.2)', () => {

        it('injects SPECULATIVE_CONFIG env var when enabled for vLLM', () => {
            const out = renderDeployment({
                modelServer: 'vllm',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'draft-model',
                HP_SPECULATIVE_MODEL: 'JackFram/llama-68m',
                HP_SPECULATIVE_NUM_TOKENS: '5'
            });
            assert.ok(out.includes('name: SPECULATIVE_CONFIG'), 'must inject SPECULATIVE_CONFIG');
        });

        it('maps draft-model → method "draft_model" with model + num_speculative_tokens', () => {
            const out = renderDeployment({
                modelServer: 'vllm',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'draft-model',
                HP_SPECULATIVE_MODEL: 'JackFram/llama-68m',
                HP_SPECULATIVE_NUM_TOKENS: '5'
            });
            assert.ok(out.includes('"method":"draft_model"'), 'method must be draft_model');
            assert.ok(out.includes('"model":"JackFram/llama-68m"'), 'model must be present');
            assert.ok(out.includes('"num_speculative_tokens":5'), 'num_speculative_tokens must be numeric 5');
        });

        it('includes draft_tensor_parallel_size only when HP_SPECULATIVE_DRAFT_TP set', () => {
            const withTp = renderDeployment({
                modelServer: 'vllm',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'draft-model',
                HP_SPECULATIVE_MODEL: 'JackFram/llama-68m',
                HP_SPECULATIVE_DRAFT_TP: '2'
            });
            assert.ok(withTp.includes('"draft_tensor_parallel_size":2'), 'draft TP must be present when set');

            const withoutTp = renderDeployment({
                modelServer: 'vllm',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'draft-model',
                HP_SPECULATIVE_MODEL: 'JackFram/llama-68m'
            });
            assert.ok(!withoutTp.includes('draft_tensor_parallel_size'), 'draft TP absent when unset');
        });

        it('includes disable_by_batch_size only when set', () => {
            const out = renderDeployment({
                modelServer: 'vllm',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'draft-model',
                HP_SPECULATIVE_MODEL: 'JackFram/llama-68m',
                HP_SPECULATIVE_DISABLE_BY_BATCH_SIZE: '32'
            });
            assert.ok(out.includes('"disable_by_batch_size":32'), 'disable_by_batch_size present when set');
        });

        it('does NOT emit SGLang discrete env vars on the vLLM path (Property 2)', () => {
            const out = renderDeployment({
                modelServer: 'vllm',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'draft-model',
                HP_SPECULATIVE_MODEL: 'JackFram/llama-68m'
            });
            assert.ok(!out.includes('SPECULATIVE_ALGORITHM'), 'no SGLang SPECULATIVE_ALGORITHM on vLLM path');
            assert.ok(!out.includes('SPECULATIVE_DRAFT_MODEL_PATH'), 'no SGLang draft path on vLLM path');
        });
    });

    // ── Property 2: SGLang enabled emits discrete env vars (Req 2.2, 6.3) ──

    describe('SGLang eagle assembles the correct discrete env vars (Req 2.2, 6.3)', () => {

        it('injects UPPERCASE SPECULATIVE_ALGORITHM and companions', () => {
            const out = renderDeployment({
                modelServer: 'sglang',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'eagle',
                HP_SPECULATIVE_MODEL: 'yuhuili/EAGLE-LLaMA3-Instruct-8B',
                HP_SPECULATIVE_NUM_TOKENS: '5',
                HP_SPECULATIVE_EAGLE_TOPK: '8'
            });
            assert.ok(out.includes('name: SPECULATIVE_ALGORITHM'), 'must inject SPECULATIVE_ALGORITHM');
            assert.ok(out.includes('name: SPECULATIVE_DRAFT_MODEL_PATH'), 'must inject draft model path');
            assert.ok(out.includes('name: SPECULATIVE_NUM_DRAFT_TOKENS'), 'must inject num draft tokens');
            assert.ok(out.includes('name: SPECULATIVE_EAGLE_TOPK'), 'must inject eagle topk when set');
            assert.ok(out.includes('value: "yuhuili/EAGLE-LLaMA3-Instruct-8B"'), 'draft model value present');
        });

        it('EAGLE_TOPK omitted when HP_SPECULATIVE_EAGLE_TOPK unset', () => {
            const out = renderDeployment({
                modelServer: 'sglang',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'eagle',
                HP_SPECULATIVE_MODEL: 'yuhuili/EAGLE-LLaMA3-Instruct-8B'
            });
            assert.ok(!out.includes('SPECULATIVE_EAGLE_TOPK'), 'no EAGLE_TOPK when unset');
        });

        it('does NOT emit vLLM SPECULATIVE_CONFIG on the SGLang path (Property 2)', () => {
            const out = renderDeployment({
                modelServer: 'sglang',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'eagle',
                HP_SPECULATIVE_MODEL: 'yuhuili/EAGLE-LLaMA3-Instruct-8B'
            });
            assert.ok(!out.includes('SPECULATIVE_CONFIG'), 'no vLLM SPECULATIVE_CONFIG on SGLang path');
        });
    });

    // ── Requirement 5: Compatibility (LoRA, multi-GPU) ──

    describe('compatibility: LoRA + speculative coexist (Req 5.1)', () => {

        it('renders both VLLM_ENABLE_LORA=true and SPECULATIVE_CONFIG without conflict', () => {
            const out = renderDeployment({
                modelServer: 'vllm',
                HP_LORA_ENABLED: 'true',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'draft-model',
                HP_SPECULATIVE_MODEL: 'JackFram/llama-68m'
            });
            assert.ok(out.includes('name: VLLM_ENABLE_LORA'), 'LoRA env var present');
            assert.ok(out.includes('value: "true"'), 'LoRA enabled');
            assert.ok(out.includes('name: SPECULATIVE_CONFIG'), 'speculative env var present');
        });
    });

    describe('compatibility: multi-GPU draft_tensor_parallel_size (Req 5.2)', () => {

        it('HP_GPU_COUNT>1 with draft TP renders both TP size and draft TP', () => {
            const out = renderDeployment({
                modelServer: 'vllm',
                HP_GPU_COUNT: '4',
                HP_SPECULATIVE_ENABLED: 'true',
                HP_SPECULATIVE_ALGORITHM: 'draft-model',
                HP_SPECULATIVE_MODEL: 'JackFram/llama-68m',
                HP_SPECULATIVE_DRAFT_TP: '1'
            });
            assert.ok(out.includes('VLLM_TENSOR_PARALLEL_SIZE'), 'main TP env present');
            assert.ok(out.includes('nvidia.com/gpu: "4"'), '4 GPUs requested');
            assert.ok(out.includes('"draft_tensor_parallel_size":1'), 'draft TP in spec config');
        });
    });
});

// ── serve-script s3:// guard tests (Req 3.3, 6.4) ──

describe('Feature: v16-w3-01-bl085-speculative-decoding — serve-script s3:// guard', () => {

    // ── Property 3: s3:// draft models are refused (Req 3.3, 6.4) ──

    describe('vLLM serve script refuses s3:// draft model (Req 3.3, 6.4)', () => {
        const rendered = renderServe({ modelServer: 'vllm' });

        it('contains the s3:// guard on HP_SPECULATIVE_MODEL', () => {
            assert.ok(rendered.includes('== s3://*'), 'must test for s3:// prefix');
            assert.ok(
                rendered.includes('must be a HuggingFace model ID or local path, not an s3:// URI'),
                'must print the s3:// error message'
            );
            assert.ok(rendered.includes('Stage it first with do/stage.'), 'must direct users to do/stage');
        });

        it('exits non-zero after the s3:// error', () => {
            // The guard block prints the error then exits 1.
            const idx = rendered.indexOf('not an s3:// URI');
            assert.ok(idx !== -1, 'error message present');
            const after = rendered.slice(idx, idx + 200);
            assert.ok(after.includes('exit 1'), 'must exit 1 after printing the error');
        });

        it('appends --speculative-config "$SPECULATIVE_CONFIG" when set', () => {
            assert.ok(rendered.includes('--speculative-config "${SPECULATIVE_CONFIG}"'), 'must append --speculative-config consolidated flag');
        });
    });

    describe('SGLang serve script refuses s3:// draft model (Req 3.3, 6.4)', () => {
        const rendered = renderServe({ modelServer: 'sglang' });

        it('contains the s3:// guard on HP_SPECULATIVE_MODEL', () => {
            assert.ok(rendered.includes('== s3://*'), 'must test for s3:// prefix');
            assert.ok(
                rendered.includes('must be a HuggingFace model ID or local path, not an s3:// URI'),
                'must print the s3:// error message'
            );
        });

        it('exits non-zero after the s3:// error', () => {
            const idx = rendered.indexOf('not an s3:// URI');
            assert.ok(idx !== -1, 'error message present');
            const after = rendered.slice(idx, idx + 200);
            assert.ok(after.includes('exit 1'), 'must exit 1 after printing the error');
        });

        it('maps SPECULATIVE_ALGORITHM to discrete --speculative-* flags (Req 3.2)', () => {
            assert.ok(rendered.includes('--speculative-algorithm'), 'must append --speculative-algorithm');
            assert.ok(rendered.includes('--speculative-draft-model-path'), 'must append draft model path');
            assert.ok(rendered.includes('--speculative-num-draft-tokens'), 'must append num draft tokens');
            assert.ok(rendered.includes('--speculative-eagle-topk'), 'must append eagle topk');
        });

        it('uppercases the algorithm enum for SGLang', () => {
            assert.ok(
                rendered.includes('tr \'[:lower:]\' \'[:upper:]\''),
                'must convert algorithm to UPPERCASE for SGLang'
            );
        });

        it('guards against vLLM-only algorithms (ngram, medusa) on the SGLang path', () => {
            assert.ok(rendered.includes('NGRAM|MEDUSA'), 'must match NGRAM|MEDUSA in the guard');
            assert.ok(
                rendered.includes('is vLLM-only and not supported by SGLang'),
                'must print the vLLM-only rejection message'
            );
            const idx = rendered.indexOf('is vLLM-only and not supported by SGLang');
            const after = rendered.slice(idx, idx + 200);
            assert.ok(after.includes('exit 1'), 'must exit 1 after rejecting vLLM-only algorithm');
        });
    });
});

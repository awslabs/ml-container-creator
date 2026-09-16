// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Rendering-level unit tests for speculative decoding (BL085).
 *
 * NOTE (BL088): The manifest-side speculative injection tests previously lived
 * here against templates/hyperpod/deployment.yaml. BL088 replaced the raw
 * Deployment manifest with the InferenceEndpointConfig CRD and intentionally
 * ships the CRD WITHOUT speculative flags. BL085 re-homes buildVllmSpecConfig()
 * and the SGLang injection into templates/hyperpod/InferenceEndpointConfig.yaml.ejs
 * and will restore the manifest-side assertions there.
 *
 * The serve-script s3:// guard tests below remain valid: code/serve is the BYOC
 * entrypoint that owns the runtime speculative-flag assembly and the s3:// guard,
 * independent of the deployment manifest.
 *
 * Feature: v16-w3-01-bl085-speculative-decoding
 * Validates: Requirements 3.1, 3.2, 3.3, 6.4
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVE_TEMPLATE_PATH = resolve(__dirname, '../../templates/code/serve');
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf8');

// ── Helpers ──────────────────────────────────────────────────────────────────

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

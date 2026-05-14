// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for LoRA generation-time configuration.
 *
 * Tests cover:
 * - --enable-lora with vLLM produces correct env vars in Dockerfile
 * - --enable-lora with SGLang produces correct env vars in Dockerfile (converted to serve args)
 * - --enable-lora with DJL/LMI produces correct serving.properties options
 * - --enable-lora absent → no LoRA env vars in Dockerfile, no LoRA options in serving.properties
 * - --enable-lora with flask/fastapi model server → not rendered (unsupported)
 * - --max-loras 50 overrides default 30
 * - enableLora=true → do/adapter script present in output
 * - enableLora=false → do/adapter script absent
 * - do/adapters/ directory created when LoRA enabled
 *
 * Feature: lora-adapter-lifecycle
 * Validates: Requirements 7.1, 7.2
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGenerator } from '../helpers/run-generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DOCKERFILE_TEMPLATE_PATH = resolve(__dirname, '../../templates/Dockerfile');
const DOCKERFILE_TEMPLATE = readFileSync(DOCKERFILE_TEMPLATE_PATH, 'utf-8');

const SERVING_PROPS_TEMPLATE_PATH = resolve(__dirname, '../../templates/code/serving.properties');
const SERVING_PROPS_TEMPLATE = readFileSync(SERVING_PROPS_TEMPLATE_PATH, 'utf-8');

const SERVE_TEMPLATE_PATH = resolve(__dirname, '../../templates/code/serve');
const SERVE_TEMPLATE = readFileSync(SERVE_TEMPLATE_PATH, 'utf-8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderDockerfile(overrides = {}) {
    const vars = {
        framework: 'transformers',
        modelServer: 'vllm',
        modelSource: 'huggingface',
        modelName: 'meta-llama/Llama-3.1-8B-Instruct',
        artifactUri: '',
        modelLoadStrategy: 'runtime',
        projectName: 'test-project',
        buildTimestamp: '20240101',
        baseImage: null,
        hfToken: '',
        chatTemplate: '',
        comments: {},
        orderedEnvVars: [],
        includeSampleModel: false,
        enableLora: false,
        maxLoras: 30,
        maxLoraRank: 64,
        ...overrides
    };
    return ejs.render(DOCKERFILE_TEMPLATE, vars);
}

function renderServingProperties(overrides = {}) {
    const vars = {
        modelServer: 'lmi',
        modelSource: 'huggingface',
        modelName: 'meta-llama/Llama-3.1-8B-Instruct',
        artifactUri: '',
        hfToken: '',
        chatTemplate: '',
        orderedEnvVars: [],
        enableLora: false,
        maxLoras: 30,
        ...overrides
    };
    return ejs.render(SERVING_PROPS_TEMPLATE, vars);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: lora-adapter-lifecycle — Generation-time LoRA configuration', () => {

    // ── vLLM Dockerfile env vars (Req 7.2) ───────────────────────────────

    describe('--enable-lora with vLLM produces correct env vars in Dockerfile (Req 7.2)', () => {

        it('sets VLLM_ENABLE_LORA=true when enableLora is true', () => {
            const rendered = renderDockerfile({
                modelServer: 'vllm',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('ENV VLLM_ENABLE_LORA=true'),
                'Must set VLLM_ENABLE_LORA=true'
            );
        });

        it('sets VLLM_MAX_LORAS to default 30', () => {
            const rendered = renderDockerfile({
                modelServer: 'vllm',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('ENV VLLM_MAX_LORAS=30'),
                'Must set VLLM_MAX_LORAS=30'
            );
        });

        it('sets VLLM_MAX_LORA_RANK to default 64', () => {
            const rendered = renderDockerfile({
                modelServer: 'vllm',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('ENV VLLM_MAX_LORA_RANK=64'),
                'Must set VLLM_MAX_LORA_RANK=64'
            );
        });

        it('includes LoRA comment section', () => {
            const rendered = renderDockerfile({
                modelServer: 'vllm',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('# LoRA adapter serving configuration'),
                'Must include LoRA configuration comment'
            );
        });
    });

    // ── SGLang Dockerfile env vars (Req 7.2) ─────────────────────────────

    describe('--enable-lora with SGLang produces correct env vars in Dockerfile (Req 7.2)', () => {

        it('sets SGLANG_ENABLE_LORA=true when enableLora is true', () => {
            const rendered = renderDockerfile({
                modelServer: 'sglang',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('ENV SGLANG_ENABLE_LORA=true'),
                'Must set SGLANG_ENABLE_LORA=true'
            );
        });

        it('sets SGLANG_MAX_LORAS to default 30', () => {
            const rendered = renderDockerfile({
                modelServer: 'sglang',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('ENV SGLANG_MAX_LORAS=30'),
                'Must set SGLANG_MAX_LORAS=30'
            );
        });

        it('includes LoRA comment section', () => {
            const rendered = renderDockerfile({
                modelServer: 'sglang',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('# LoRA adapter serving configuration'),
                'Must include LoRA configuration comment'
            );
        });
    });

    // ── SGLang serve script args (Req 7.2) ───────────────────────────────
    // The serve script converts SGLANG_ENABLE_LORA and SGLANG_MAX_LORAS env vars
    // into --enable-lora and --max-loras command-line args via the env-to-arg loop.
    // We verify the env vars are set in the Dockerfile (above), which the serve
    // script's generic PREFIX-based conversion will translate to CLI args at runtime.

    // ── DJL/LMI serving.properties (Req 7.2) ────────────────────────────

    describe('--enable-lora with DJL/LMI produces correct serving.properties (Req 7.2)', () => {

        for (const modelServer of ['lmi', 'djl']) {
            it(`${modelServer}: sets option.enable_lora=true`, () => {
                const rendered = renderServingProperties({
                    modelServer,
                    enableLora: true,
                    maxLoras: 30
                });
                assert.ok(
                    rendered.includes('option.enable_lora=true'),
                    `${modelServer}: Must set option.enable_lora=true`
                );
            });

            it(`${modelServer}: sets option.max_loras=30`, () => {
                const rendered = renderServingProperties({
                    modelServer,
                    enableLora: true,
                    maxLoras: 30
                });
                assert.ok(
                    rendered.includes('option.max_loras=30'),
                    `${modelServer}: Must set option.max_loras=30`
                );
            });

            it(`${modelServer}: sets option.max_cpu_loras=70`, () => {
                const rendered = renderServingProperties({
                    modelServer,
                    enableLora: true,
                    maxLoras: 30
                });
                assert.ok(
                    rendered.includes('option.max_cpu_loras=70'),
                    `${modelServer}: Must set option.max_cpu_loras=70`
                );
            });

            it(`${modelServer}: includes LoRA comment section`, () => {
                const rendered = renderServingProperties({
                    modelServer,
                    enableLora: true,
                    maxLoras: 30
                });
                assert.ok(
                    rendered.includes('# LoRA adapter serving configuration'),
                    `${modelServer}: Must include LoRA configuration comment`
                );
            });
        }
    });

    // ── enableLora absent → no LoRA configuration (Req 7.1) ─────────────

    describe('--enable-lora absent → no LoRA env vars, no do/adapter script (Req 7.1)', () => {

        it('vLLM Dockerfile: no VLLM_ENABLE_LORA when enableLora is false', () => {
            const rendered = renderDockerfile({
                modelServer: 'vllm',
                enableLora: false
            });
            assert.ok(
                !rendered.includes('VLLM_ENABLE_LORA'),
                'Must NOT contain VLLM_ENABLE_LORA when LoRA is disabled'
            );
            assert.ok(
                !rendered.includes('VLLM_MAX_LORAS'),
                'Must NOT contain VLLM_MAX_LORAS when LoRA is disabled'
            );
            assert.ok(
                !rendered.includes('VLLM_MAX_LORA_RANK'),
                'Must NOT contain VLLM_MAX_LORA_RANK when LoRA is disabled'
            );
        });

        it('SGLang Dockerfile: no SGLANG_ENABLE_LORA when enableLora is false', () => {
            const rendered = renderDockerfile({
                modelServer: 'sglang',
                enableLora: false
            });
            assert.ok(
                !rendered.includes('SGLANG_ENABLE_LORA'),
                'Must NOT contain SGLANG_ENABLE_LORA when LoRA is disabled'
            );
            assert.ok(
                !rendered.includes('SGLANG_MAX_LORAS'),
                'Must NOT contain SGLANG_MAX_LORAS when LoRA is disabled'
            );
        });

        for (const modelServer of ['lmi', 'djl']) {
            it(`${modelServer} serving.properties: no LoRA options when enableLora is false`, () => {
                const rendered = renderServingProperties({
                    modelServer,
                    enableLora: false
                });
                assert.ok(
                    !rendered.includes('option.enable_lora=true'),
                    `${modelServer}: Must NOT contain option.enable_lora=true when LoRA is disabled`
                );
                assert.ok(
                    !rendered.includes('option.max_loras='),
                    `${modelServer}: Must NOT contain option.max_loras when LoRA is disabled`
                );
                assert.ok(
                    !rendered.includes('option.max_cpu_loras='),
                    `${modelServer}: Must NOT contain option.max_cpu_loras when LoRA is disabled`
                );
            });
        }
    });

    // ── flask/fastapi → LoRA not rendered (Req 7.1) ─────────────────────
    // flask and fastapi are non-transformers model servers. The Dockerfile template
    // only renders LoRA env vars for vllm and sglang. For flask/fastapi, the
    // framework is not 'transformers', so the entire transformers Dockerfile branch
    // is skipped. This test verifies that even if enableLora were somehow true,
    // no LoRA configuration appears for unsupported model servers.

    describe('--enable-lora with flask/fastapi → no LoRA configuration (Req 7.1)', () => {

        it('flask: no LoRA env vars even if enableLora is true', () => {
            const rendered = renderDockerfile({
                framework: 'sklearn',
                modelServer: 'flask',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                !rendered.includes('VLLM_ENABLE_LORA'),
                'flask: Must NOT contain VLLM_ENABLE_LORA'
            );
            assert.ok(
                !rendered.includes('SGLANG_ENABLE_LORA'),
                'flask: Must NOT contain SGLANG_ENABLE_LORA'
            );
            assert.ok(
                !rendered.includes('LoRA adapter serving configuration'),
                'flask: Must NOT contain LoRA configuration comment'
            );
        });

        it('fastapi: no LoRA env vars even if enableLora is true', () => {
            const rendered = renderDockerfile({
                framework: 'sklearn',
                modelServer: 'fastapi',
                enableLora: true,
                maxLoras: 30,
                maxLoraRank: 64
            });
            assert.ok(
                !rendered.includes('VLLM_ENABLE_LORA'),
                'fastapi: Must NOT contain VLLM_ENABLE_LORA'
            );
            assert.ok(
                !rendered.includes('SGLANG_ENABLE_LORA'),
                'fastapi: Must NOT contain SGLANG_ENABLE_LORA'
            );
            assert.ok(
                !rendered.includes('LoRA adapter serving configuration'),
                'fastapi: Must NOT contain LoRA configuration comment'
            );
        });
    });

    // ── --max-loras override (Req 7.2) ──────────────────────────────────

    describe('--max-loras 50 overrides default 30 (Req 7.2)', () => {

        it('vLLM Dockerfile: VLLM_MAX_LORAS=50 when maxLoras is 50', () => {
            const rendered = renderDockerfile({
                modelServer: 'vllm',
                enableLora: true,
                maxLoras: 50,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('ENV VLLM_MAX_LORAS=50'),
                'Must set VLLM_MAX_LORAS=50'
            );
            assert.ok(
                !rendered.includes('ENV VLLM_MAX_LORAS=30'),
                'Must NOT contain default VLLM_MAX_LORAS=30'
            );
        });

        it('SGLang Dockerfile: SGLANG_MAX_LORAS=50 when maxLoras is 50', () => {
            const rendered = renderDockerfile({
                modelServer: 'sglang',
                enableLora: true,
                maxLoras: 50,
                maxLoraRank: 64
            });
            assert.ok(
                rendered.includes('ENV SGLANG_MAX_LORAS=50'),
                'Must set SGLANG_MAX_LORAS=50'
            );
            assert.ok(
                !rendered.includes('ENV SGLANG_MAX_LORAS=30'),
                'Must NOT contain default SGLANG_MAX_LORAS=30'
            );
        });

        for (const modelServer of ['lmi', 'djl']) {
            it(`${modelServer} serving.properties: option.max_loras=50 when maxLoras is 50`, () => {
                const rendered = renderServingProperties({
                    modelServer,
                    enableLora: true,
                    maxLoras: 50
                });
                assert.ok(
                    rendered.includes('option.max_loras=50'),
                    `${modelServer}: Must set option.max_loras=50`
                );
                assert.ok(
                    !rendered.includes('option.max_loras=30'),
                    `${modelServer}: Must NOT contain default option.max_loras=30`
                );
            });
        }
    });
});

// ── Generator output tests for do/adapter script presence (Req 7.1) ─────────

describe('Feature: lora-adapter-lifecycle — do/adapter script generation (Req 7.1)', () => {

    // ── enableLora=true → do/adapter present ─────────────────────────────

    describe('enableLora=true → do/adapter script present in output', () => {
        let result;

        beforeEach(function () {
            this.timeout(60000);
            result = runGenerator({
                'project-name': 'test-lora-enabled',
                'deployment-config': 'transformers-vllm',
                'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
                'enable-lora': true,
                'build-target': 'codebuild',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1'
            });
        });

        afterEach(() => {
            if (result) {
                result.cleanup();
            }
        });

        it('generates do/adapter script when enableLora is true', () => {
            result.assertFile('do/adapter');
        });

        it('generates do/adapters/.gitkeep when enableLora is true', () => {
            result.assertFile('do/adapters/.gitkeep');
        });
    });

    // ── enableLora=false → do/adapter absent ─────────────────────────────

    describe('enableLora=false → do/adapter script absent', () => {
        let result;

        beforeEach(function () {
            this.timeout(60000);
            result = runGenerator({
                'project-name': 'test-lora-disabled',
                'deployment-config': 'transformers-vllm',
                'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
                'build-target': 'codebuild',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1'
            });
        });

        afterEach(() => {
            if (result) {
                result.cleanup();
            }
        });

        it('does NOT generate do/adapter script when enableLora is false', () => {
            result.assertNoFile('do/adapter');
        });

        it('does NOT generate do/adapters/ directory when enableLora is false', () => {
            result.assertNoFile('do/adapters/.gitkeep');
        });
    });
});

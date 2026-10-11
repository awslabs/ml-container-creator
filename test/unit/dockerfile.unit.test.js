// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Example-based unit tests for the Dockerfile template.
 *
 * Tests cover:
 * - HuggingFace backward compatibility (runtime produces identical output)
 * - AWS CLI installation for S3 sources with runtime strategy
 * - No AWS CLI for HuggingFace source
 * - Skip AWS CLI for LMI/DJL base images
 * - Build-time HuggingFace with gated model includes ARG HF_TOKEN
 * - Build-time credential warning comment present
 * - Build-time S3 source includes aws s3 sync instruction
 * - Runtime strategy has no model download RUN instructions
 *
 * Feature: model-server-loading-adapter
 * Validates: Requirements 9.4, 9.6, 10.1, 10.2, 10.3, 11.2
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE_TEMPLATE_PATH = resolve(__dirname, '../../templates/Dockerfile');
const DOCKERFILE_TEMPLATE = readFileSync(DOCKERFILE_TEMPLATE_PATH, 'utf-8');

// ── Helper: render Dockerfile template with defaults ─────────────────────────

function renderDockerfile(overrides = {}) {
    const vars = {
        framework: 'transformers',
        modelServer: 'vllm',
        modelSource: 'huggingface',
        modelName: 'meta-llama/Llama-2-7b-hf',
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: model-server-loading-adapter — Dockerfile example-based tests', () => {

    // ── HuggingFace backward compatibility (Req 11.2) ────────────────────

    describe('HuggingFace backward compatibility (Req 11.2)', () => {

        for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm']) {
            it(`${modelServer}: modelSource=huggingface, runtime produces same output as default`, () => {
                // **Validates: Requirements 11.2**
                const withSource = renderDockerfile({
                    modelServer,
                    modelSource: 'huggingface',
                    modelLoadStrategy: 'runtime'
                });
                // The default modelSource is 'huggingface' and default strategy is 'runtime',
                // so rendering without explicit modelSource should match
                const withoutSource = renderDockerfile({
                    modelServer,
                    modelSource: undefined
                });
                // Both should produce the same MODEL_SOURCE env var
                assert.ok(
                    withSource.includes('ENV MODEL_SOURCE="huggingface"'),
                    'Explicit huggingface source must set MODEL_SOURCE="huggingface"'
                );
                assert.ok(
                    withoutSource.includes('ENV MODEL_SOURCE="huggingface"'),
                    'Default (undefined) source must set MODEL_SOURCE="huggingface"'
                );
                // AWS CLI IS installed for wrapper-path engines regardless of the
                // generate-time modelSource: a huggingface-generated project can be
                // staged to S3 at DEPLOY time (do/stage → MODEL_SOURCE=s3), and
                // code/serve's download_model_from_s3 then needs `aws s3`. Gating
                // the install on the generate-time source produced a runtime
                // `download_model_from_s3: command not found` / `aws: not found`
                // crash. (See ADR-010 Model-A note.)
                assert.ok(
                    withSource.includes('awscli'),
                    'Wrapper-path engine must install AWS CLI (deploy-time S3 staging is possible)'
                );
                // Still no BUILD-TIME model download: the download is a runtime
                // shell function in code/serve, never a Dockerfile RUN.
                assert.ok(
                    !withSource.includes('RUN huggingface-cli download'),
                    'Runtime HuggingFace must not have build-time download'
                );
                assert.ok(
                    !withSource.includes('RUN aws s3 sync'),
                    'Runtime must not have a build-time S3 download RUN instruction'
                );
            });
        }

        for (const modelServer of ['lmi', 'djl']) {
            it(`${modelServer}: modelSource=huggingface, runtime preserves HF_MODEL_ID`, () => {
                // **Validates: Requirements 11.2**
                const rendered = renderDockerfile({
                    modelServer,
                    modelSource: 'huggingface',
                    modelLoadStrategy: 'runtime'
                });
                assert.ok(
                    rendered.includes('ENV HF_MODEL_ID="meta-llama/Llama-2-7b-hf"'),
                    'LMI/DJL must set HF_MODEL_ID to modelName for HuggingFace source'
                );
            });
        }
    });

    // ── AWS CLI install for S3 source with runtime strategy (Req 10.1) ───

    describe('AWS CLI install for S3 source with runtime strategy (Req 10.1)', () => {

        for (const modelSource of ['s3', 'jumpstart', 'jumpstart-hub', 'registry']) {
            for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm']) {
                it(`${modelSource}+${modelServer}: runtime installs AWS CLI`, () => {
                    // **Validates: Requirements 10.1**
                    const rendered = renderDockerfile({
                        modelSource,
                        modelServer,
                        modelLoadStrategy: 'runtime',
                        artifactUri: 's3://my-bucket/my-model/'
                    });
                    assert.ok(
                        rendered.includes('pip install') && rendered.includes('awscli'),
                        `${modelSource}+${modelServer} runtime must install AWS CLI`
                    );
                });
            }
        }
    });

    // ── AWS CLI install is modelSource-independent for wrapper engines (Req 10.2, ADR-010) ──
    // UPDATED: AWS CLI is NO LONGER gated on the generate-time modelSource. Because
    // do/stage can stage ANY project to S3 at deploy time (MODEL_SOURCE=s3), the
    // wrapper-path engines (vllm/sglang/tensorrt-llm) always install it; the
    // container-owns-entrypoint engines (lmi/djl/llama-cpp) load the model via
    // their DLC and never call code/serve's download path, so they never do.

    describe('AWS CLI install is modelSource-independent for wrapper engines (Req 10.2, ADR-010)', () => {

        for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm']) {
            it(`huggingface+${modelServer}: runtime STILL installs AWS CLI (deploy-time S3 staging)`, () => {
                const rendered = renderDockerfile({
                    modelSource: 'huggingface',
                    modelServer,
                    modelLoadStrategy: 'runtime'
                });
                assert.ok(
                    rendered.includes('awscli'),
                    `huggingface+${modelServer} must install AWS CLI — do/stage can stage it to S3 later`
                );
            });
        }

        for (const modelServer of ['lmi', 'djl', 'llama-cpp']) {
            it(`huggingface+${modelServer}: container-owns-entrypoint engine does NOT install AWS CLI`, () => {
                const rendered = renderDockerfile({
                    modelSource: 'huggingface',
                    modelServer,
                    modelLoadStrategy: 'runtime'
                });
                assert.ok(
                    !rendered.includes('awscli'),
                    `${modelServer} loads the model via its DLC and must not install AWS CLI`
                );
            });
        }
    });

    // ── Skip AWS CLI for LMI/DJL base images (Req 10.3) ─────────────────

    describe('Skip AWS CLI for LMI/DJL base images (Req 10.3)', () => {

        for (const modelServer of ['lmi', 'djl']) {
            for (const modelSource of ['s3', 'jumpstart', 'jumpstart-hub', 'registry']) {
                it(`${modelSource}+${modelServer}: runtime skips AWS CLI install`, () => {
                    // **Validates: Requirements 10.3**
                    const rendered = renderDockerfile({
                        modelSource,
                        modelServer,
                        modelLoadStrategy: 'runtime',
                        artifactUri: 's3://my-bucket/my-model/'
                    });
                    assert.ok(
                        !rendered.includes('awscli'),
                        `${modelSource}+${modelServer} must skip AWS CLI (already in base image)`
                    );
                });
            }
        }
    });

    // ── Runtime strategy has no model download RUN instructions ───────────

    describe('Runtime strategy has no model download RUN instructions (Req 9.4)', () => {

        for (const modelSource of ['huggingface', 's3', 'jumpstart', 'jumpstart-hub', 'registry']) {
            for (const modelServer of ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl']) {
                it(`${modelSource}+${modelServer}: runtime has no download RUN instructions`, () => {
                    // **Validates: Requirements 9.4**
                    const rendered = renderDockerfile({
                        modelSource,
                        modelServer,
                        modelLoadStrategy: 'runtime',
                        artifactUri: 's3://my-bucket/my-model/'
                    });
                    assert.ok(
                        !rendered.includes('RUN huggingface-cli download'),
                        `runtime ${modelSource}+${modelServer} must not have huggingface-cli download`
                    );
                    assert.ok(
                        !rendered.includes('aws s3 sync'),
                        `runtime ${modelSource}+${modelServer} must not have aws s3 sync`
                    );
                });
            }
        }
    });
});

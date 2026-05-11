// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for Dockerfile template backward compatibility
 *
 * Tests that when baseImage is not set (null/undefined), the Dockerfile
 * template falls back to the existing hardcoded defaults.
 *
 * Feature: transformer-base-image-picker
 * Validates: Requirements 7.3, 7.4
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dockerfileTemplate = readFileSync(
    path.join(__dirname, '../../templates/Dockerfile'),
    'utf8'
);

/**
 * Minimal template variables needed to render the Dockerfile.
 */
function baseVars(overrides = {}) {
    return {
        projectName: 'test-project',
        buildTimestamp: '2025-01-01T00:00:00Z',
        framework: 'sklearn',
        modelServer: 'flask',
        modelName: 'test-model',
        modelFormat: 'pkl',
        includeSampleModel: false,
        comments: {},
        orderedEnvVars: [],
        hfToken: null,
        chatTemplate: null,
        baseImage: null,
        ...overrides
    };
}

describe('Dockerfile template backward compatibility', () => {

    describe('non-transformer fallback (Req 7.3)', () => {
        it('should render FROM public.ecr.aws/docker/library/python:3.12-slim when baseImage is null', () => {
            const output = ejs.render(dockerfileTemplate, baseVars({ baseImage: null }));
            assert.ok(output.includes('FROM public.ecr.aws/docker/library/python:3.12-slim'),
                'Should fall back to ECR Public python:3.12-slim when baseImage is null');
        });

        it('should render FROM public.ecr.aws/docker/library/python:3.12-slim when baseImage is undefined', () => {
            const output = ejs.render(dockerfileTemplate, baseVars({ baseImage: undefined }));
            assert.ok(output.includes('FROM public.ecr.aws/docker/library/python:3.12-slim'),
                'Should fall back to ECR Public python:3.12-slim when baseImage is undefined');
        });
    });

    describe('transformer fallback per model server (Req 7.4)', () => {
        const transformerDefaults = {
            vllm: 'vllm/vllm-openai:v0.10.1',
            sglang: 'lmsysorg/sglang:v0.5.4.post1',
            'tensorrt-llm': 'nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc8',
            lmi: '763104351884.dkr.ecr.us-east-1.amazonaws.com/djl-inference:0.32.0-lmi14.0.0-cu126',
            djl: 'deepjavalibrary/djl-serving:0.36.0-pytorch-gpu'
        };

        for (const [modelServer, expectedDefault] of Object.entries(transformerDefaults)) {
            it(`should render ARG BASE_IMAGE=${expectedDefault} for ${modelServer} when baseImage is null`, () => {
                const vars = baseVars({
                    framework: 'transformers',
                    modelServer,
                    baseImage: null
                });
                const output = ejs.render(dockerfileTemplate, vars);
                assert.ok(
                    output.includes(`ARG BASE_IMAGE=${expectedDefault}`),
                    `${modelServer} should fall back to ${expectedDefault} when baseImage is null`
                );
            });

            it(`should render ARG BASE_IMAGE=${expectedDefault} for ${modelServer} when baseImage is undefined`, () => {
                const vars = baseVars({
                    framework: 'transformers',
                    modelServer,
                    baseImage: undefined
                });
                const output = ejs.render(dockerfileTemplate, vars);
                assert.ok(
                    output.includes(`ARG BASE_IMAGE=${expectedDefault}`),
                    `${modelServer} should fall back to ${expectedDefault} when baseImage is undefined`
                );
            });
        }
    });
});

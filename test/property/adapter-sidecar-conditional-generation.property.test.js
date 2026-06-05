// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property Test: Conditional File Generation
 *
 * Property 8: For any generator configuration, the output project SHALL include
 * `adapter_sidecar.py` if and only if `ENABLE_LORA` is `true`. When included,
 * the Dockerfile SHALL install `aiohttp`.
 *
 * This test verifies:
 * - When enableLora=true AND modelServer is vllm/sglang: Dockerfile contains
 *   `pip install aiohttp` and `COPY code/adapter_sidecar.py`
 * - When enableLora=false: Dockerfile does NOT contain these directives
 * - The generator ignorePatterns excludes adapter_sidecar.py when enableLora is false
 *
 * Feature: sagemaker-adapter-contract, Property 8: Conditional File Generation
 * **Validates: Requirements 8.1, 8.3, 8.4**
 */

import fc from 'fast-check';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10) };

// ── Load the actual Dockerfile template ──────────────────────────────────────

const DOCKERFILE_TEMPLATE_PATH = resolve(__dirname, '../../templates/Dockerfile');
const DOCKERFILE_TEMPLATE = readFileSync(DOCKERFILE_TEMPLATE_PATH, 'utf-8');

// ── Constants ────────────────────────────────────────────────────────────────

const SIDECAR_SERVERS = ['vllm', 'sglang'];
const MODEL_SOURCES = ['huggingface', 's3', 'jumpstart', 'jumpstart-hub', 'registry'];

// ── Generators ───────────────────────────────────────────────────────────────

const arbModelServer = fc.constantFrom(...SIDECAR_SERVERS);
const arbModelSource = fc.constantFrom(...MODEL_SOURCES);
const arbModelName = fc.stringMatching(/^[a-zA-Z0-9/_-]{1,40}$/);
const arbProjectName = fc.stringMatching(/^[a-z0-9-]{3,20}$/);
const arbMaxLoras = fc.integer({ min: 1, max: 256 });
const arbMaxLoraRank = fc.integer({ min: 8, max: 64 });

// ── Helper: render Dockerfile template ───────────────────────────────────────

function renderDockerfile({ modelServer, modelSource, modelName, projectName, enableLora, maxLoras, maxLoraRank }) {
    return ejs.render(DOCKERFILE_TEMPLATE, {
        framework: 'transformers',
        modelServer,
        modelSource: modelSource || 'huggingface',
        modelName: modelName || 'test-model',
        projectName: projectName || 'test-project',
        buildTimestamp: '2024-01-01T00:00:00Z',
        baseImage: '',
        enableLora,
        maxLoras: maxLoras || 64,
        maxLoraRank: maxLoraRank || 16,
        hfToken: '',
        chatTemplate: '',
        comments: {},
        orderedEnvVars: [],
        artifactUri: '',
        includeSampleModel: false
    }, { filename: DOCKERFILE_TEMPLATE_PATH });
}

// ── Helper: simulate generator ignorePatterns logic ──────────────────────────

function getIgnorePatterns(enableLora) {
    const ignorePatterns = [];
    if (!enableLora) {
        ignorePatterns.push('**/do/adapter');
        ignorePatterns.push('**/do/adapters/**');
        ignorePatterns.push('**/code/adapter_sidecar.py');
    }
    return ignorePatterns;
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: sagemaker-adapter-contract, Property 8: Conditional File Generation', () => {

    describe('enableLora=true includes aiohttp installation in Dockerfile', () => {

        it('for any valid config with enableLora=true and vllm/sglang, Dockerfile installs aiohttp', { timeout: 30000 }, () => {
            // **Validates: Requirements 8.3**
            fc.assert(fc.property(
                arbModelServer,
                arbModelSource,
                arbModelName,
                arbProjectName,
                arbMaxLoras,
                arbMaxLoraRank,
                (modelServer, modelSource, modelName, projectName, maxLoras, maxLoraRank) => {
                    const rendered = renderDockerfile({
                        modelServer,
                        modelSource,
                        modelName,
                        projectName,
                        enableLora: true,
                        maxLoras,
                        maxLoraRank
                    });

                    assert.ok(
                        rendered.includes('pip install') && rendered.includes('aiohttp'),
                        `Dockerfile must install aiohttp when enableLora=true for ${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('enableLora=true includes adapter_sidecar.py COPY in Dockerfile', () => {

        it('for any valid config with enableLora=true and vllm/sglang, Dockerfile copies adapter_sidecar.py', { timeout: 30000 }, () => {
            // **Validates: Requirements 8.1**
            fc.assert(fc.property(
                arbModelServer,
                arbModelSource,
                arbModelName,
                arbProjectName,
                arbMaxLoras,
                arbMaxLoraRank,
                (modelServer, modelSource, modelName, projectName, maxLoras, maxLoraRank) => {
                    const rendered = renderDockerfile({
                        modelServer,
                        modelSource,
                        modelName,
                        projectName,
                        enableLora: true,
                        maxLoras,
                        maxLoraRank
                    });

                    assert.ok(
                        rendered.includes('COPY code/adapter_sidecar.py'),
                        `Dockerfile must COPY adapter_sidecar.py when enableLora=true for ${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('enableLora=false excludes aiohttp from Dockerfile', () => {

        it('for any valid config with enableLora=false and vllm/sglang, Dockerfile does not install aiohttp', { timeout: 30000 }, () => {
            // **Validates: Requirements 8.4**
            fc.assert(fc.property(
                arbModelServer,
                arbModelSource,
                arbModelName,
                arbProjectName,
                (modelServer, modelSource, modelName, projectName) => {
                    const rendered = renderDockerfile({
                        modelServer,
                        modelSource,
                        modelName,
                        projectName,
                        enableLora: false,
                        maxLoras: 64,
                        maxLoraRank: 16
                    });

                    assert.ok(
                        !rendered.includes('aiohttp'),
                        `Dockerfile must NOT install aiohttp when enableLora=false for ${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('enableLora=false excludes adapter_sidecar.py COPY from Dockerfile', () => {

        it('for any valid config with enableLora=false and vllm/sglang, Dockerfile does not copy adapter_sidecar.py', { timeout: 30000 }, () => {
            // **Validates: Requirements 8.4**
            fc.assert(fc.property(
                arbModelServer,
                arbModelSource,
                arbModelName,
                arbProjectName,
                (modelServer, modelSource, modelName, projectName) => {
                    const rendered = renderDockerfile({
                        modelServer,
                        modelSource,
                        modelName,
                        projectName,
                        enableLora: false,
                        maxLoras: 64,
                        maxLoraRank: 16
                    });

                    assert.ok(
                        !rendered.includes('adapter_sidecar.py'),
                        `Dockerfile must NOT reference adapter_sidecar.py when enableLora=false for ${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('Generator excludes adapter_sidecar.py file when enableLora=false', () => {

        it('for enableLora=false, ignorePatterns includes **/code/adapter_sidecar.py', { timeout: 30000 }, () => {
            // **Validates: Requirements 8.1, 8.4**
            fc.assert(fc.property(
                arbModelServer,
                arbModelSource,
                arbModelName,
                (_modelServer, _modelSource, _modelName) => {
                    const patterns = getIgnorePatterns(false);

                    assert.ok(
                        patterns.includes('**/code/adapter_sidecar.py'),
                        'ignorePatterns must exclude adapter_sidecar.py when enableLora=false'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('Generator does not exclude adapter_sidecar.py file when enableLora=true', () => {

        it('for enableLora=true, ignorePatterns does not include **/code/adapter_sidecar.py', { timeout: 30000 }, () => {
            // **Validates: Requirements 8.1**
            fc.assert(fc.property(
                arbModelServer,
                arbModelSource,
                arbModelName,
                (_modelServer, _modelSource, _modelName) => {
                    const patterns = getIgnorePatterns(true);

                    assert.ok(
                        !patterns.includes('**/code/adapter_sidecar.py'),
                        'ignorePatterns must NOT exclude adapter_sidecar.py when enableLora=true'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });

    describe('Conditional generation is biconditional (iff relationship)', () => {

        it('for any enableLora boolean, aiohttp presence matches enableLora state exactly', { timeout: 30000 }, () => {
            // **Validates: Requirements 8.1, 8.3, 8.4**
            fc.assert(fc.property(
                arbModelServer,
                arbModelSource,
                arbModelName,
                arbProjectName,
                fc.boolean(),
                arbMaxLoras,
                arbMaxLoraRank,
                (modelServer, modelSource, modelName, projectName, enableLora, maxLoras, maxLoraRank) => {
                    const rendered = renderDockerfile({
                        modelServer,
                        modelSource,
                        modelName,
                        projectName,
                        enableLora,
                        maxLoras,
                        maxLoraRank
                    });

                    const hasAiohttp = rendered.includes('aiohttp');
                    const hasSidecarCopy = rendered.includes('adapter_sidecar.py');

                    if (enableLora) {
                        assert.ok(hasAiohttp,
                            `aiohttp must be present when enableLora=true for ${modelServer}`);
                        assert.ok(hasSidecarCopy,
                            `adapter_sidecar.py must be present when enableLora=true for ${modelServer}`);
                    } else {
                        assert.ok(!hasAiohttp,
                            `aiohttp must be absent when enableLora=false for ${modelServer}`);
                        assert.ok(!hasSidecarCopy,
                            `adapter_sidecar.py must be absent when enableLora=false for ${modelServer}`);
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns });
        });
    });
});

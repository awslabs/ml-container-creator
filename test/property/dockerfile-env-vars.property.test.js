// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dockerfile Environment Variable Correctness Property-Based Test
 *
 * Property 4: For any modelSource value and modelServer, the rendered Dockerfile SHALL:
 * - Always contain ENV MODEL_SOURCE=<modelSource>.
 * - Contain ENV MODEL_ARTIFACT_URI=<artifactUri> if and only if artifactUri is non-empty.
 * - Continue to set the model-server-specific environment variable (VLLM_MODEL,
 *   SGLANG_MODEL_PATH, TRTLLM_MODEL, or HF_MODEL_ID) to modelName, preserving
 *   backward compatibility.
 *
 * Feature: model-server-loading-adapter, Property 4: Dockerfile environment variable correctness
 * Validates: Requirements 8.1, 8.2, 8.3
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';
import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false };

// ── Load the actual Dockerfile template ──────────────────────────────────────

const DOCKERFILE_TEMPLATE_PATH = resolve(__dirname, '../../templates/Dockerfile');
const DOCKERFILE_TEMPLATE = readFileSync(DOCKERFILE_TEMPLATE_PATH, 'utf-8');

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_SOURCES = ['huggingface', 's3', 'jumpstart', 'jumpstart-hub', 'registry'];
const MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl'];

const SERVER_ENV_VAR_MAP = {
    'vllm': 'VLLM_MODEL',
    'sglang': 'SGLANG_MODEL_PATH',
    'tensorrt-llm': 'TRTLLM_MODEL',
    'lmi': 'HF_MODEL_ID',
    'djl': 'HF_MODEL_ID'
};

// ── Generators ───────────────────────────────────────────────────────────────

const arbModelSource = fc.constantFrom(...MODEL_SOURCES);
const arbModelServer = fc.constantFrom(...MODEL_SERVERS);
const arbArtifactUri = fc.option(
    fc.stringMatching(/^s3:\/\/[a-z0-9-]{3,20}\/[a-z0-9/_-]{1,30}$/)
);
const arbModelName = fc.stringMatching(/^[a-zA-Z0-9/_-]{1,40}$/);

// ── Helper: render Dockerfile template ───────────────────────────────────────

function renderDockerfile(modelSource, modelServer, modelName, artifactUri) {
    return ejs.render(DOCKERFILE_TEMPLATE, {
        framework: 'transformers',
        modelSource,
        modelServer,
        modelName: modelName || 'test-model',
        artifactUri: artifactUri || '',
        modelLoadStrategy: 'runtime',
        projectName: 'test-project',
        buildTimestamp: '20240101',
        baseImage: null,
        hfToken: '',
        chatTemplate: '',
        comments: {},
        orderedEnvVars: [],
        includeSampleModel: false
    });
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: model-server-loading-adapter, Property 4: Dockerfile environment variable correctness', () => {

    describe('MODEL_SOURCE is always set to modelSource', () => {

        it('for any (modelSource, modelServer) tuple, the rendered Dockerfile contains ENV MODEL_SOURCE=<modelSource>', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 8.1**
            fc.assert(fc.property(
                arbModelSource,
                arbModelServer,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderDockerfile(modelSource, modelServer, modelName, artifactUri);
                    assert.ok(
                        rendered.includes(`ENV MODEL_SOURCE="${modelSource}"`),
                        `Dockerfile must contain ENV MODEL_SOURCE="${modelSource}" for ${modelServer}, got:\n${rendered.substring(0, 500)}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('MODEL_ARTIFACT_URI is set if and only if artifactUri is non-empty', () => {

        it('when artifactUri is non-empty, the rendered Dockerfile contains ENV MODEL_ARTIFACT_URI=<artifactUri>', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 8.2**
            fc.assert(fc.property(
                arbModelSource,
                arbModelServer,
                arbModelName,
                fc.stringMatching(/^s3:\/\/[a-z0-9-]{3,20}\/[a-z0-9/_-]{1,30}$/),
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderDockerfile(modelSource, modelServer, modelName, artifactUri);
                    assert.ok(
                        rendered.includes(`ENV MODEL_ARTIFACT_URI="${artifactUri}"`),
                        `Dockerfile must contain ENV MODEL_ARTIFACT_URI="${artifactUri}" when artifactUri is non-empty`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('when artifactUri is empty/null, the rendered Dockerfile does NOT contain ENV MODEL_ARTIFACT_URI', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 8.2**
            fc.assert(fc.property(
                arbModelSource,
                arbModelServer,
                arbModelName,
                (modelSource, modelServer, modelName) => {
                    const rendered = renderDockerfile(modelSource, modelServer, modelName, null);
                    assert.ok(
                        !rendered.includes('ENV MODEL_ARTIFACT_URI'),
                        `Dockerfile must NOT contain ENV MODEL_ARTIFACT_URI when artifactUri is empty for ${modelSource}/${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Model-server-specific env var is set to modelName for backward compatibility', () => {

        it('for any (modelSource, modelServer, modelName) with runtime strategy, the server-specific env var equals modelName', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 8.3**
            fc.assert(fc.property(
                arbModelSource,
                arbModelServer,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderDockerfile(modelSource, modelServer, modelName, artifactUri);
                    const envVarName = SERVER_ENV_VAR_MAP[modelServer];
                    assert.ok(
                        rendered.includes(`ENV ${envVarName}="${modelName}"`),
                        `Dockerfile must contain ENV ${envVarName}="${modelName}" for ${modelServer} with runtime strategy`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('All modelSource × modelServer combinations render without error', () => {

        it('for any valid (modelSource, modelServer, modelName, artifactUri) tuple, the template renders successfully', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource,
                arbModelServer,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderDockerfile(modelSource, modelServer, modelName, artifactUri);
                    assert.ok(
                        typeof rendered === 'string' && rendered.length > 0,
                        'Rendered output must be a non-empty string'
                    );
                    // All transformers Dockerfiles should have a FROM instruction
                    assert.ok(
                        rendered.includes('FROM'),
                        'Rendered Dockerfile must contain a FROM instruction'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

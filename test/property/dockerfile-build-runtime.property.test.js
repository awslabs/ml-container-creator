// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dockerfile Build-Time vs Runtime Rendering Property-Based Test
 *
 * Property 5: For any combination of modelSource and modelLoadStrategy,
 * the rendered Dockerfile SHALL:
 * - When modelLoadStrategy is 'build-time' AND modelSource is 'huggingface':
 *   contain a RUN huggingface-cli download instruction and set the model server
 *   env var to /opt/ml/model.
 * - When modelLoadStrategy is 'build-time' AND modelSource is s3/jumpstart/
 *   jumpstart-hub/registry with non-empty artifactUri: contain a RUN aws s3
 *   download instruction.
 * - When modelLoadStrategy is 'runtime' AND modelSource requires S3 access
 *   (s3, jumpstart, jumpstart-hub, registry): contain AWS CLI installation
 *   instructions (unless the base image is LMI/DJL which already includes it).
 * - When modelLoadStrategy is 'runtime': NOT contain any model download RUN
 *   instructions.
 *
 * Feature: model-server-loading-adapter, Property 5: Dockerfile build-time vs runtime rendering correctness
 * Validates: Requirements 9.1, 9.2, 9.3, 9.5, 9.7, 10.1, 10.2, 10.3
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
const S3_SOURCES = ['s3', 'jumpstart', 'jumpstart-hub', 'registry'];
const MODEL_SERVERS = ['vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl'];
const LOAD_STRATEGIES = ['runtime', 'build-time'];

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
const arbLoadStrategy = fc.constantFrom(...LOAD_STRATEGIES);
const arbArtifactUri = fc.option(
    fc.stringMatching(/^s3:\/\/[a-z0-9-]{3,20}\/[a-z0-9/_-]{1,30}$/)
);
const arbModelName = fc.stringMatching(/^[a-zA-Z0-9/_-]{1,40}$/);

// ── Helper: render Dockerfile template ───────────────────────────────────────

function renderDockerfile(modelSource, modelLoadStrategy, modelServer, modelName, artifactUri) {
    return ejs.render(DOCKERFILE_TEMPLATE, {
        framework: 'transformers',
        modelSource,
        modelServer,
        modelName: modelName || 'test-model',
        artifactUri: artifactUri || '',
        modelLoadStrategy,
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

describe('Feature: model-server-loading-adapter, Property 5: Dockerfile build-time vs runtime rendering correctness', () => {

    describe('Build-time + huggingface: contains huggingface-cli download and sets env var to /opt/ml/model', () => {

        it('for any modelServer, build-time + huggingface renders huggingface-cli download instruction', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 9.3, 9.5**
            fc.assert(fc.property(
                arbModelServer,
                arbModelName,
                (modelServer, modelName) => {
                    const rendered = renderDockerfile('huggingface', 'build-time', modelServer, modelName, '');
                    assert.ok(
                        rendered.includes('RUN huggingface-cli download'),
                        `build-time + huggingface must contain RUN huggingface-cli download for ${modelServer}`
                    );
                    assert.ok(
                        rendered.includes('ARG HF_TOKEN'),
                        `build-time + huggingface must contain ARG HF_TOKEN for ${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for vllm/sglang/tensorrt-llm, build-time + huggingface sets server env var to /opt/ml/model', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 9.5**
            const nonDjlServers = fc.constantFrom('vllm', 'sglang', 'tensorrt-llm');
            fc.assert(fc.property(
                nonDjlServers,
                arbModelName,
                (modelServer, modelName) => {
                    const rendered = renderDockerfile('huggingface', 'build-time', modelServer, modelName, '');
                    const envVarName = SERVER_ENV_VAR_MAP[modelServer];
                    assert.ok(
                        rendered.includes(`ENV ${envVarName}="/opt/ml/model"`),
                        `build-time + huggingface must set ${envVarName}="/opt/ml/model" for ${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Build-time + S3 sources with artifactUri: contains aws s3 sync instruction', () => {

        it('for any S3-based source with non-empty artifactUri, build-time renders aws s3 sync', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 9.1, 9.2**
            const arbS3Source = fc.constantFrom(...S3_SOURCES);
            const arbNonEmptyUri = fc.stringMatching(/^s3:\/\/[a-z0-9-]{3,20}\/[a-z0-9/_-]{1,30}$/);
            fc.assert(fc.property(
                arbS3Source,
                arbModelServer,
                arbModelName,
                arbNonEmptyUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderDockerfile(modelSource, 'build-time', modelServer, modelName, artifactUri);
                    assert.ok(
                        rendered.includes('aws s3 sync'),
                        `build-time + ${modelSource} with artifactUri must contain aws s3 sync for ${modelServer}`
                    );
                    assert.ok(
                        rendered.includes(artifactUri),
                        `build-time + ${modelSource} must reference the artifactUri ${artifactUri} in the download instruction`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Runtime + S3 sources: contains AWS CLI installation (except LMI/DJL)', () => {

        it('for non-LMI/DJL servers with S3 sources at runtime, Dockerfile installs AWS CLI', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 10.1, 10.3**
            const arbS3Source = fc.constantFrom(...S3_SOURCES);
            const arbNonDjlServer = fc.constantFrom('vllm', 'sglang', 'tensorrt-llm');
            fc.assert(fc.property(
                arbS3Source,
                arbNonDjlServer,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderDockerfile(modelSource, 'runtime', modelServer, modelName, artifactUri);
                    assert.ok(
                        rendered.includes('pip install') && rendered.includes('awscli'),
                        `runtime + ${modelSource} must install AWS CLI for ${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for LMI/DJL servers with S3 sources at runtime, Dockerfile does NOT install AWS CLI', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 10.3**
            const arbS3Source = fc.constantFrom(...S3_SOURCES);
            const arbDjlServer = fc.constantFrom('lmi', 'djl');
            fc.assert(fc.property(
                arbS3Source,
                arbDjlServer,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderDockerfile(modelSource, 'runtime', modelServer, modelName, artifactUri);
                    assert.ok(
                        !rendered.includes('pip install awscli') && !rendered.includes('awscli'),
                        `runtime + ${modelSource} must NOT install AWS CLI for ${modelServer} (already included)`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Runtime + huggingface: no AWS CLI installation', () => {

        it('for any modelServer with huggingface at runtime, Dockerfile does NOT install AWS CLI', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 10.2**
            fc.assert(fc.property(
                arbModelServer,
                arbModelName,
                (modelServer, modelName) => {
                    const rendered = renderDockerfile('huggingface', 'runtime', modelServer, modelName, '');
                    assert.ok(
                        !rendered.includes('pip install awscli') && !rendered.includes('awscli'),
                        `runtime + huggingface must NOT install AWS CLI for ${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('Runtime: no model download RUN instructions', () => {

        it('for any (modelSource, modelServer) at runtime, Dockerfile does NOT contain model download instructions', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            // **Validates: Requirements 9.7**
            fc.assert(fc.property(
                arbModelSource,
                arbModelServer,
                arbModelName,
                arbArtifactUri,
                (modelSource, modelServer, modelName, artifactUri) => {
                    const rendered = renderDockerfile(modelSource, 'runtime', modelServer, modelName, artifactUri);
                    assert.ok(
                        !rendered.includes('RUN huggingface-cli download'),
                        `runtime must NOT contain RUN huggingface-cli download for ${modelSource}/${modelServer}`
                    );
                    assert.ok(
                        !rendered.includes('aws s3 sync'),
                        `runtime must NOT contain aws s3 sync for ${modelSource}/${modelServer}`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('All (modelSource, modelLoadStrategy, modelServer) combinations render without error', () => {

        it('for any valid tuple, the template renders successfully', function () {
            this.timeout(PROPERTY_CONFIG.timeout);
            fc.assert(fc.property(
                arbModelSource,
                arbLoadStrategy,
                arbArtifactUri,
                arbModelServer,
                arbModelName,
                (modelSource, modelLoadStrategy, artifactUri, modelServer, modelName) => {
                    const rendered = renderDockerfile(modelSource, modelLoadStrategy, modelServer, modelName, artifactUri);
                    assert.ok(
                        typeof rendered === 'string' && rendered.length > 0,
                        'Rendered output must be a non-empty string'
                    );
                    assert.ok(
                        rendered.includes('FROM'),
                        'Rendered Dockerfile must contain a FROM instruction'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

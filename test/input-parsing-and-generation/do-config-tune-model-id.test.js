// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for TUNE_MODEL_ID conditional rendering in do/config template.
 *
 * Three branches:
 * 1. tuneSupported=true AND tuneModelId set → active export with flow comment
 * 2. tuneSupported=true AND tuneModelId not set → commented placeholder with guidance
 * 3. tuneSupported=false (or not transformers) → TUNE_MODEL_ID section omitted entirely
 *
 * Validates: Requirements 1.1, 1.2, 6.1-6.5
 *
 * Feature: tune-model-id-decoupling
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/config');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/config template with the given variables.
 */
function renderConfig(vars) {
    return ejs.render(templateContent, { orderedEnvVars: [], baseImage: '', ...vars });
}

/** Base config for a transformers project with realtime-inference */
const baseConfig = {
    projectName: 'test-project',
    deploymentConfig: 'transformers-vllm',
    framework: 'transformers',
    modelServer: 'vllm',
    awsRegion: 'us-west-2',
    buildTarget: 'codebuild',
    codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
    deploymentTarget: 'realtime-inference',
    instanceType: 'ml.g5.xlarge',
    inferenceAmiVersion: undefined,
    modelName: 'Qwen/Qwen3-0.6B',
    hfToken: 'hf_testtoken123',
    modelFormat: undefined,
    roleArn: undefined,
    ngcApiKey: undefined
};

describe('do/config TUNE_MODEL_ID Conditional Rendering', () => {
    before(() => {
        console.log('\n🚀 Starting do/config TUNE_MODEL_ID Conditional Rendering Tests');
        console.log('📋 Testing: Requirements 1.1, 1.2, 6.1-6.5');
        console.log('🔧 Configuration: EJS template rendering\n');
    });

    describe('Branch 1: tuneSupported=true AND tuneModelId set', () => {
        it('should render active export TUNE_MODEL_ID with the Hub content name', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: 'huggingface-reasoning-qwen3-06b'
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('export TUNE_MODEL_ID="huggingface-reasoning-qwen3-06b"'),
                'Output must contain active export TUNE_MODEL_ID with the Hub content name'
            );
        });

        it('should render the flow diagram comment', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: 'huggingface-reasoning-qwen3-06b'
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('# Flow: JumpStart model (tune)'),
                'Output must contain the flow diagram comment'
            );
            assert.ok(
                output.includes('do/adapter add'),
                'Flow comment must reference do/adapter add'
            );
        });

        it('should NOT render the commented placeholder', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: 'huggingface-reasoning-qwen3-06b'
            };

            const output = renderConfig(vars);

            assert.ok(
                !output.includes('# export TUNE_MODEL_ID=""'),
                'Output must NOT contain the commented placeholder when tuneModelId is set'
            );
        });

        it('should NOT render the guidance comment about finding Hub ID', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: 'meta-textgeneration-llama-3-1-8b'
            };

            const output = renderConfig(vars);

            assert.ok(
                !output.includes('# To find your model\'s Hub ID:'),
                'Output must NOT contain guidance comment when tuneModelId is set'
            );
        });

        it('should still render TUNE_SUPPORTED=true', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: 'huggingface-reasoning-qwen3-06b'
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('export TUNE_SUPPORTED=true'),
                'Output must contain TUNE_SUPPORTED=true'
            );
        });

        it('should still render TUNE_S3_BUCKET', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: 'huggingface-reasoning-qwen3-06b'
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('export TUNE_S3_BUCKET='),
                'Output must contain TUNE_S3_BUCKET'
            );
        });
    });

    describe('Branch 2: tuneSupported=true AND tuneModelId not set', () => {
        it('should render commented placeholder # export TUNE_MODEL_ID=""', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('# export TUNE_MODEL_ID=""'),
                'Output must contain commented placeholder when tuneModelId is null'
            );
        });

        it('should render guidance comment about finding Hub ID', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('# To find your model\'s Hub ID:'),
                'Output must contain guidance comment'
            );
            assert.ok(
                output.includes('aws sagemaker list-hub-contents'),
                'Guidance must include the aws CLI command'
            );
        });

        it('should NOT render an active export TUNE_MODEL_ID', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            // Check that there's no uncommented export TUNE_MODEL_ID line
            const lines = output.split('\n');
            const activeExportLines = lines.filter(line =>
                line.trim().startsWith('export') && line.includes('TUNE_MODEL_ID=')
            );
            assert.strictEqual(
                activeExportLines.length, 0,
                'Output must NOT contain an active export TUNE_MODEL_ID when tuneModelId is null'
            );
        });

        it('should work when tuneModelId is undefined', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: undefined
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('# export TUNE_MODEL_ID=""'),
                'Output must contain commented placeholder when tuneModelId is undefined'
            );
        });

        it('should work when tuneModelId is empty string', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: ''
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('# export TUNE_MODEL_ID=""'),
                'Output must contain commented placeholder when tuneModelId is empty string'
            );
        });

        it('should still render TUNE_SUPPORTED=true', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('export TUNE_SUPPORTED=true'),
                'Output must contain TUNE_SUPPORTED=true'
            );
        });

        it('should still render TUNE_S3_BUCKET', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: true,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('export TUNE_S3_BUCKET='),
                'Output must contain TUNE_S3_BUCKET'
            );
        });
    });

    describe('Branch 3: tuneSupported=false — TUNE_MODEL_ID section omitted', () => {
        it('should NOT render any TUNE_MODEL_ID content when tuneSupported is false', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: false,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                !output.includes('TUNE_MODEL_ID'),
                'Output must NOT contain TUNE_MODEL_ID when tuneSupported is false'
            );
        });

        it('should NOT render guidance comment when tuneSupported is false', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: false,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                !output.includes('# To find your model\'s Hub ID:'),
                'Output must NOT contain guidance comment when tuneSupported is false'
            );
        });

        it('should NOT render flow diagram comment when tuneSupported is false', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: false,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                !output.includes('# Flow: JumpStart model (tune)'),
                'Output must NOT contain flow diagram when tuneSupported is false'
            );
        });

        it('should render TUNE_SUPPORTED=false', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: false,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('export TUNE_SUPPORTED=false'),
                'Output must contain TUNE_SUPPORTED=false'
            );
        });

        it('should still render TUNE_S3_BUCKET even when tuneSupported is false', () => {
            const vars = {
                ...baseConfig,
                tuneSupported: false,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                output.includes('export TUNE_S3_BUCKET='),
                'Output must contain TUNE_S3_BUCKET (always present for non-batch-transform)'
            );
        });

        it('should omit entire tune section for batch-transform deployment target', () => {
            const vars = {
                ...baseConfig,
                deploymentTarget: 'batch-transform',
                tuneSupported: true,
                tuneModelId: 'huggingface-reasoning-qwen3-06b',
                batchInputPath: 's3://test/input/',
                batchOutputPath: 's3://test/output/',
                batchInstanceCount: 1,
                batchSplitType: 'Line',
                batchStrategy: 'MultiRecord',
                batchJoinSource: 'None',
                batchMaxConcurrentTransforms: undefined,
                batchMaxPayloadInMB: undefined
            };

            const output = renderConfig(vars);

            assert.ok(
                !output.includes('TUNE_SUPPORTED'),
                'Output must NOT contain TUNE_SUPPORTED for batch-transform'
            );
            assert.ok(
                !output.includes('TUNE_MODEL_ID'),
                'Output must NOT contain TUNE_MODEL_ID for batch-transform'
            );
            assert.ok(
                !output.includes('TUNE_S3_BUCKET'),
                'Output must NOT contain TUNE_S3_BUCKET for batch-transform'
            );
        });

        it('should omit TUNE_MODEL_ID section for non-transformers framework', () => {
            const vars = {
                ...baseConfig,
                framework: 'sklearn',
                modelServer: 'flask',
                deploymentConfig: 'sklearn-flask',
                tuneSupported: false,
                tuneModelId: null
            };

            const output = renderConfig(vars);

            assert.ok(
                !output.includes('TUNE_MODEL_ID'),
                'Output must NOT contain TUNE_MODEL_ID for non-transformers framework'
            );
            assert.ok(
                !output.includes('TUNE_SUPPORTED'),
                'Output must NOT contain TUNE_SUPPORTED for non-transformers framework'
            );
        });
    });
});

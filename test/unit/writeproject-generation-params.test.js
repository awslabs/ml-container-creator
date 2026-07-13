// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeProject } from '../../src/app.js';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '../..');
const TEMPLATE_DIR = path.join(GENERATOR_ROOT, 'templates');

describe('writeProject generation params', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-test-genparams-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const baseAnswers = {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        modelName: 'meta-llama/Llama-3-8B',
        baseImage: 'vllm/vllm-openai:v0.21.0',
        region: 'us-east-1',
        awsRegion: 'us-east-1',
        framework: 'transformers',
        modelServer: 'vllm',
        architecture: 'transformers',
        backend: 'vllm',
        destinationDir: '',
        includeBenchmark: false,
        enableLora: false,
        testTypes: ['hosted-model-endpoint'],
        icGpuCount: 1,
        icCopyCount: 1,
        icMemorySize: 16384,
        // no_build skips Dockerfile, do/build, do/push etc. (avoids missing template vars)
        no_build: true,
        container_image_uri: 'vllm/vllm-openai:v0.21.0',
        deploy_mode: 'dlc-direct',
        // Template vars required by do/config and other templates
        hfToken: null,
        hfTokenArn: null,
        ngcApiKey: null,
        ngcTokenArn: null,
        envVars: {},
        modelEnvVars: {},
        serverEnvVars: {},
        chatTemplate: null,
        chatTemplateSource: null,
        accelerator: 'gpu',
        frameworkVersion: null,
        validationLevel: 'unknown',
        configSources: [],
        recommendedInstanceTypes: [],
        roleArn: null,
        codebuildComputeType: null,
        codebuildProjectName: null,
        modelFormat: null,
        includeSampleModel: false,
        includeTesting: true,
        buildTimestamp: new Date().toISOString(),
        buildTarget: 'codebuild',
        hyperPodCluster: null,
        hyperPodNamespace: 'default',
        hyperPodReplicas: 1,
        fsxVolumeHandle: null,
        modelSource: 'huggingface',
        artifactUri: '',
        modelLoadStrategy: 'runtime',
        existingEndpointName: null,
        maxLoras: 30,
        maxLoraRank: 64,
        engine: 'vllm',
        inferenceAmiVersion: null
    };

    it('test_writes_params_file_after_success', async () => {
        const answers = { ...baseAnswers, destinationDir: tmpDir };
        await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
            skipTemplates: ['deploy_notebook_generator.py', 'do/tune', 'do/.tune_helper.py',
                'do/train', 'do/.train_helper.py', 'do/.train_build_request.py',
                'do/training/**', 'do/evaluate', 'do/.eval_helper.py',
                'do/benchmark', 'do/.benchmark_writer.py', 'do/optimize', 'do/.optimize_engine.py',
                'do/adapter', 'do/adapters/**', 'do/export', 'do/register',
                'do/ci', 'do/submit', 'do/stage', 'do/add-ic',
                'do/status', 'do/logs', 'do/test', 'do/validate',
                'do/run', 'do/push', 'do/deploy',
                'buildspec.yml', 'requirements.txt', 'PROJECT_README.md',
                'IAM_PERMISSIONS.md', 'do/README.md', 'do/manifest',
                'sample_model/**', 'test/**']
        });

        const paramsPath = path.join(tmpDir, '.mlcc-generation-params.json');
        assert.ok(fs.existsSync(paramsPath), '.mlcc-generation-params.json should exist');

        const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
        assert.ok(params.generatorVersion, 'should have generatorVersion');
        assert.ok(params.generatedAt, 'should have generatedAt');
        assert.ok(params.answers, 'should have answers');
        assert.strictEqual(params.answers.projectName, 'test-project');
    });

    it('test_redacts_hf_token', async () => {
        const answers = { ...baseAnswers, destinationDir: tmpDir, hfToken: 'hf_secret123' };
        await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
            skipTemplates: ['deploy_notebook_generator.py', 'do/tune', 'do/.tune_helper.py',
                'do/train', 'do/.train_helper.py', 'do/.train_build_request.py',
                'do/training/**', 'do/evaluate', 'do/.eval_helper.py',
                'do/benchmark', 'do/.benchmark_writer.py', 'do/optimize', 'do/.optimize_engine.py',
                'do/adapter', 'do/adapters/**', 'do/export', 'do/register',
                'do/ci', 'do/submit', 'do/stage', 'do/add-ic',
                'do/status', 'do/logs', 'do/test', 'do/validate',
                'do/run', 'do/push', 'do/deploy',
                'buildspec.yml', 'requirements.txt', 'PROJECT_README.md',
                'IAM_PERMISSIONS.md', 'do/README.md', 'do/manifest',
                'sample_model/**', 'test/**']
        });

        const paramsPath = path.join(tmpDir, '.mlcc-generation-params.json');
        const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
        assert.strictEqual(params.answers.hfToken, '[REDACTED]');
    });

    it('test_preserves_hf_token_arn', async () => {
        const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hf-token-abc123';
        const answers = { ...baseAnswers, destinationDir: tmpDir, hfTokenArn: arn };
        await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
            skipTemplates: ['deploy_notebook_generator.py', 'do/tune', 'do/.tune_helper.py',
                'do/train', 'do/.train_helper.py', 'do/.train_build_request.py',
                'do/training/**', 'do/evaluate', 'do/.eval_helper.py',
                'do/benchmark', 'do/.benchmark_writer.py', 'do/optimize', 'do/.optimize_engine.py',
                'do/adapter', 'do/adapters/**', 'do/export', 'do/register',
                'do/ci', 'do/submit', 'do/stage', 'do/add-ic',
                'do/status', 'do/logs', 'do/test', 'do/validate',
                'do/run', 'do/push', 'do/deploy',
                'buildspec.yml', 'requirements.txt', 'PROJECT_README.md',
                'IAM_PERMISSIONS.md', 'do/README.md', 'do/manifest',
                'sample_model/**', 'test/**']
        });

        const paramsPath = path.join(tmpDir, '.mlcc-generation-params.json');
        const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
        assert.strictEqual(params.answers.hfTokenArn, arn);
    });

    it('test_no_params_when_only_files', async () => {
        // onlyFiles requires the file to exist in templates, use do/config
        const answers = { ...baseAnswers, destinationDir: tmpDir, includeBenchmark: false };
        await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
            onlyFiles: ['do/config']
        });

        const paramsPath = path.join(tmpDir, '.mlcc-generation-params.json');
        assert.ok(!fs.existsSync(paramsPath), '.mlcc-generation-params.json should NOT exist with onlyFiles');
    });

    it('test_no_params_when_no_generation_params', async () => {
        const answers = { ...baseAnswers, destinationDir: tmpDir };
        await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
            noGenerationParams: true,
            skipTemplates: ['deploy_notebook_generator.py', 'do/tune', 'do/.tune_helper.py',
                'do/train', 'do/.train_helper.py', 'do/.train_build_request.py',
                'do/training/**', 'do/evaluate', 'do/.eval_helper.py',
                'do/benchmark', 'do/.benchmark_writer.py', 'do/optimize', 'do/.optimize_engine.py',
                'do/adapter', 'do/adapters/**', 'do/export', 'do/register',
                'do/ci', 'do/submit', 'do/stage', 'do/add-ic',
                'do/status', 'do/logs', 'do/test', 'do/validate',
                'do/run', 'do/push', 'do/deploy',
                'buildspec.yml', 'requirements.txt', 'PROJECT_README.md',
                'IAM_PERMISSIONS.md', 'do/README.md', 'do/manifest',
                'sample_model/**', 'test/**']
        });

        const paramsPath = path.join(tmpDir, '.mlcc-generation-params.json');
        assert.ok(!fs.existsSync(paramsPath), '.mlcc-generation-params.json should NOT exist with noGenerationParams');
    });

    it('test_gitignore_includes_generation_params', async () => {
        const answers = { ...baseAnswers, destinationDir: tmpDir };
        await writeProject(TEMPLATE_DIR, tmpDir, answers, null, {}, null, {
            skipTemplates: ['deploy_notebook_generator.py', 'do/tune', 'do/.tune_helper.py',
                'do/train', 'do/.train_helper.py', 'do/.train_build_request.py',
                'do/training/**', 'do/evaluate', 'do/.eval_helper.py',
                'do/benchmark', 'do/.benchmark_writer.py', 'do/optimize', 'do/.optimize_engine.py',
                'do/adapter', 'do/adapters/**', 'do/export', 'do/register',
                'do/ci', 'do/submit', 'do/stage', 'do/add-ic',
                'do/status', 'do/logs', 'do/test', 'do/validate',
                'do/run', 'do/push', 'do/deploy',
                'buildspec.yml', 'requirements.txt', 'PROJECT_README.md',
                'IAM_PERMISSIONS.md', 'do/README.md', 'do/manifest',
                'sample_model/**', 'test/**']
        });

        const gitignorePath = path.join(tmpDir, '.gitignore');
        assert.ok(fs.existsSync(gitignorePath), '.gitignore should exist');
        const content = fs.readFileSync(gitignorePath, 'utf8');
        assert.ok(content.includes('.mlcc-generation-params.json'), '.gitignore should contain .mlcc-generation-params.json');
    });
});

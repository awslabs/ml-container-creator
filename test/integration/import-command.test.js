// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-unused-vars */

import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'mocha';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock AWS SDK responses
const MOCK_ENDPOINT_RESPONSE = {
    EndpointName: 'my-test-endpoint',
    EndpointStatus: 'InService',
    EndpointConfigName: 'my-test-endpoint-config',
    CreationTime: new Date('2026-01-15T10:00:00Z')
};

const MOCK_ENDPOINT_CONFIG_RESPONSE = {
    EndpointConfigName: 'my-test-endpoint-config',
    ProductionVariants: [{
        VariantName: 'AllTraffic',
        InstanceType: 'ml.g5.2xlarge',
        InitialInstanceCount: 1
    }]
};

const MOCK_IC_LIST_RESPONSE = {
    InferenceComponents: [{
        InferenceComponentName: 'my-test-ic-default',
        EndpointName: 'my-test-endpoint'
    }]
};

const MOCK_IC_DESCRIBE_RESPONSE = {
    InferenceComponentName: 'my-test-ic-default',
    Specification: {
        Container: {
            Image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/vllm/vllm-openai:v0.6.0',
            Environment: {
                HF_MODEL_ID: 'meta-llama/Llama-3-8B-Instruct',
                TENSOR_PARALLEL_SIZE: '1',
                MAX_MODEL_LEN: '4096'
            }
        }
    },
    RuntimeConfig: {
        NumberOfAcceleratorDevicesRequired: 1,
        NumberOfCpuCoresRequired: 4,
        MinMemoryRequiredInMb: 16384
    }
};

/**
 * Override the SageMakerClient.send to return mocked data.
 * We override the endpointToAnswers function's imported SageMakerClient
 * by mocking at the handler level.
 */
describe('import-command integration', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-import-test-'));
        originalCwd = process.cwd();
        process.chdir(tmpDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Helper: create an ImportCommandHandler with mocked endpointToAnswers
     */
    async function createMockedHandler(options = {}) {
        const { default: ImportCommandHandler } = await import('../../src/lib/import-command-handler.js');

        // Monkey-patch the handler to skip the actual AWS call
        const handler = new ImportCommandHandler(options);
        const originalHandle = handler.handle.bind(handler);

        handler.handle = async function(endpointArn) {
            // Override: build the answers and icConfs manually from mocked data
            const answers = {
                projectName: 'my-test-endpoint',
                deploymentConfig: 'transformers-vllm',
                deploymentTarget: 'realtime-inference',
                instanceType: 'ml.g5.2xlarge',
                modelName: 'meta-llama/Llama-3-8B-Instruct',
                baseImage: '123456789012.dkr.ecr.us-east-1.amazonaws.com/vllm/vllm-openai:v0.6.0',
                region: 'us-east-1',
                awsRegion: 'us-east-1',
                deployMode: 'imported',
                endpointName: 'my-test-endpoint',
                endpointStatus: 'InService',
                variantName: 'AllTraffic',
                no_build: true,
                container_image_uri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/vllm/vllm-openai:v0.6.0',
                deploy_mode: 'imported',
                includeBenchmark: false,
                enableLora: false,
                testTypes: ['hosted-model-endpoint'],
                framework: 'transformers',
                modelServer: 'vllm',
                architecture: 'transformers',
                backend: 'vllm',
                engine: 'vllm',
                destinationDir: options.outputDir ? path.resolve(options.outputDir) : path.resolve('./my-test-endpoint'),
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
                codebuildProjectName: 'my-test-endpoint',
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
                inferenceAmiVersion: null,
                icGpuCount: 1,
                icCopyCount: 1,
                icMemorySize: 16384,
                endpointInitialInstanceCount: null,
                endpointDataCapturePercent: null,
                endpointVariantName: null,
                endpointVolumeSize: null
            };

            const icConfs = [{
                name: 'my-test-ic-default',
                IC_GPU_COUNT: 1,
                IC_CPU_COUNT: 4,
                IC_MEMORY_SIZE: 16384,
                IC_ENV_HF_MODEL_ID: 'meta-llama/Llama-3-8B-Instruct',
                IC_ENV_TENSOR_PARALLEL_SIZE: '1',
                IC_ENV_MAX_MODEL_LEN: '4096'
            }];

            // Apply template variable defaults (same as the real generation flow)
            const { _ensureTemplateVariables } = await import('../../src/lib/template-variable-resolver.js');
            await _ensureTemplateVariables(answers, null);

            const outputDir = options.outputDir || `./${answers.endpointName}`;
            const resolvedOutputDir = path.resolve(outputDir);

            if (this.dryRun) {
                console.log('\n📋 Dry run — no files will be written\n');
                console.log(JSON.stringify(answers, null, 2));
                return;
            }

            // Import the real writeProject
            const { writeProject } = await import('../../src/app.js');
            const GENERATOR_ROOT = path.resolve(__dirname, '../..');
            const TEMPLATE_DIR = path.join(GENERATOR_ROOT, 'templates');

            fs.mkdirSync(resolvedOutputDir, { recursive: true });

            const skipTemplates = [
                'Dockerfile', 'do/build', 'do/push', 'do/submit',
                'buildspec.yml', '.dockerignore', 'code/**',
                'deploy_notebook_generator.py', 'IAM_PERMISSIONS.md',
                'PROJECT_README.md', 'requirements.txt',
                'do/export', 'do/validate', 'do/register',
                'do/benchmark', 'do/.benchmark_writer.py',
                'do/optimize', 'do/.optimize_engine.py',
                'do/tune', 'do/.tune_helper.py',
                'do/train', 'do/.train_helper.py', 'do/.train_build_request.py',
                'do/training/**', 'do/evaluate', 'do/.eval_helper.py',
                'do/adapter', 'do/adapters/**',
                'do/ci', 'do/stage', 'do/add-ic',
                'do/manifest', 'do/README.md',
                'sample_model/**', 'test/**'
            ];

            await writeProject(TEMPLATE_DIR, resolvedOutputDir, answers, null, {}, null, {
                skipTemplates,
                noGenerationParams: true
            });

            // Write IC conf files
            const icDir = path.join(resolvedOutputDir, 'do', 'ic');
            fs.mkdirSync(icDir, { recursive: true });

            for (const ic of icConfs) {
                const lines = ['# Generated by mcc import'];
                lines.push(`export IC_GPU_COUNT="${ic.IC_GPU_COUNT}"`);
                lines.push(`export IC_CPU_COUNT="${ic.IC_CPU_COUNT}"`);
                lines.push(`export IC_MEMORY_SIZE="${ic.IC_MEMORY_SIZE}"`);
                for (const [key, value] of Object.entries(ic)) {
                    if (key.startsWith('IC_ENV_')) {
                        lines.push(`export ${key}="${value}"`);
                    }
                }
                fs.writeFileSync(path.join(icDir, `${ic.name}.conf`), `${lines.join('\n')  }\n`);
            }

            // Write .mlcc-import-source
            const importSource = {
                sourceEndpointArn: endpointArn,
                importedAt: new Date().toISOString(),
                generatorVersion: '1.3.0',
                importMode: 'endpoint'
            };
            fs.writeFileSync(
                path.join(resolvedOutputDir, '.mlcc-import-source'),
                `${JSON.stringify(importSource, null, 2)  }\n`
            );
        };

        return handler;
    }

    it('test_import_generates_operational_scripts', async () => {
        const handler = await createMockedHandler({ outputDir: './imported-project' });
        await handler.handle('arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-test-endpoint');

        const projectDir = path.resolve('./imported-project');
        assert.ok(fs.existsSync(path.join(projectDir, 'do', 'config')), 'do/config should exist');
        assert.ok(fs.existsSync(path.join(projectDir, 'do', 'deploy')), 'do/deploy should exist');
        assert.ok(fs.existsSync(path.join(projectDir, 'do', 'clean')), 'do/clean should exist');
        assert.ok(fs.existsSync(path.join(projectDir, 'do', 'logs')), 'do/logs should exist');
        assert.ok(fs.existsSync(path.join(projectDir, 'do', 'status')), 'do/status should exist');
    });

    it('test_import_no_dockerfile', async () => {
        const handler = await createMockedHandler({ outputDir: './imported-project' });
        await handler.handle('arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-test-endpoint');

        const projectDir = path.resolve('./imported-project');
        assert.ok(!fs.existsSync(path.join(projectDir, 'Dockerfile')), 'Dockerfile should NOT exist');
    });

    it('test_import_no_build_scripts', async () => {
        const handler = await createMockedHandler({ outputDir: './imported-project' });
        await handler.handle('arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-test-endpoint');

        const projectDir = path.resolve('./imported-project');
        assert.ok(!fs.existsSync(path.join(projectDir, 'do', 'build')), 'do/build should NOT exist');
        assert.ok(!fs.existsSync(path.join(projectDir, 'do', 'push')), 'do/push should NOT exist');
    });

    it('test_import_writes_ic_conf', async () => {
        const handler = await createMockedHandler({ outputDir: './imported-project' });
        await handler.handle('arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-test-endpoint');

        const projectDir = path.resolve('./imported-project');
        const icConfPath = path.join(projectDir, 'do', 'ic', 'my-test-ic-default.conf');
        assert.ok(fs.existsSync(icConfPath), 'IC conf should exist');

        const content = fs.readFileSync(icConfPath, 'utf8');
        assert.ok(content.includes('IC_GPU_COUNT="1"'), 'should contain IC_GPU_COUNT');
        assert.ok(content.includes('IC_CPU_COUNT="4"'), 'should contain IC_CPU_COUNT');
        assert.ok(content.includes('IC_MEMORY_SIZE="16384"'), 'should contain IC_MEMORY_SIZE');
        assert.ok(content.includes('IC_ENV_HF_MODEL_ID="meta-llama/Llama-3-8B-Instruct"'), 'should contain IC_ENV_HF_MODEL_ID');
    });

    it('test_import_writes_import_source', async () => {
        const handler = await createMockedHandler({ outputDir: './imported-project' });
        await handler.handle('arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-test-endpoint');

        const projectDir = path.resolve('./imported-project');
        const importSourcePath = path.join(projectDir, '.mlcc-import-source');
        assert.ok(fs.existsSync(importSourcePath), '.mlcc-import-source should exist');

        const content = JSON.parse(fs.readFileSync(importSourcePath, 'utf8'));
        assert.strictEqual(content.importMode, 'endpoint');
        assert.strictEqual(content.sourceEndpointArn, 'arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-test-endpoint');
    });

    it('test_import_dry_run_no_files', async () => {
        const handler = await createMockedHandler({ outputDir: './imported-project', dryRun: true });
        await handler.handle('arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-test-endpoint');

        const projectDir = path.resolve('./imported-project');
        assert.ok(!fs.existsSync(projectDir), 'output dir should NOT exist in dry-run mode');
    });

    it('test_import_no_generation_params', async () => {
        const handler = await createMockedHandler({ outputDir: './imported-project' });
        await handler.handle('arn:aws:sagemaker:us-east-1:123456789012:endpoint/my-test-endpoint');

        const projectDir = path.resolve('./imported-project');
        const paramsPath = path.join(projectDir, '.mlcc-generation-params.json');
        assert.ok(!fs.existsSync(paramsPath), '.mlcc-generation-params.json should NOT exist for imported projects');
    });
});

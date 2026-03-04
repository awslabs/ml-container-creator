// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import path from 'path';
import assert from 'yeoman-assert';
import helpers from 'yeoman-test';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('generator-ml-container-creator:app', () => {
    // Note: With do-framework integration, ALL template files are now generated unconditionally.
    // Runtime scripts (in do/ directory) handle conditional logic based on deployment configuration.
    
    describe('sklearn project generation with do-framework', () => {
        beforeEach(async () => {
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withPrompts({
                    projectName: 'test-sklearn-project',
                    destinationDir: './test-sklearn-project',
                    deploymentConfig: 'sklearn-flask',
                    modelFormat: 'pkl',
                    includeSampleModel: true,
                    includeTesting: true,
                    testTypes: ['local-model-cli', 'local-model-server'],
                    deployTarget: 'sagemaker',
                    instanceType: 'ml.m5.large',
                    awsRegion: 'us-east-1',
                    awsRoleArn: ''
                });
        });

        it('creates expected core files', () => {
            assert.file([
                'Dockerfile',
                'requirements.txt',
                'nginx.conf',
                'code/model_handler.py',
                'code/serve.py'
            ]);
        });

        it('creates do-framework scripts', () => {
            assert.file([
                'do/config',
                'do/build',
                'do/push',
                'do/deploy',
                'do/run',
                'do/test',
                'do/clean',
                'do/README.md'
            ]);
        });

        it('creates legacy wrapper scripts for backward compatibility', () => {
            assert.file([
                'deploy/build_and_push.sh',
                'deploy/deploy.sh'
            ]);
        });

        it('creates sample model files when requested', () => {
            assert.file([
                'sample_model/train_abalone.py',
                'sample_model/test_inference.py'
            ]);
        });

        it('creates test files when requested', () => {
            assert.file([
                'test/test_local_image.sh',
                'test/test_model_handler.py',
                'test/test_endpoint.sh'
            ]);
        });

        it('creates Flask-specific files', () => {
            assert.file([
                'code/flask/wsgi.py',
                'code/flask/gunicorn_config.py'
            ]);
        });

        it('creates all template files (no exclusions)', () => {
            // With do-framework, all files are generated
            assert.file([
                'code/serve',  // Transformer file also generated
                'code/model_handler.py'  // Traditional ML file also generated
            ]);
        });
    });

    describe('transformers project generation with do-framework', () => {
        beforeEach(async () => {
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withPrompts({
                    projectName: 'test-transformer-project',
                    destinationDir: './test-transformer-project',
                    deploymentConfig: 'transformers-vllm',
                    modelName: 'meta-llama/Llama-2-7b-hf',
                    modelProfile: null,
                    includeSampleModel: false,
                    includeTesting: true,
                    testTypes: ['hosted-model-endpoint'],
                    deployTarget: 'sagemaker',
                    instanceType: 'ml.g5.xlarge',
                    awsRegion: 'us-east-1',
                    awsRoleArn: ''
                });
        });

        it('creates expected core files', () => {
            assert.file([
                'Dockerfile',
                'code/serve'
            ]);
        });

        it('creates do-framework scripts', () => {
            assert.file([
                'do/config',
                'do/build',
                'do/push',
                'do/deploy',
                'do/run',
                'do/test',
                'do/clean',
                'do/README.md'
            ]);
        });

        it('creates legacy wrapper scripts', () => {
            assert.file([
                'deploy/build_and_push.sh',
                'deploy/deploy.sh'
            ]);
        });

        it('creates all template files (no exclusions)', () => {
            // With do-framework, all files are generated
            assert.file([
                'code/model_handler.py',  // Traditional ML file also generated
                'code/serve.py',  // Traditional ML file also generated
                'code/serve'  // Transformer file also generated
            ]);
        });

        it('does not create sample model (transformers do not support sample models)', () => {
            assert.noFile([
                'sample_model/train_abalone.py',
                'sample_model/test_inference.py'
            ]);
        });
    });

    describe('minimal project generation with do-framework', () => {
        beforeEach(async () => {
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withPrompts({
                    projectName: 'minimal-project',
                    destinationDir: './minimal-project',
                    deploymentConfig: 'xgboost-fastapi',
                    modelFormat: 'json',
                    includeSampleModel: false,
                    includeTesting: false,
                    deployTarget: 'sagemaker',
                    instanceType: 'ml.m5.large',
                    awsRegion: 'us-east-1',
                    awsRoleArn: ''
                });
        });

        it('creates essential files', () => {
            assert.file([
                'Dockerfile',
                'requirements.txt',
                'nginx.conf',
                'code/model_handler.py',
                'code/serve.py'
            ]);
        });

        it('creates do-framework scripts', () => {
            assert.file([
                'do/config',
                'do/build',
                'do/push',
                'do/deploy',
                'do/run',
                'do/test',
                'do/clean',
                'do/README.md'
            ]);
        });

        it('excludes optional modules when not selected', () => {
            assert.noFile([
                'sample_model/train_abalone.py',
                'test/test_local_image.sh'
            ]);
        });

        it('creates all code template files (no exclusions)', () => {
            // With do-framework, all code files are generated
            assert.file([
                'code/model_handler.py',
                'code/serve.py',
                'code/serve',
                'code/flask/wsgi.py'  // Even Flask files are generated for FastAPI
            ]);
        });
    });

    describe('backward compatibility with separate framework and modelServer', () => {
        beforeEach(async () => {
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withPrompts({
                    projectName: 'backward-compat-project',
                    destinationDir: './backward-compat-project',
                    framework: 'sklearn',
                    modelServer: 'flask',
                    modelFormat: 'pkl',
                    includeSampleModel: false,
                    includeTesting: false,
                    deployTarget: 'sagemaker',
                    instanceType: 'ml.m5.large',
                    awsRegion: 'us-east-1',
                    awsRoleArn: ''
                });
        });

        it('creates do-framework scripts even with old prompt format', () => {
            assert.file([
                'do/config',
                'do/build',
                'do/push',
                'do/deploy',
                'do/run',
                'do/test',
                'do/clean',
                'do/README.md'
            ]);
        });

        it('creates all necessary files', () => {
            assert.file([
                'Dockerfile',
                'requirements.txt',
                'code/model_handler.py',
                'code/serve.py',
                'deploy/build_and_push.sh',
                'deploy/deploy.sh'
            ]);
        });
    });
});
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import path from 'path';
import assert from 'yeoman-assert';
import helpers from 'yeoman-test';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('@aws/generator-ml-container-creator:app', () => {
    // Note: With do-framework integration, ALL template files are now generated unconditionally.
    // Runtime scripts (in do/ directory) handle conditional logic based on deployment configuration.
    
    describe('sklearn project generation with do-framework', () => {
        beforeEach(async function () {
            this.timeout(60000);
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'test-sklearn-project',
                    'deployment-config': 'http-flask',
                    'model-format': 'pkl',
                    'include-sample': true,
                    'include-testing': true,
                    'build-target': 'codebuild',
                    'instance-type': 'ml.m5.large',
                    'region': 'us-east-1'
                });
        });

        it('creates expected core files', () => {
            assert.file([
                'Dockerfile',
                'requirements.txt',
                'nginx-predictors.conf',
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

        it('excludes transformer-specific files for non-transformer projects', () => {
            assert.noFile([
                'code/chat_template.jinja',
                'code/serve',
                'code/serving.properties',
                'code/start_server.sh'
            ]);
        });
    });

    describe('transformers project generation with do-framework', () => {
        beforeEach(async function () {
            this.timeout(60000);
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'test-transformer-project',
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'meta-llama/Llama-2-7b-hf',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
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

        it('creates transformer-specific files', () => {
            assert.file([
                'code/serve',
                'code/chat_template.jinja',
                'code/serving.properties',
                'code/start_server.sh'
            ]);
        });

        it('excludes traditional ML files for transformer projects', () => {
            assert.noFile([
                'code/model_handler.py',
                'code/serve.py',
                'code/start_server.py',
                'nginx-predictors.conf'
            ]);
        });

        it('serve script contains source-aware model resolution logic', () => {
            assert.fileContent('code/serve', 'MODEL_SOURCE');
            assert.fileContent('code/serve', 'resolve_model');
            assert.fileContent('code/serve', '/opt/ml/model');
        });

        it('serve script does not contain old prefix-stripping block', () => {
            assert.noFileContent('code/serve', 'jumpstart://*');
            assert.noFileContent('code/serve', 'jumpstart-hub://*');
            assert.noFileContent('code/serve', 'registry://*');
            assert.noFileContent('code/serve', '_BARE_ID');
        });

        it('does not create sample model (transformers do not support sample models)', () => {
            assert.noFile([
                'sample_model/train_abalone.py',
                'sample_model/test_inference.py'
            ]);
        });
    });

    describe('minimal project generation with do-framework', () => {
        beforeEach(async function () {
            this.timeout(60000);
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'minimal-project',
                    'deployment-config': 'http-fastapi',
                    'model-format': 'json',
                    'include-sample': false,
                    'include-testing': false,
                    'build-target': 'codebuild',
                    'instance-type': 'ml.m5.large',
                    'region': 'us-east-1'
                });
        });

        it('creates essential files', () => {
            assert.file([
                'Dockerfile',
                'requirements.txt',
                'nginx-predictors.conf',
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
                'sample_model/train_abalone.py'
            ]);
        });

        it('excludes transformer-specific and flask-specific files', () => {
            // Non-transformer + non-flask project should not have these files
            assert.noFile([
                'code/chat_template.jinja',
                'code/serve',
                'code/serving.properties',
                'code/start_server.sh',
                'code/flask/wsgi.py',
                'code/flask/gunicorn_config.py'
            ]);
        });
    });

    describe('backward compatibility with separate framework and modelServer', () => {
        beforeEach(async function () {
            this.timeout(60000);
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'backward-compat-project',
                    'deployment-config': 'http-flask',
                    'model-format': 'pkl',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.m5.large',
                    'region': 'us-east-1'
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

    describe('transformers project with jumpstart:// model name', () => {
        beforeEach(async function () {
            this.timeout(60000);
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'test-jumpstart-project',
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'jumpstart://huggingface-reasoning-qwen3-14b',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
        });

        it('Dockerfile sets VLLM_MODEL to the jumpstart URI', () => {
            assert.fileContent('Dockerfile', 'VLLM_MODEL="jumpstart://huggingface-reasoning-qwen3-14b"');
        });

        it('serve script uses source-aware model resolution at runtime', () => {
            assert.fileContent('code/serve', 'MODEL_SOURCE');
            assert.fileContent('code/serve', 'resolve_model');
            assert.fileContent('code/serve', '/opt/ml/model');
        });
    });

    describe('transformers project with sglang and jumpstart:// model name', () => {
        beforeEach(async function () {
            this.timeout(60000);
            await helpers.run(path.join(__dirname, '../generators/app'))
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'test-sglang-jumpstart',
                    'deployment-config': 'transformers-sglang',
                    'model-name': 'jumpstart://huggingface-reasoning-qwen3-14b',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
        });

        it('serve script uses source-aware model resolution for SGLang', () => {
            assert.fileContent('code/serve', 'SGLANG_MODEL_PATH');
            assert.fileContent('code/serve', 'resolve_model');
            assert.fileContent('code/serve', '/opt/ml/model');
        });
    });
});
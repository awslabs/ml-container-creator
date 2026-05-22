// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import fs from 'fs';
import { runGenerator } from './helpers/run-generator.js';

/**
 * Assert that a file does NOT contain the specified content.
 * Uses the result object's file() method to resolve paths.
 */
function assertNoFileContent(result, file, content) {
    const fullPath = result.file(file);
    assert.ok(fs.existsSync(fullPath), `Expected file to exist: ${file}`);
    const fileContent = fs.readFileSync(fullPath, 'utf8');
    if (content instanceof RegExp) {
        assert.ok(!content.test(fileContent), `Expected file ${file} NOT to match ${content}`);
    } else {
        assert.ok(!fileContent.includes(content), `Expected file ${file} NOT to contain: "${content}"`);
    }
}

describe('@aws/ml-container-creator:app', () => {
    // Note: With do-framework integration, ALL template files are now generated unconditionally.
    // Runtime scripts (in do/ directory) handle conditional logic based on deployment configuration.

    describe('sklearn project generation with do-framework', () => {
        let result;

        beforeEach(function () {
            this.timeout(60000);
            result = runGenerator({
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

        afterEach(() => {
            if (result) {
                result.cleanup();
            }
        });

        it('creates expected core files', () => {
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('nginx-predictors.conf');
            result.assertFile('code/model_handler.py');
            result.assertFile('code/serve.py');
        });

        it('creates do-framework scripts', () => {
            result.assertFile('do/config');
            result.assertFile('do/build');
            result.assertFile('do/push');
            result.assertFile('do/deploy');
            result.assertFile('do/run');
            result.assertFile('do/test');
            result.assertFile('do/clean');
            result.assertFile('do/README.md');
        });

        it('does not create legacy deploy/ scripts', () => {
            result.assertNoFile('deploy/build_and_push.sh');
            result.assertNoFile('deploy/deploy.sh');
        });

        it('creates sample model files when requested', () => {
            result.assertFile('sample_model/train_abalone.py');
            result.assertFile('sample_model/test_inference.py');
        });

        it('creates test files when requested', () => {
            result.assertFile('test/test_local_image.sh');
            result.assertFile('test/test_model_handler.py');
            result.assertFile('test/test_endpoint.sh');
        });

        it('creates Flask-specific files', () => {
            result.assertFile('code/flask/wsgi.py');
            result.assertFile('code/flask/gunicorn_config.py');
        });

        it('excludes transformer-specific files for non-transformer projects', () => {
            result.assertNoFile('code/chat_template.jinja');
            result.assertNoFile('code/serve');
            result.assertNoFile('code/serving.properties');
            result.assertNoFile('code/start_server.sh');
        });
    });

    describe('transformers project generation with do-framework', () => {
        let result;

        beforeEach(function () {
            this.timeout(60000);
            result = runGenerator({
                'project-name': 'test-transformer-project',
                'deployment-config': 'transformers-vllm',
                'model-name': 'meta-llama/Llama-2-7b-hf',
                'build-target': 'codebuild',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1'
            });
        });

        afterEach(() => {
            if (result) {
                result.cleanup();
            }
        });

        it('creates expected core files', () => {
            result.assertFile('Dockerfile');
            result.assertFile('code/serve');
        });

        it('creates do-framework scripts', () => {
            result.assertFile('do/config');
            result.assertFile('do/build');
            result.assertFile('do/push');
            result.assertFile('do/deploy');
            result.assertFile('do/run');
            result.assertFile('do/test');
            result.assertFile('do/clean');
            result.assertFile('do/README.md');
        });

        it('does not create legacy deploy/ scripts', () => {
            result.assertNoFile('deploy/build_and_push.sh');
            result.assertNoFile('deploy/deploy.sh');
        });

        it('creates transformer-specific files', () => {
            result.assertFile('code/serve');
            result.assertFile('code/chat_template.jinja');
            result.assertFile('code/serving.properties');
            result.assertFile('code/start_server.sh');
        });

        it('excludes traditional ML files for transformer projects', () => {
            result.assertNoFile('code/model_handler.py');
            result.assertNoFile('code/serve.py');
            result.assertNoFile('code/start_server.py');
            result.assertNoFile('nginx-predictors.conf');
        });

        it('serve script contains source-aware model resolution logic', () => {
            result.assertFileContent('code/serve', 'MODEL_SOURCE');
            result.assertFileContent('code/serve', 'resolve_model');
            result.assertFileContent('code/serve', '/opt/ml/model');
        });

        it('serve script does not contain old prefix-stripping block', () => {
            assertNoFileContent(result, 'code/serve', 'jumpstart://*');
            assertNoFileContent(result, 'code/serve', 'jumpstart-hub://*');
            assertNoFileContent(result, 'code/serve', 'registry://*');
            assertNoFileContent(result, 'code/serve', '_BARE_ID');
        });

        it('does not create sample model (transformers do not support sample models)', () => {
            result.assertNoFile('sample_model/train_abalone.py');
            result.assertNoFile('sample_model/test_inference.py');
        });
    });

    describe('minimal project generation with do-framework', () => {
        let result;

        beforeEach(function () {
            this.timeout(60000);
            result = runGenerator({
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

        afterEach(() => {
            if (result) {
                result.cleanup();
            }
        });

        it('creates essential files', () => {
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('nginx-predictors.conf');
            result.assertFile('code/model_handler.py');
            result.assertFile('code/serve.py');
        });

        it('creates do-framework scripts', () => {
            result.assertFile('do/config');
            result.assertFile('do/build');
            result.assertFile('do/push');
            result.assertFile('do/deploy');
            result.assertFile('do/run');
            result.assertFile('do/test');
            result.assertFile('do/clean');
            result.assertFile('do/README.md');
        });

        it('excludes optional modules when not selected', () => {
            result.assertNoFile('sample_model/train_abalone.py');
        });

        it('excludes transformer-specific and flask-specific files', () => {
            // Non-transformer + non-flask project should not have these files
            result.assertNoFile('code/chat_template.jinja');
            result.assertNoFile('code/serve');
            result.assertNoFile('code/serving.properties');
            result.assertNoFile('code/start_server.sh');
            result.assertNoFile('code/flask/wsgi.py');
            result.assertNoFile('code/flask/gunicorn_config.py');
        });
    });

    describe('backward compatibility with separate framework and modelServer', () => {
        let result;

        beforeEach(function () {
            this.timeout(60000);
            result = runGenerator({
                'project-name': 'backward-compat-project',
                'deployment-config': 'http-flask',
                'model-format': 'pkl',
                'build-target': 'codebuild',
                'instance-type': 'ml.m5.large',
                'region': 'us-east-1'
            });
        });

        afterEach(() => {
            if (result) {
                result.cleanup();
            }
        });

        it('creates do-framework scripts even with old prompt format', () => {
            result.assertFile('do/config');
            result.assertFile('do/build');
            result.assertFile('do/push');
            result.assertFile('do/deploy');
            result.assertFile('do/run');
            result.assertFile('do/test');
            result.assertFile('do/clean');
            result.assertFile('do/README.md');
        });

        it('creates all necessary files', () => {
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('code/model_handler.py');
            result.assertFile('code/serve.py');
        });
    });

    describe('transformers project with jumpstart:// model name', () => {
        it('should reject jumpstart:// model names', function () {
            this.timeout(60000);
            try {
                runGenerator({
                    'project-name': 'test-jumpstart-project',
                    'deployment-config': 'transformers-vllm',
                    'model-name': 'jumpstart://huggingface-reasoning-qwen3-14b',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
                assert.fail('Should have rejected jumpstart:// model name');
            } catch (error) {
                assert.ok(error.stderr.includes('JumpStart') || error.exitCode !== 0,
                    'jumpstart:// model names should be rejected');
            }
        });
    });

    describe('transformers project with sglang and jumpstart:// model name', () => {
        it('should reject jumpstart:// model names', function () {
            this.timeout(60000);
            try {
                runGenerator({
                    'project-name': 'test-sglang-jumpstart',
                    'deployment-config': 'transformers-sglang',
                    'model-name': 'jumpstart://huggingface-reasoning-qwen3-14b',
                    'build-target': 'codebuild',
                    'instance-type': 'ml.g5.xlarge',
                    'region': 'us-east-1'
                });
                assert.fail('Should have rejected jumpstart:// model name');
            } catch (error) {
                assert.ok(error.stderr.includes('JumpStart') || error.exitCode !== 0,
                    'jumpstart:// model names should be rejected');
            }
        });
    });
});

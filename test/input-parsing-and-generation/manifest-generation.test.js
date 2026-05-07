// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for manifest generation.
 *
 * Verifies that the generator produces `do/manifest`, `do/lib/` modules,
 * and that deploy/push/submit/clean templates contain `./do/manifest` calls.
 *
 * Validates: Requirements 3.8, 4.5, 9.1
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatesDir = path.join(__dirname, '../../templates');
const libDir = path.join(__dirname, '../../src/lib');

// Load templates used by the tests
const deployTemplate = readFileSync(path.join(templatesDir, 'do/deploy'), 'utf8');
const _pushTemplate = readFileSync(path.join(templatesDir, 'do/push'), 'utf8'); // eslint-disable-line no-unused-vars
const _submitTemplate = readFileSync(path.join(templatesDir, 'do/submit'), 'utf8'); // eslint-disable-line no-unused-vars
const _cleanTemplate = readFileSync(path.join(templatesDir, 'do/clean'), 'utf8'); // eslint-disable-line no-unused-vars

/** Base template variables for managed-inference rendering */
function managedInferenceVars(overrides = {}) {
    return {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'managed-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        modelName: 'meta-llama/Llama-2-7b',
        hfToken: undefined,
        ngcApiKey: undefined,
        modelFormat: undefined,
        asyncS3OutputPath: '',
        asyncSnsSuccessTopic: '',
        asyncSnsErrorTopic: '',
        asyncMaxConcurrentInvocations: 1,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
        orderedEnvVars: [],
        baseImage: '',
        ...overrides
    };
}

describe('Manifest Generation Integration Tests', function () {
    this.timeout(30000);

    before(() => {
        console.log('\n🚀 Starting manifest generation integration tests');
        console.log('📋 Validates: Requirements 3.8, 4.5, 9.1\n');
    });

    // ================================================================
    // 1. do/manifest template exists
    // ================================================================
    describe('do/manifest template', () => {
        it('should exist in the templates directory', () => {
            const manifestPath = path.join(templatesDir, 'do/manifest');
            assert.ok(
                existsSync(manifestPath),
                'do/manifest template should exist'
            );
        });

        it('should be a bash script that invokes do/lib/manifest-cli.js', () => {
            const content = readFileSync(path.join(templatesDir, 'do/manifest'), 'utf8');
            assert.ok(
                content.includes('#!/bin/bash'),
                'do/manifest should have bash shebang'
            );
            assert.ok(
                content.includes('lib/manifest-cli.js'),
                'do/manifest should invoke do/lib/manifest-cli.js'
            );
        });
    });

    // ================================================================
    // 2. do/lib/ source files exist (copied by generator)
    // ================================================================
    describe('do/lib/ source files', () => {
        it('should have manifest-cli.js in lib directory', () => {
            const cliPath = path.join(libDir, 'manifest-cli.js');
            assert.ok(
                existsSync(cliPath),
                'src/lib/manifest-cli.js should exist'
            );
        });

        it('should have asset-manager.js in lib directory', () => {
            const amPath = path.join(libDir, 'asset-manager.js');
            assert.ok(
                existsSync(amPath),
                'src/lib/asset-manager.js should exist'
            );
        });

        it('should have bootstrap-config.js in lib directory', () => {
            const bcPath = path.join(libDir, 'bootstrap-config.js');
            assert.ok(
                existsSync(bcPath),
                'src/lib/bootstrap-config.js should exist'
            );
        });
    });

    // ================================================================
    // 3. Generator index.js wires do/lib/ and do/manifest
    // ================================================================
    describe('Generator wiring', () => {
        it('should copy manifest-cli.js to do/lib/', () => {
            const indexContent = readFileSync(
                path.join(__dirname, '../../src/app.js'),
                'utf8'
            );
            assert.ok(
                indexContent.includes('manifest-cli.js'),
                'Generator should copy manifest-cli.js to do/lib/'
            );
        });

        it('should copy asset-manager.js to do/lib/', () => {
            const indexContent = readFileSync(
                path.join(__dirname, '../../src/app.js'),
                'utf8'
            );
            assert.ok(
                indexContent.includes('asset-manager.js'),
                'Generator should copy asset-manager.js to do/lib/'
            );
        });

        it('should copy bootstrap-config.js to do/lib/', () => {
            const indexContent = readFileSync(
                path.join(__dirname, '../../src/app.js'),
                'utf8'
            );
            assert.ok(
                indexContent.includes('bootstrap-config.js'),
                'Generator should copy bootstrap-config.js to do/lib/'
            );
        });

        it('should include do/manifest in executable permissions list', () => {
            const indexContent = readFileSync(
                path.join(__dirname, '../../src/app.js'),
                'utf8'
            );
            assert.ok(
                indexContent.includes('\'do/manifest\''),
                'do/manifest should be in _setExecutablePermissions shellScripts array'
            );
        });
    });

    // ================================================================
    // 4. do/deploy contains ./do/manifest add calls
    // ================================================================
    describe('do/deploy manifest integration', () => {
        it('should contain ./do/manifest add calls for managed-inference', () => {
            const output = ejs.render(deployTemplate, managedInferenceVars());

            assert.ok(
                output.includes('./do/manifest add'),
                'do/deploy (managed-inference) must contain ./do/manifest add'
            );
            assert.ok(
                output.includes('sagemaker-endpoint-config'),
                'do/deploy must record sagemaker-endpoint-config'
            );
            assert.ok(
                output.includes('sagemaker-endpoint'),
                'do/deploy must record sagemaker-endpoint'
            );
            assert.ok(
                output.includes('sagemaker-inference-component'),
                'do/deploy must record sagemaker-inference-component'
            );
        });
    });

    // ================================================================
    // 5. do/push contains ./do/manifest add calls
    // ================================================================
    describe('do/push manifest integration', () => {
        it('should contain ./do/manifest add call for ecr-image', () => {
            const content = readFileSync(path.join(templatesDir, 'do/push'), 'utf8');

            assert.ok(
                content.includes('./do/manifest add'),
                'do/push must contain ./do/manifest add'
            );
            assert.ok(
                content.includes('ecr-image'),
                'do/push must record ecr-image resource type'
            );
        });
    });

    // ================================================================
    // 6. do/submit contains ./do/manifest add calls
    // ================================================================
    describe('do/submit manifest integration', () => {
        it('should contain ./do/manifest add calls for codebuild resources', () => {
            const content = readFileSync(path.join(templatesDir, 'do/submit'), 'utf8');

            assert.ok(
                content.includes('./do/manifest add'),
                'do/submit must contain ./do/manifest add'
            );
            assert.ok(
                content.includes('codebuild-project'),
                'do/submit must record codebuild-project resource type'
            );
            assert.ok(
                content.includes('iam-role'),
                'do/submit must record iam-role resource type'
            );
            assert.ok(
                content.includes('s3-object'),
                'do/submit must record s3-object resource type'
            );
        });
    });

    // ================================================================
    // 7. do/clean contains ./do/manifest delete calls
    // ================================================================
    describe('do/clean manifest integration', () => {
        it('should contain ./do/manifest delete calls', () => {
            const content = readFileSync(path.join(templatesDir, 'do/clean'), 'utf8');

            assert.ok(
                content.includes('./do/manifest delete'),
                'do/clean must contain ./do/manifest delete'
            );
        });

        it('should mark endpoint resources as deleted', () => {
            const content = readFileSync(path.join(templatesDir, 'do/clean'), 'utf8');

            // Verify delete calls reference the expected resource types via ARN patterns
            assert.ok(
                content.includes('manifest delete --id "arn:aws:sagemaker'),
                'do/clean must delete sagemaker resources via manifest'
            );
        });
    });
});

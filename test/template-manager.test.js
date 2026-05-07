// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import TemplateManager from '../src/lib/template-manager.js';

describe('TemplateManager', () => {
    // Note: getIgnorePatterns() method has been removed as part of do-framework integration.
    // All template files are now generated unconditionally, and runtime scripts handle
    // conditional logic based on deployment configuration.

    // Note: getIgnorePatterns() method has been removed as part of do-framework integration.
    // All template files are now generated unconditionally, and runtime scripts handle
    // conditional logic based on deployment configuration.

    describe('validate', () => {
        it('should pass validation for http deployment configurations', () => {
            const answers = {
                deploymentConfig: 'http-flask',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: '',
                includeTesting: true,
                testTypes: ['local-model-cli']
            };
            
            const manager = new TemplateManager(answers);
            assert.doesNotThrow(() => manager.validate());
        });

        it('should pass validation for transformers deployment configurations', () => {
            const answers = {
                deploymentConfig: 'transformers-vllm',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference',
                instanceType: 'ml.g5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: '',
                includeTesting: true,
                testTypes: ['local-model-cli']
            };
            
            const manager = new TemplateManager(answers);
            assert.doesNotThrow(() => manager.validate());
        });

        it('should pass validation for triton deployment configurations', () => {
            const answers = {
                deploymentConfig: 'triton-fil',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference',
                instanceType: 'ml.g5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: '',
                includeTesting: true,
                testTypes: ['local-model-cli']
            };
            
            const manager = new TemplateManager(answers);
            assert.doesNotThrow(() => manager.validate());
        });

        it('should throw error for unsupported deployment configuration', () => {
            const answers = {
                deploymentConfig: 'pytorch-torchserve',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /pytorch-torchserve not implemented yet/);
        });

        it('should reject old-format deployment configs', () => {
            const answers = {
                deploymentConfig: 'sklearn-flask',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /sklearn-flask not implemented yet/);
        });

        it('should support fallback validation with separate architecture and backend', () => {
            const answers = {
                architecture: 'http',
                backend: 'flask',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: '',
                includeTesting: true,
                testTypes: ['local-model-cli']
            };
            
            const manager = new TemplateManager(answers);
            assert.doesNotThrow(() => manager.validate());
        });

        it('should throw error for unsupported architecture in fallback mode', () => {
            const answers = {
                architecture: 'custom',
                backend: 'flask',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /custom not implemented yet/);
        });

        it('should throw error for unsupported backend in fallback mode', () => {
            const answers = {
                architecture: 'http',
                backend: 'torchserve',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /torchserve not implemented yet/);
        });

        it('should throw error for tensorrt-llm with non-transformers architecture', () => {
            const answers = {
                architecture: 'http',
                backend: 'tensorrt-llm',
                buildTarget: 'codebuild',
                instanceType: 'ml.g5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /TensorRT-LLM is only supported with the transformers architecture/);
        });

        it('should reject triton-vllm with CPU-only instance type', () => {
            const answers = {
                deploymentConfig: 'triton-vllm',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference',
                instanceType: 'ml.m5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /triton-vllm requires a GPU instance type/);
        });

        it('should reject triton-tensorrtllm with CPU-only instance type', () => {
            const answers = {
                deploymentConfig: 'triton-tensorrtllm',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference',
                instanceType: 'ml.c5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /triton-tensorrtllm requires a GPU instance type/);
        });

        it('should accept triton-vllm with GPU instance type', () => {
            const answers = {
                deploymentConfig: 'triton-vllm',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference',
                instanceType: 'ml.g5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.doesNotThrow(() => manager.validate());
        });
    });
});
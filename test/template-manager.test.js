// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert';
import TemplateManager from '../generators/app/lib/template-manager.js';

describe('TemplateManager', () => {
    // Note: getIgnorePatterns() method has been removed as part of do-framework integration.
    // All template files are now generated unconditionally, and runtime scripts handle
    // conditional logic based on deployment configuration.

    // Note: getIgnorePatterns() method has been removed as part of do-framework integration.
    // All template files are now generated unconditionally, and runtime scripts handle
    // conditional logic based on deployment configuration.

    describe('validate', () => {
        it('should pass validation for supported deployment configurations', () => {
            const answers = {
                deploymentConfig: 'sklearn-flask',
                deployTarget: 'sagemaker',
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
                deployTarget: 'sagemaker',
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
                deployTarget: 'sagemaker',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /pytorch-torchserve not implemented yet/);
        });

        it('should support backward compatibility with separate framework and modelServer', () => {
            const answers = {
                framework: 'sklearn',
                modelServer: 'flask',
                deployTarget: 'sagemaker',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: '',
                includeTesting: true,
                testTypes: ['local-model-cli']
            };
            
            const manager = new TemplateManager(answers);
            assert.doesNotThrow(() => manager.validate());
        });

        it('should throw error for unsupported framework in backward compatibility mode', () => {
            const answers = {
                framework: 'pytorch',
                modelServer: 'flask',
                deployTarget: 'sagemaker',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /pytorch not implemented yet/);
        });

        it('should throw error for unsupported model server in backward compatibility mode', () => {
            const answers = {
                framework: 'sklearn',
                modelServer: 'torchserve',
                deployTarget: 'sagemaker',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /torchserve not implemented yet/);
        });

        it('should throw error for tensorrt-llm with non-transformers framework', () => {
            const answers = {
                framework: 'sklearn',
                modelServer: 'tensorrt-llm',
                deployTarget: 'sagemaker',
                instanceType: 'ml.g5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            };
            
            const manager = new TemplateManager(answers);
            assert.throws(() => manager.validate(), /TensorRT-LLM is only supported with the transformers framework/);
        });
    });
});
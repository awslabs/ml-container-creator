// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'assert'
import TemplateManager from '../generators/app/lib/template-manager.js'

describe('Unit Tests', () => {
    describe('TemplateManager', () => {
        // Note: getIgnorePatterns() method has been removed as part of do-framework integration.
        // All template files are now generated unconditionally, and runtime scripts handle
        // conditional logic based on deployment configuration.

        it('should validate http deployment configurations', () => {
            const answers = {
                deploymentConfig: 'http-flask',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            }
            
            const manager = new TemplateManager(answers)
            assert.doesNotThrow(() => manager.validate())
        })

        it('should validate transformers deployment configurations', () => {
            const answers = {
                deploymentConfig: 'transformers-vllm',
                buildTarget: 'codebuild',
                instanceType: 'ml.g5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            }
            
            const manager = new TemplateManager(answers)
            assert.doesNotThrow(() => manager.validate())
        })

        it('should validate triton deployment configurations', () => {
            const answers = {
                deploymentConfig: 'triton-fil',
                buildTarget: 'codebuild',
                instanceType: 'ml.g5.xlarge',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            }
            
            const manager = new TemplateManager(answers)
            assert.doesNotThrow(() => manager.validate())
        })

        it('should support fallback validation with separate architecture and backend', () => {
            const answers = {
                architecture: 'http',
                backend: 'flask',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            }
            
            const manager = new TemplateManager(answers)
            assert.doesNotThrow(() => manager.validate())
        })

        it('should throw error for unsupported architecture in fallback mode', () => {
            const answers = {
                architecture: 'pytorch',
                backend: 'flask',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            }
            
            const manager = new TemplateManager(answers)
            assert.throws(() => manager.validate(), /pytorch not implemented yet/)
        })

        it('should throw error for unsupported deployment configuration', () => {
            const answers = {
                deploymentConfig: 'pytorch-torchserve',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            }
            
            const manager = new TemplateManager(answers)
            assert.throws(() => manager.validate(), /pytorch-torchserve not implemented yet/)
        })

        it('should reject old-format deployment configs', () => {
            const answers = {
                deploymentConfig: 'sklearn-flask',
                buildTarget: 'codebuild',
                instanceType: 'ml.m5.large',
                awsRegion: 'us-east-1',
                awsRoleArn: ''
            }
            
            const manager = new TemplateManager(answers)
            assert.throws(() => manager.validate(), /sklearn-flask not implemented yet/)
        })
    })
})

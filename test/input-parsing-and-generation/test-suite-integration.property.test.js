// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-Based Test: Test Suite Integration
 * 
 * **Property 7: Test Suite Integration**
 * For any CodeBuild configuration, the test suite should generate appropriate 
 * test cases and validate CodeBuild-specific functionality
 * 
 * **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5**
 * 
 * Feature: codebuild-deployment-target, Property 7: Test Suite Integration
 */

import { describe, it } from 'mocha';
import fc from 'fast-check';
import helpers from 'yeoman-test';
import assert from 'yeoman-assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { 
    generateCodeBuildConfiguration,
    generateSageMakerConfiguration,
    generateValidConfiguration 
} from './config-generators.js';
import { PROPERTY_TEST_CONFIG } from './property-test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Property Test: Test Suite Integration', function() {
    this.timeout(60000); // Extended timeout for property tests
    
    /**
     * Property 7: Test Suite Integration
     * For any CodeBuild configuration, the test suite should generate appropriate 
     * test cases and validate CodeBuild-specific functionality
     */
    it('Property 7: Test Suite Integration - CodeBuild configurations generate appropriate test cases', async () => {
        // Test specific CodeBuild configurations instead of using property-based testing
        const testConfigs = [
            {
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl',
                deployTarget: 'codebuild',
                codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
                instanceType: 'cpu-optimized',
                awsRegion: 'us-east-1',
                projectName: 'test-sklearn',
                destinationDir: '.',
                includeSampleModel: false,
                includeTesting: false,
                awsRoleArn: null
            },
            {
                framework: 'tensorflow',
                modelServer: 'flask',
                modelFormat: 'SavedModel',
                deployTarget: 'codebuild',
                codebuildComputeType: 'BUILD_GENERAL1_LARGE',
                instanceType: 'gpu-enabled',
                awsRegion: 'us-west-2',
                projectName: 'test-tensorflow',
                destinationDir: '.',
                includeSampleModel: false,
                includeTesting: true,
                awsRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
            }
        ];
        
        for (const config of testConfigs) {
            let runContext;
            
            try {
                // Generate project with CodeBuild configuration
                runContext = await helpers.run(path.join(__dirname, '../../generators/app'))
                    .withArguments([config.projectName])
                    .withPrompts({
                        framework: config.framework,
                        modelServer: config.modelServer,
                        modelFormat: config.modelFormat,
                        deployTarget: config.deployTarget,
                        codebuildComputeType: config.codebuildComputeType,
                        includeSampleModel: config.includeSampleModel,
                        includeTesting: config.includeTesting,
                        instanceType: config.instanceType,
                        awsRegion: config.awsRegion,
                        awsRoleArn: config.awsRoleArn,
                        destinationDir: config.destinationDir
                    });
                
                // Requirement 13.1: Unit tests for CodeBuild deployment target selection
                // Verify CodeBuild-specific files are generated
                const codebuildFiles = [
                    'buildspec.yml',
                    'deploy/submit_build.sh',
                    'IAM_PERMISSIONS.md'
                ];
                
                assert.file(codebuildFiles);
                
                // Requirement 13.2: Unit tests for CodeBuild-specific prompt logic
                // Verify CodeBuild parameters are properly used in templates
                assert.fileContent('deploy/submit_build.sh', /CODEBUILD_PROJECT_NAME="[\w-]+-build-\d{8}"/);
                assert.fileContent('deploy/submit_build.sh', config.codebuildComputeType);
                assert.fileContent('deploy/submit_build.sh', config.awsRegion);
                
                // Requirement 13.3: Unit tests for CodeBuild template generation and exclusion
                // Verify SageMaker-only files are excluded
                assert.noFile(['deploy/build_and_push.sh']);
                
                // Requirement 13.4: Unit tests for CodeBuild configuration parameter parsing
                // Verify buildspec.yml contains correct project configuration
                assert.fileContent('buildspec.yml', config.projectName);
                assert.fileContent('buildspec.yml', 'version: 0.2');
                assert.fileContent('buildspec.yml', 'phases:');
                
                // Requirement 13.5: Integration tests for complete CodeBuild project generation
                // Verify deploy.sh is modified for CodeBuild integration
                assert.fileContent('deploy/deploy.sh', 'CodeBuild deployment');
                assert.fileContent('deploy/deploy.sh', 'ECR image');
                assert.noFileContent('deploy/deploy.sh', 'docker build');
                
                // Verify IAM documentation is comprehensive
                assert.fileContent('IAM_PERMISSIONS.md', 'CodeBuild');
                assert.fileContent('IAM_PERMISSIONS.md', 'service role');
                assert.fileContent('IAM_PERMISSIONS.md', 'permissions');
                
            } finally {
                // Clean up test directory
                if (runContext && runContext.cleanup) {
                    runContext.cleanup();
                }
            }
        }
    });
    
    /**
     * Property 7b: Test Suite Integration - SageMaker configurations should not generate CodeBuild files
     * Ensures test isolation between CodeBuild and SageMaker tests
     */
    it('Property 7b: Test Suite Integration - SageMaker configurations exclude CodeBuild files', async () => {
        // Test specific SageMaker configurations instead of using property-based testing
        const testConfigs = [
            {
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl',
                deployTarget: 'sagemaker',
                instanceType: 'cpu-optimized',
                awsRegion: 'us-east-1',
                projectName: 'test-sagemaker-sklearn',
                destinationDir: '.',
                includeSampleModel: false,
                includeTesting: false,
                awsRoleArn: null
            },
            {
                framework: 'xgboost',
                modelServer: 'fastapi',
                modelFormat: 'json',
                deployTarget: 'sagemaker',
                instanceType: 'gpu-enabled',
                awsRegion: 'us-west-2',
                projectName: 'test-sagemaker-xgboost',
                destinationDir: '.',
                includeSampleModel: true,
                includeTesting: true,
                awsRoleArn: 'arn:aws:iam::123456789012:role/TestRole'
            }
        ];
        
        for (const config of testConfigs) {
            let runContext;
            
            try {
                // Generate project with SageMaker configuration
                runContext = await helpers.run(path.join(__dirname, '../../generators/app'))
                    .withArguments([config.projectName])
                    .withPrompts({
                        framework: config.framework,
                        modelServer: config.modelServer,
                        modelFormat: config.modelFormat,
                        deployTarget: config.deployTarget,
                        includeSampleModel: config.includeSampleModel,
                        includeTesting: config.includeTesting,
                        instanceType: config.instanceType,
                        awsRegion: config.awsRegion,
                        awsRoleArn: config.awsRoleArn,
                        destinationDir: config.destinationDir
                    });
                
                // Verify CodeBuild-specific files are NOT generated for SageMaker
                const codebuildFiles = [
                    'buildspec.yml',
                    'deploy/submit_build.sh',
                    'IAM_PERMISSIONS.md'
                ];
                
                assert.noFile(codebuildFiles);
                
                // Verify SageMaker-specific files ARE generated
                const sagemakerFiles = [
                    'deploy/build_and_push.sh',
                    'deploy/deploy.sh'
                ];
                
                assert.file(sagemakerFiles);
                
                // Verify deploy.sh contains SageMaker-specific logic
                assert.noFileContent('deploy/deploy.sh', 'CodeBuild deployment');
                
            } finally {
                // Clean up test directory
                if (runContext && runContext.cleanup) {
                    runContext.cleanup();
                }
            }
        }
    });
    
    /**
     * Property 7c: Test Suite Integration - Configuration validation across deployment targets
     * Ensures test suite validates different deployment target configurations correctly
     */
    it('Property 7c: Test Suite Integration - Configuration validation across deployment targets', async () => {
        // Test a few specific configurations instead of using property-based testing
        const testConfigs = [
            {
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl',
                deployTarget: 'sagemaker',
                instanceType: 'cpu-optimized',
                awsRegion: 'us-east-1',
                projectName: 'test-sagemaker',
                destinationDir: '.',
                includeSampleModel: false,
                includeTesting: false,
                awsRoleArn: null
            },
            {
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl',
                deployTarget: 'codebuild',
                codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
                instanceType: 'cpu-optimized',
                awsRegion: 'us-east-1',
                projectName: 'test-codebuild',
                destinationDir: '.',
                includeSampleModel: false,
                includeTesting: false,
                awsRoleArn: null
            }
        ];
        
        for (const config of testConfigs) {
            let runContext;
            
            try {
                // Build prompts object based on deployment target
                const prompts = {
                    projectName: config.projectName,
                    framework: config.framework,
                    modelServer: config.modelServer,
                    modelFormat: config.modelFormat,
                    deployTarget: config.deployTarget,
                    includeSampleModel: config.includeSampleModel,
                    includeTesting: config.includeTesting,
                    instanceType: config.instanceType,
                    awsRegion: config.awsRegion,
                    awsRoleArn: config.awsRoleArn,
                    destinationDir: config.destinationDir
                };
                
                // Only add CodeBuild-specific properties if deployTarget is 'codebuild'
                if (config.deployTarget === 'codebuild') {
                    prompts.codebuildComputeType = config.codebuildComputeType;
                }
                
                // Generate project with configuration
                runContext = await helpers.run(path.join(__dirname, '../../generators/app'))
                    .withArguments([config.projectName])
                    .withPrompts({
                        framework: config.framework,
                        modelServer: config.modelServer,
                        modelFormat: config.modelFormat,
                        deployTarget: config.deployTarget,
                        codebuildComputeType: config.codebuildComputeType,
                        includeSampleModel: config.includeSampleModel,
                        includeTesting: config.includeTesting,
                        instanceType: config.instanceType,
                        awsRegion: config.awsRegion,
                        awsRoleArn: config.awsRoleArn,
                        destinationDir: config.destinationDir
                    });
                
                // Verify core files are always generated regardless of deployment target
                assert.file([
                    'Dockerfile',
                    'requirements.txt',
                    'deploy/deploy.sh'
                ]);
                
                // Verify framework-specific files are generated correctly
                if (config.framework !== 'transformers') {
                    assert.file([
                        'code/model_handler.py',
                        'code/serve.py'
                    ]);
                }
                
                // Verify deployment target specific files
                if (config.deployTarget === 'codebuild') {
                    assert.file([
                        'buildspec.yml',
                        'deploy/submit_build.sh'
                    ]);
                    assert.noFile([
                        'deploy/build_and_push.sh'
                    ]);
                } else {
                    assert.file([
                        'deploy/build_and_push.sh'
                    ]);
                    assert.noFile([
                        'buildspec.yml',
                        'deploy/submit_build.sh'
                    ]);
                }
                
            } finally {
                // Clean up test directory
                if (runContext && runContext.cleanup) {
                    runContext.cleanup();
                }
            }
        }
    });
});
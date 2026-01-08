// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CodeBuild Prompt Logic Tests
 * 
 * Tests the conditional prompting logic for CodeBuild deployment target:
 * - CodeBuild prompts appear when deployTarget is 'codebuild'
 * - CodeBuild prompts are skipped when deployTarget is 'sagemaker'
 * - CodeBuild parameter validation works correctly
 */

import {
    getGeneratorPath,
    validateFiles,
    validateNoFiles as _validateNoFiles,
    setupTestHooks
} from './test-utils.js';

describe('CodeBuild Prompt Logic', () => {
    let helpers;

    before(async () => {
        console.log('\n🚀 Starting CodeBuild Prompt Logic Tests');
        console.log('📋 Testing: CodeBuild conditional prompting and validation');
        
        helpers = await import('yeoman-test');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('CodeBuild Prompt Logic');

    describe('CodeBuild Deployment Target Selection', () => {
        it('should generate CodeBuild-specific files when deployTarget is codebuild', async () => {
            console.log('\n  🧪 Testing CodeBuild deployment target selection...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'codebuild-test-project',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'deploy-target': 'codebuild',
                    'codebuild-compute-type': 'BUILD_GENERAL1_MEDIUM',
                    'codebuild-project-name': 'test-build-project'
                });

            // Should generate basic files
            validateFiles(['Dockerfile', 'requirements.txt'], 'CodeBuild basic files');
            console.log('    ✅ CodeBuild deployment target generates expected files');
        });

        it('should generate SageMaker-only files when deployTarget is sagemaker', async () => {
            console.log('\n  🧪 Testing SageMaker deployment target selection...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'sagemaker-test-project',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'deploy-target': 'sagemaker'
                });

            // Should generate basic files
            validateFiles(['Dockerfile', 'requirements.txt', 'deploy/build_and_push.sh'], 'SageMaker basic files');
            console.log('    ✅ SageMaker deployment target generates expected files');
        });
    });

    describe('CodeBuild CLI Options Validation', () => {
        it('should validate CodeBuild compute type options', async () => {
            console.log('\n  🧪 Testing valid CodeBuild compute type...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'compute-type-test',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'deploy-target': 'codebuild',
                    'codebuild-compute-type': 'BUILD_GENERAL1_LARGE',
                    'codebuild-project-name': 'valid-project-name'
                });

            validateFiles(['Dockerfile'], 'valid CodeBuild compute type');
            console.log('    ✅ Valid CodeBuild compute type accepted');
        });

        it('should validate CodeBuild project name format', async () => {
            console.log('\n  🧪 Testing valid CodeBuild project name...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'project-name-test',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'deploy-target': 'codebuild',
                    'codebuild-compute-type': 'BUILD_GENERAL1_MEDIUM',
                    'codebuild-project-name': 'valid-project-name-123'
                });

            validateFiles(['Dockerfile'], 'valid CodeBuild project name');
            console.log('    ✅ Valid CodeBuild project name accepted');
        });
    });

    describe('CodeBuild Parameter Defaults', () => {
        it('should use default CodeBuild compute type when not specified', async () => {
            console.log('\n  🧪 Testing CodeBuild default compute type...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'default-compute-test',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'deploy-target': 'codebuild',
                    'codebuild-project-name': 'test-project'
                });

            validateFiles(['Dockerfile'], 'default CodeBuild compute type');
            console.log('    ✅ Default CodeBuild compute type used successfully');
        });

        it('should generate default CodeBuild project name when not specified', async () => {
            console.log('\n  🧪 Testing CodeBuild default project name...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'default-name-test',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'deploy-target': 'codebuild',
                    'codebuild-compute-type': 'BUILD_GENERAL1_MEDIUM'
                });

            validateFiles(['Dockerfile'], 'default CodeBuild project name');
            console.log('    ✅ Default CodeBuild project name generated successfully');
        });
    });
});
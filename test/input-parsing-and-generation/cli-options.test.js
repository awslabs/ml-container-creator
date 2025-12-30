// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI Options Parsing Tests
 * 
 * Tests how the generator parses and processes CLI options like:
 * - --framework=sklearn
 * - --model-server=flask
 * - --skip-prompts
 * - etc.
 * 
 * This module focuses specifically on CLI option parsing and validation.
 */

import {
    FRAMEWORKS,
    REQUIRED_FILES,
    TRADITIONAL_ML_FILES,
    TRANSFORMER_FILES,
    getGeneratorPath,
    validateFiles,
    validateFileContent,
    validateNoFiles,
    setupTestHooks
} from './test-utils.js';

describe('CLI Options Parsing', () => {
    let helpers;

    before(async () => {
        console.log('\n🚀 Starting CLI Options Parsing Tests');
        console.log('📋 Testing: CLI option parsing and validation');
        console.log('🔧 Frameworks:', Object.keys(FRAMEWORKS).join(', '));
        
        helpers = await import('yeoman-test');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('CLI Options Parsing');

    describe('Framework-Specific CLI Options', () => {
        Object.keys(FRAMEWORKS).forEach(framework => {
            it(`should parse ${framework} CLI options correctly`, async () => {
                console.log(`\n  🧪 Testing CLI parsing for ${framework}...`);
                
                const config = FRAMEWORKS[framework];
                const options = {
                    'skip-prompts': true,
                    'project-name': `cli-${framework}-project`,
                    framework,
                    'model-server': config.servers[0],
                    'include-testing': false
                };

                if (config.formats.length > 0) {
                    options['model-format'] = config.formats[0];
                }

                console.log('    ⚙️  CLI Options:', JSON.stringify(options, null, 2));

                await helpers.default.run(getGeneratorPath())
                    .withOptions(options);

                // Verify parsing worked by checking generated files
                if (framework === 'transformers') {
                    validateFiles([...REQUIRED_FILES, ...TRANSFORMER_FILES], `${framework} CLI parsing`);
                    // Transformers Dockerfile doesn't include project name, so skip that check
                    console.log(`    ✅ ${framework} CLI parsing successful (transformers use different Dockerfile template)`);
                } else {
                    validateFiles([...REQUIRED_FILES, ...TRADITIONAL_ML_FILES], `${framework} CLI parsing`);
                    validateFileContent('Dockerfile', new RegExp(`cli-${framework}-project`), `${framework} project name`);
                    validateFileContent('requirements.txt', new RegExp(config.servers[0]), `${framework} model server`);
                    console.log(`    ✅ ${framework} CLI parsing successful`);
                }
            });
        });
    });

    describe('CLI Option Validation', () => {
        it('should validate invalid framework options', async () => {
            console.log('\n  🧪 Testing CLI validation with invalid framework...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'invalid-framework',
                    'model-server': 'flask'
                });
            
            // Validation should prevent file generation
            validateNoFiles(['Dockerfile', 'requirements.txt'], 'invalid framework validation');
            console.log('    ✅ Invalid framework correctly rejected - no files generated');
        });

        it('should validate invalid framework/server combinations', async () => {
            console.log('\n  🧪 Testing invalid framework/server combination...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'vllm', // Invalid for sklearn
                    'model-format': 'pkl'
                });
            
            // Validation should prevent file generation
            validateNoFiles(['Dockerfile', 'requirements.txt'], 'invalid framework/server combination');
            console.log('    ✅ Invalid framework/server combination correctly rejected - no files generated');
        });
    });

    describe('Boolean CLI Options', () => {
        it('should handle boolean CLI options correctly', async () => {
            console.log('\n  🧪 Testing boolean CLI options...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'boolean-test-project',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'include-sample': true,
                    'include-testing': false
                });

            // Should include sample model files
            validateFiles(['sample_model/train_abalone.py', 'sample_model/test_inference.py'], 'sample model inclusion');
            
            // Should exclude test files
            validateNoFiles(['test/'], 'testing disabled');
            
            console.log('    ✅ Boolean CLI options handled correctly');
        });

        it('should handle string array CLI options', async () => {
            console.log('\n  🧪 Testing string array CLI options...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'array-test-project',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'include-testing': true,
                    'test-types': 'local-model-cli,hosted-model-endpoint'
                });

            // Should include test files
            validateFiles(['test/test_local_image.sh', 'test/test_endpoint.sh'], 'test inclusion');
            
            console.log('    ✅ String array CLI options handled correctly');
        });
    });

    describe('AWS Role ARN CLI Option', () => {
        it('should handle --role-arn CLI option correctly', async () => {
            console.log('\n  🧪 Testing --role-arn CLI option...');
            
            const testRoleArn = 'arn:aws:iam::123456789012:role/SageMakerRole';
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'role-arn-test-project',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'role-arn': testRoleArn
                });

            // Should generate files successfully with role ARN
            validateFiles(['Dockerfile', 'deploy/deploy.sh'], 'role ARN CLI option');
            
            // Check that role ARN is used in deployment script
            validateFileContent('deploy/deploy.sh', new RegExp(testRoleArn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'AWS role ARN in deployment');
            
            console.log('    ✅ --role-arn CLI option handled correctly');
        });

        it('should validate invalid AWS Role ARN format', async () => {
            console.log('\n  🧪 Testing invalid AWS Role ARN format...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'role-arn': 'invalid-arn-format'
                });
            
            // Validation should prevent file generation
            validateNoFiles(['Dockerfile', 'requirements.txt'], 'invalid AWS Role ARN validation');
            console.log('    ✅ Invalid AWS Role ARN correctly rejected - no files generated');
        });
    });

    describe('CLI Help and Special Commands', () => {
        it('should handle help option without generating files', async () => {
            console.log('\n  🧪 Testing help option...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({ 'help': true });

            validateNoFiles(['Dockerfile'], 'help command should not generate files');
            console.log('    ✅ Help option handled correctly');
        });

        it('should handle configure command', async () => {
            console.log('\n  🧪 Testing configure command...');
            
            await helpers.default.run(getGeneratorPath())
                .withArguments(['configure'])
                .withPrompts({
                    configType: 'env'
                });

            validateNoFiles(['Dockerfile'], 'configure command should not generate files');
            console.log('    ✅ Configure command handled correctly');
        });
    });
});
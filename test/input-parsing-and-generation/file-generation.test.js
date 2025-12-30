// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * File Generation Tests
 * 
 * Tests that the generator creates the correct files based on configuration:
 * - Framework-specific files (sklearn vs transformers)
 * - Optional module inclusion (sample models, tests)
 * - Server-specific files (Flask vs FastAPI vs vLLM)
 * - Conditional file exclusion
 * 
 * This module focuses specifically on validating that the right files
 * are generated with the right content based on user configuration.
 */

import {
    FRAMEWORKS,
    REQUIRED_FILES,
    TRADITIONAL_ML_FILES,
    TRANSFORMER_FILES,
    SAMPLE_MODEL_FILES,
    getGeneratorPath,
    validateFiles,
    validateFileContent,
    validateNoFiles,
    setupTestHooks
} from './test-utils.js';

describe('File Generation', () => {
    let helpers;

    before(async () => {
        console.log('\n🚀 Starting File Generation Tests');
        console.log('📋 Testing: Correct file generation based on configuration');
        console.log('🔧 Frameworks:', Object.keys(FRAMEWORKS).join(', '));
        
        helpers = await import('yeoman-test');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('File Generation');

    describe('Framework-Specific File Generation', () => {
        Object.keys(FRAMEWORKS).forEach(framework => {
            const config = FRAMEWORKS[framework];

            describe(`${framework.toUpperCase()} Framework`, () => {
                it('should generate correct files and dependencies', async () => {
                    console.log(`\n    🧪 Testing ${framework} file generation...`);
                    
                    const options = {
                        'skip-prompts': true,
                        framework,
                        'model-server': config.servers[0],
                        'include-testing': false
                    };

                    if (config.formats.length > 0) {
                        options['model-format'] = config.formats[0];
                    }

                    console.log('      ⚙️  Options:', JSON.stringify(options, null, 2));

                    try {
                        await helpers.default.run(getGeneratorPath())
                            .withOptions(options);

                        // All frameworks should generate these basic files
                        validateFiles(REQUIRED_FILES, `${framework} basic files`);

                        // Framework-specific files
                        if (framework === 'transformers') {
                            console.log('      🤖 Checking transformers-specific files...');
                            validateFiles(TRANSFORMER_FILES, `${framework} specific files`);
                            validateNoFiles(['code/model_handler.py', 'code/serve.py', 'nginx.conf', 'requirements.txt'], `${framework} excluded files`);
                        } else {
                            console.log('      🔧 Checking traditional ML files...');
                            validateFiles(TRADITIONAL_ML_FILES, `${framework} traditional ML files`);
                            validateNoFiles(['code/serve', 'deploy/upload_to_s3.sh'], `${framework} excluded transformer files`);
                            validateFileContent('requirements.txt', new RegExp(config.servers[0]), `${framework} server dependency`);
                            
                            // Check framework-specific dependencies
                            if (framework === 'sklearn') {
                                validateFileContent('requirements.txt', /scikit-learn/, 'sklearn dependency');
                            } else if (framework === 'xgboost') {
                                validateFileContent('requirements.txt', /xgboost/, 'xgboost dependency');
                            } else if (framework === 'tensorflow') {
                                validateFileContent('requirements.txt', /tensorflow/, 'tensorflow dependency');
                            }
                        }
                        
                        console.log(`      ✅ ${framework} file generation successful`);
                    } catch (error) {
                        console.log(`      ❌ ${framework} file generation failed: ${error.message}`);
                        throw error;
                    }
                });

                it('should handle sample model inclusion correctly', async () => {
                    console.log(`\n    🧪 Testing ${framework} sample model inclusion...`);
                    
                    const options = {
                        'skip-prompts': true,
                        framework,
                        'model-server': config.servers[0],
                        'include-sample': true,
                        'include-testing': false
                    };

                    if (config.formats.length > 0) {
                        options['model-format'] = config.formats[0];
                    }

                    await helpers.default.run(getGeneratorPath())
                        .withOptions(options);

                    if (config.hasSample) {
                        validateFiles(SAMPLE_MODEL_FILES, `${framework} sample model`);
                        console.log(`      ✅ ${framework} sample model included correctly`);
                    } else {
                        validateNoFiles(['sample_model/'], `${framework} no sample model`);
                        console.log(`      ✅ ${framework} correctly excludes sample model`);
                    }
                });

                it('should validate model server compatibility', async () => {
                    console.log(`\n    🧪 Testing ${framework} model server compatibility...`);
                    
                    for (const server of config.servers) {
                        const options = {
                            'skip-prompts': true,
                            framework,
                            'model-server': server
                        };

                        if (config.formats.length > 0) {
                            options['model-format'] = config.formats[0];
                        }

                        await helpers.default.run(getGeneratorPath())
                            .withOptions(options);

                        validateFiles(REQUIRED_FILES, `${framework} with ${server}`);
                        
                        if (framework !== 'transformers') {
                            validateFileContent('requirements.txt', new RegExp(server), `${framework} ${server} dependency`);
                        }
                        
                        console.log(`      ✅ ${framework} + ${server} compatibility confirmed`);
                    }
                });

                if (config.formats.length > 0) {
                    it('should validate model format compatibility', async () => {
                        console.log(`\n    🧪 Testing ${framework} model format compatibility...`);
                        
                        for (const format of config.formats) {
                            await helpers.default.run(getGeneratorPath())
                                .withOptions({
                                    'skip-prompts': true,
                                    framework,
                                    'model-format': format,
                                    'model-server': config.servers[0]
                                });

                            validateFiles(REQUIRED_FILES, `${framework} with ${format}`);
                            console.log(`      ✅ ${framework} + ${format} compatibility confirmed`);
                        }
                    });
                }
            });
        });
    });

    describe('Optional Module Generation', () => {
        it('should generate testing files when requested', async () => {
            console.log('\n  🧪 Testing test file generation...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'include-testing': true
                });

            validateFiles(['test/test_local_image.sh', 'test/test_endpoint.sh'], 'test file generation');
            console.log('    ✅ Test files generated correctly');
        });

        it('should exclude testing files when not requested', async () => {
            console.log('\n  🧪 Testing test file exclusion...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'include-testing': false
                });

            validateNoFiles(['test/'], 'test file exclusion');
            console.log('    ✅ Test files excluded correctly');
        });

        it('should handle test type selection correctly', async () => {
            console.log('\n  🧪 Testing test type selection...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'include-testing': true,
                    'test-types': 'local-model-cli,hosted-model-endpoint'
                });

            // Should include selected test types
            validateFiles(['test/test_local_image.sh', 'test/test_endpoint.sh'], 'selected test types');
            console.log('    ✅ Test type selection handled correctly');
        });

        it('should generate sample model files when requested', async () => {
            console.log('\n  🧪 Testing sample model generation...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'include-sample': true
                });

            validateFiles(SAMPLE_MODEL_FILES, 'sample model generation');
            console.log('    ✅ Sample model files generated correctly');
        });

        it('should exclude sample model files when not requested', async () => {
            console.log('\n  🧪 Testing sample model exclusion...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'include-sample': false
                });

            validateNoFiles(['sample_model/'], 'sample model exclusion');
            console.log('    ✅ Sample model files excluded correctly');
        });
    });

    describe('Server-Specific File Generation', () => {
        it('should generate Flask-specific files correctly', async () => {
            console.log('\n  🧪 Testing Flask-specific file generation...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl'
                });

            validateFiles(['code/flask/'], 'Flask-specific files');
            validateFileContent('requirements.txt', /flask/, 'Flask dependency');
            console.log('    ✅ Flask-specific files generated correctly');
        });

        it('should exclude Flask files for non-Flask servers', async () => {
            console.log('\n  🧪 Testing Flask file exclusion for FastAPI...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'fastapi',
                    'model-format': 'pkl'
                });

            validateNoFiles(['code/flask/'], 'Flask files excluded for FastAPI');
            validateFileContent('requirements.txt', /fastapi/, 'FastAPI dependency');
            console.log('    ✅ Flask files correctly excluded for FastAPI');
        });

        it('should generate transformer server files correctly', async () => {
            console.log('\n  🧪 Testing transformer server file generation...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'transformers',
                    'model-server': 'vllm'
                });

            validateFiles(['code/serve'], 'transformer server files');
            validateFiles(['deploy/upload_to_s3.sh'], 'S3 upload script for transformers');
            console.log('    ✅ Transformer server files generated correctly');
        });
    });

    describe('File Content Validation', () => {
        it('should generate Dockerfile with correct project name', async () => {
            console.log('\n  🧪 Testing Dockerfile project name...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'project-name': 'test-project-name',
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl'
                });

            validateFileContent('Dockerfile', /test-project-name/, 'Dockerfile project name');
            console.log('    ✅ Dockerfile project name generated correctly');
        });

        it('should generate requirements.txt with correct dependencies', async () => {
            console.log('\n  🧪 Testing requirements.txt dependencies...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'tensorflow',
                    'model-server': 'fastapi',
                    'model-format': 'keras'
                });

            validateFileContent('requirements.txt', /tensorflow/, 'TensorFlow dependency');
            validateFileContent('requirements.txt', /fastapi/, 'FastAPI dependency');
            console.log('    ✅ Requirements.txt dependencies generated correctly');
        });

        it('should generate deployment scripts with correct configuration', async () => {
            console.log('\n  🧪 Testing deployment script configuration...');
            
            await helpers.default.run(getGeneratorPath())
                .withOptions({
                    'skip-prompts': true,
                    'framework': 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'instance-type': 'gpu-enabled'
                });

            validateFileContent('deploy/deploy.sh', /ml\.g5\.xlarge/, 'GPU instance type in deploy script');
            console.log('    ✅ Deployment script configuration generated correctly');
        });
    });
});
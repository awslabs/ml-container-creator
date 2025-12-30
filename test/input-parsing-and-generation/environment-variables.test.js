// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Environment Variables Parsing Tests
 * 
 * Tests how the generator parses and processes environment variables according to the parameter matrix.
 * Only tests environment variables that are supported according to PARAMETERS.MD:
 * - ML_INSTANCE_TYPE (instance type)
 * - AWS_REGION (AWS region)
 * - AWS_ROLE (AWS IAM role ARN)
 * - ML_CONTAINER_CREATOR_CONFIG (config file path)
 * 
 * Core parameters (framework, model-server, etc.) are NOT supported via environment variables
 * and should be configured via CLI options or config files only.
 */

import {
    REQUIRED_FILES,
    TRADITIONAL_ML_FILES,
    SAMPLE_MODEL_FILES,
    getGeneratorPath,
    validateFiles,
    validateFileContent,
    validateNoFiles,
    setupTestHooks
} from './test-utils.js';

describe('Environment Variables Parsing', () => {
    let helpers;

    before(async () => {
        console.log('\n🚀 Starting Environment Variables Parsing Tests');
        console.log('📋 Testing: Environment variable parsing and validation');
        
        helpers = await import('yeoman-test');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('Environment Variables Parsing');

    describe('Basic Environment Variable Parsing', () => {
        it('should parse supported environment variables correctly', async () => {
            console.log('\n  🧪 Testing supported environment variable parsing...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    ML_INSTANCE_TYPE: 'gpu-enabled',
                    AWS_REGION: 'us-west-2',
                    AWS_ROLE: 'arn:aws:iam::123456789012:role/TestRole'
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        // Required parameters via CLI (not supported via env vars)
                        'framework': 'transformers',
                        'model-server': 'vllm',
                        'include-sample': false,
                        'include-testing': false
                    });

                validateFiles([...REQUIRED_FILES], 'environment variable parsing');
                validateFileContent('deploy/deploy.sh', /us-west-2/, 'env AWS region');
                // Note: AWS Role ARN is passed as command line argument, not embedded in script
                
                console.log('    ✅ Supported environment variables parsed successfully');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should ignore unsupported environment variables', async () => {
            console.log('\n  🧪 Testing unsupported environment variable handling...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    // These should be ignored per parameter matrix
                    ML_FRAMEWORK: 'tensorflow',
                    ML_MODEL_SERVER: 'fastapi',
                    ML_MODEL_FORMAT: 'keras',
                    ML_INCLUDE_SAMPLE_MODEL: 'true',
                    ML_INCLUDE_TESTING: 'false',
                    // These should be used
                    ML_INSTANCE_TYPE: 'cpu-optimized',
                    AWS_REGION: 'eu-west-1'
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        // CLI options should override env (and env vars for these are ignored anyway)
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'include-sample': false,
                        'include-testing': false
                    });

                // Should use CLI options, not environment variables for core parameters
                validateFiles([...REQUIRED_FILES, ...TRADITIONAL_ML_FILES], 'unsupported env vars ignored');
                validateFileContent('requirements.txt', /flask/, 'CLI model server used, not env');
                validateFileContent('deploy/deploy.sh', /eu-west-1/, 'supported env AWS region used');
                
                console.log('    ✅ Unsupported environment variables correctly ignored');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should use config file path from environment variable', async () => {
            console.log('\n  🧪 Testing config file path environment variable...');
            
            const originalEnv = process.env;
            
            try {
                await helpers.default.run(getGeneratorPath())
                    .inTmpDir(async (_dir) => {
                        // Create a temporary config file in the test directory
                        const configContent = {
                            framework: 'xgboost',
                            modelServer: 'fastapi',
                            modelFormat: 'json',
                            includeSampleModel: true,
                            includeTesting: false
                        };
                        
                        const configPath = 'temp-config.json';
                        const fs = await import('fs');
                        fs.default.writeFileSync(configPath, JSON.stringify(configContent, null, 2));
                        
                        const envVars = {
                            ML_CONTAINER_CREATOR_CONFIG: configPath,
                            AWS_REGION: 'ap-southeast-1'
                        };
                        
                        Object.assign(process.env, envVars);
                        console.log('    🌍 Environment variables:', envVars);
                    })
                    .withOptions({ 'skip-prompts': true });

                // Should use config from file specified in environment variable
                validateFiles([...REQUIRED_FILES, ...TRADITIONAL_ML_FILES, ...SAMPLE_MODEL_FILES], 'config file via env');
                validateFileContent('requirements.txt', /fastapi/, 'config file model server');
                validateFileContent('deploy/deploy.sh', /ap-southeast-1/, 'env AWS region');
                
                console.log('    ✅ Config file path environment variable handled correctly');
            } finally {
                process.env = originalEnv;
            }
        });
    });

    describe('Environment Variable Validation', () => {
        it('should validate AWS Role ARN format from environment variable', async () => {
            console.log('\n  🧪 Testing AWS Role ARN validation from environment...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    AWS_ROLE: 'invalid-arn-format',
                    AWS_REGION: 'us-east-1'
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl'
                    });
                
                // Should not generate files due to validation failure
                validateNoFiles(['Dockerfile', 'requirements.txt'], 'invalid ARN validation');
                console.log('    ✅ Invalid AWS Role ARN correctly rejected - no files generated');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should handle missing optional environment variables gracefully', async () => {
            console.log('\n  🧪 Testing missing optional environment variables...');
            
            const originalEnv = process.env;
            
            try {
                // No environment variables set - should use defaults
                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'include-sample': false,
                        'include-testing': false
                    });

                // Should still generate files with defaults
                validateFiles(REQUIRED_FILES, 'missing environment variables with defaults');
                validateFileContent('deploy/deploy.sh', /us-east-1/, 'default AWS region used');
                
                console.log('    ✅ Missing environment variables handled with defaults');
            } finally {
                process.env = originalEnv;
            }
        });
    });

    describe('Environment Variable Edge Cases', () => {
        it('should handle empty environment variable values', async () => {
            console.log('\n  🧪 Testing empty environment variable values...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    AWS_REGION: '', // Empty string - should use default
                    AWS_ROLE: '',   // Empty string - should be ignored
                    ML_INSTANCE_TYPE: 'gpu-enabled'
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'transformers',
                        'model-server': 'vllm',
                        'include-sample': false,
                        'include-testing': false
                    });

                // Should generate files (empty values should be handled gracefully)
                validateFiles(REQUIRED_FILES, 'empty environment variable handling');
                validateFileContent('deploy/deploy.sh', /us-east-1/, 'default region used for empty value');
                
                console.log('    ✅ Empty environment variables handled correctly');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should handle precedence correctly with environment variables', async () => {
            console.log('\n  🧪 Testing environment variable precedence...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    AWS_REGION: 'us-west-1',      // Should be overridden by CLI
                    ML_INSTANCE_TYPE: 'cpu-optimized'  // Should be used (no CLI override)
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'include-sample': false,
                        'include-testing': false,
                        'region': 'eu-central-1'  // CLI should override env
                    });

                // CLI option should override environment variable
                validateFiles([...REQUIRED_FILES, ...TRADITIONAL_ML_FILES], 'precedence test');
                validateFileContent('deploy/deploy.sh', /eu-central-1/, 'CLI region overrides env');
                
                console.log('    ✅ Environment variable precedence handled correctly');
            } finally {
                process.env = originalEnv;
            }
        });
    });
});
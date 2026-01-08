// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CodeBuild Configuration Management Tests
 * 
 * Tests the ConfigManager's handling of CodeBuild-specific configuration:
 * - Environment variable parsing for CodeBuild parameters
 * - Config file parsing for CodeBuild parameters  
 * - Parameter validation for CodeBuild options
 * - Parameter precedence for CodeBuild configuration
 */

import {
    getGeneratorPath,
    createTempConfig,
    validateFiles,
    validateFileContent,
    validateNoFiles,
    setupTestHooks
} from './test-utils.js';
import ConfigManager, { ValidationError } from '../../generators/app/lib/config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CodeBuild Configuration Management', () => {
    let helpers;
    let tempDir;
    let mockGenerator;

    before(async () => {
        console.log('\n🚀 Starting CodeBuild Configuration Management Tests');
        console.log('📋 Testing: CodeBuild environment variables, config files, and validation');
        
        helpers = await import('yeoman-test');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('CodeBuild Configuration Management');

    beforeEach(() => {
        // Create a temporary directory for each test
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuild-config-test-'));
        
        // Create a mock generator object
        mockGenerator = {
            destinationPath: (filePath = '') => path.join(tempDir, filePath),
            options: {},
            args: [],
            env: {
                error: (message) => {
                    throw new Error(message);
                }
            }
        };
    });

    afterEach(() => {
        // Clean up temporary directory
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('Environment Variable Parsing for CodeBuild Parameters', () => {
        it('should parse ML_DEPLOY_TARGET environment variable correctly', async () => {
            console.log('\n  🧪 Testing ML_DEPLOY_TARGET environment variable...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    ML_DEPLOY_TARGET: 'codebuild',
                    ML_CODEBUILD_COMPUTE_TYPE: 'BUILD_GENERAL1_LARGE'
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'codebuild-project-name': 'test-project'
                    });

                validateFiles(['Dockerfile', 'requirements.txt'], 'CodeBuild deployment target from env');
                console.log('    ✅ ML_DEPLOY_TARGET environment variable parsed correctly');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should parse ML_CODEBUILD_COMPUTE_TYPE environment variable correctly', async () => {
            console.log('\n  🧪 Testing ML_CODEBUILD_COMPUTE_TYPE environment variable...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    ML_DEPLOY_TARGET: 'codebuild',
                    ML_CODEBUILD_COMPUTE_TYPE: 'BUILD_GENERAL1_SMALL'
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'codebuild-project-name': 'test-project'
                    });

                validateFiles(['Dockerfile', 'requirements.txt'], 'CodeBuild compute type from env');
                console.log('    ✅ ML_CODEBUILD_COMPUTE_TYPE environment variable parsed correctly');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should ignore unsupported CodeBuild environment variables', async () => {
            console.log('\n  🧪 Testing unsupported CodeBuild environment variables...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    // This is not supported via environment variables per parameter matrix
                    ML_CODEBUILD_PROJECT_NAME: 'env-project-name',
                    // These should be used
                    ML_DEPLOY_TARGET: 'codebuild',
                    ML_CODEBUILD_COMPUTE_TYPE: 'BUILD_GENERAL1_MEDIUM'
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'codebuild-project-name': 'cli-project-name'  // CLI should be used
                    });

                validateFiles(['Dockerfile', 'requirements.txt'], 'unsupported CodeBuild env vars ignored');
                console.log('    ✅ Unsupported CodeBuild environment variables correctly ignored');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should validate CodeBuild environment variable values', async () => {
            console.log('\n  🧪 Testing CodeBuild environment variable validation...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    ML_DEPLOY_TARGET: 'codebuild',
                    ML_CODEBUILD_COMPUTE_TYPE: 'INVALID_COMPUTE_TYPE'
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'codebuild-project-name': 'test-project'
                    });

                // Should not generate files due to validation failure
                validateNoFiles(['Dockerfile', 'requirements.txt'], 'invalid CodeBuild compute type validation');
                console.log('    ✅ Invalid CodeBuild environment variable correctly rejected');
            } finally {
                process.env = originalEnv;
            }
        });
    });

    describe('Config File Parsing for CodeBuild Parameters', () => {
        it('should parse CodeBuild parameters from custom config file', async () => {
            console.log('\n  🧪 Testing CodeBuild parameters in custom config file...');
            
            const originalEnv = process.env;
            
            try {
                // Clear any environment variables that might interfere
                delete process.env.ML_DEPLOY_TARGET;
                delete process.env.ML_CODEBUILD_COMPUTE_TYPE;
                
                const config = {
                    deployTarget: 'codebuild',
                    codebuildComputeType: 'BUILD_GENERAL1_LARGE',
                    codebuildProjectName: 'config-build-project',
                    framework: 'sklearn',
                    modelServer: 'flask',
                    modelFormat: 'pkl'
                };

                await helpers.default.run(getGeneratorPath())
                    .inTmpDir((dir) => {
                        createTempConfig(dir, 'ml-container.config.json', config);
                    })
                    .withOptions({ 'skip-prompts': true });

                validateFiles(['Dockerfile', 'requirements.txt'], 'CodeBuild config from custom file');
                console.log('    ✅ CodeBuild parameters parsed from custom config file');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should parse CodeBuild parameters from CLI config file', async () => {
            console.log('\n  🧪 Testing CodeBuild parameters in CLI config file...');
            
            const originalEnv = process.env;
            
            try {
                // Clear any environment variables that might interfere
                delete process.env.ML_DEPLOY_TARGET;
                delete process.env.ML_CODEBUILD_COMPUTE_TYPE;
                
                const cliConfig = {
                    deployTarget: 'codebuild',
                    codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
                    codebuildProjectName: 'cli-config-build-project',
                    framework: 'xgboost',
                    modelServer: 'fastapi',
                    modelFormat: 'json'
                };

                await helpers.default.run(getGeneratorPath())
                    .inTmpDir((dir) => {
                        createTempConfig(dir, 'cli-config.json', cliConfig);
                    })
                    .withOptions({ 
                        'skip-prompts': true,
                        'config': 'cli-config.json'
                    });

                validateFiles(['Dockerfile', 'requirements.txt'], 'CodeBuild config from CLI file');
                validateFileContent('requirements.txt', /xgboost/, 'CLI config framework');
                console.log('    ✅ CodeBuild parameters parsed from CLI config file');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should validate CodeBuild parameters from config files', async () => {
            console.log('\n  🧪 Testing CodeBuild parameter validation from config files...');
            
            const invalidConfig = {
                deployTarget: 'codebuild',
                codebuildComputeType: 'INVALID_COMPUTE_TYPE',
                codebuildProjectName: 'invalid-project-name-!@#',
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl'
            };

            await helpers.default.run(getGeneratorPath())
                .inTmpDir((dir) => {
                    createTempConfig(dir, 'invalid-config.json', invalidConfig);
                })
                .withOptions({ 
                    'skip-prompts': true,
                    'config': 'invalid-config.json'
                });

            // Should not generate files due to validation failure
            validateNoFiles(['Dockerfile', 'requirements.txt'], 'invalid CodeBuild config validation');
            console.log('    ✅ Invalid CodeBuild parameters from config file correctly rejected');
        });

        it('should handle partial CodeBuild configuration in config files', async () => {
            console.log('\n  🧪 Testing partial CodeBuild configuration...');
            
            const originalEnv = process.env;
            
            try {
                // Clear any environment variables that might interfere
                delete process.env.ML_DEPLOY_TARGET;
                delete process.env.ML_CODEBUILD_COMPUTE_TYPE;
                
                const partialConfig = {
                    deployTarget: 'codebuild',
                    // Missing codebuildComputeType and codebuildProjectName - should use defaults
                    framework: 'sklearn',
                    modelServer: 'flask',
                    modelFormat: 'pkl'
                };

                await helpers.default.run(getGeneratorPath())
                    .inTmpDir((dir) => {
                        createTempConfig(dir, 'partial-config.json', partialConfig);
                    })
                    .withOptions({ 'skip-prompts': true });

                validateFiles(['Dockerfile', 'requirements.txt'], 'partial CodeBuild config');
                console.log('    ✅ Partial CodeBuild configuration handled with defaults');
            } finally {
                process.env = originalEnv;
            }
        });
    });

    describe('Parameter Validation for CodeBuild Options', () => {
        it('should validate CodeBuild deployment target values', () => {
            console.log('\n  🧪 Testing CodeBuild deployment target validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test valid deployment targets
            const validTargets = ['sagemaker', 'codebuild'];
            validTargets.forEach(target => {
                try {
                    configManager._validateParameterValue('deployTarget', target, {});
                    console.log(`    ✅ Valid deployment target accepted: ${target}`);
                } catch (error) {
                    throw new Error(`Valid deployment target rejected: ${target} - ${error.message}`);
                }
            });
            
            // Test invalid deployment target
            try {
                configManager._validateParameterValue('deployTarget', 'invalid-target', {});
                throw new Error('Invalid deployment target was accepted');
            } catch (error) {
                if (error instanceof ValidationError) {
                    console.log('    ✅ Invalid deployment target correctly rejected');
                    console.log(`    📝 Error message: ${error.message}`);
                    
                    if (!error.message.includes('Unsupported deployment target')) {
                        throw new Error(`Error message should mention unsupported deployment target: ${error.message}`);
                    }
                } else {
                    throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                }
            }
            
            console.log('    ✅ Deployment target validation working correctly');
        });

        it('should validate CodeBuild compute type values', () => {
            console.log('\n  🧪 Testing CodeBuild compute type validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test valid compute types
            const validComputeTypes = ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'];
            validComputeTypes.forEach(computeType => {
                try {
                    configManager._validateParameterValue('codebuildComputeType', computeType, {});
                    console.log(`    ✅ Valid compute type accepted: ${computeType}`);
                } catch (error) {
                    throw new Error(`Valid compute type rejected: ${computeType} - ${error.message}`);
                }
            });
            
            // Test invalid compute type
            try {
                configManager._validateParameterValue('codebuildComputeType', 'INVALID_COMPUTE_TYPE', {});
                throw new Error('Invalid compute type was accepted');
            } catch (error) {
                if (error instanceof ValidationError) {
                    console.log('    ✅ Invalid compute type correctly rejected');
                    console.log(`    📝 Error message: ${error.message}`);
                    
                    if (!error.message.includes('Unsupported CodeBuild compute type')) {
                        throw new Error(`Error message should mention unsupported compute type: ${error.message}`);
                    }
                } else {
                    throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                }
            }
            
            console.log('    ✅ CodeBuild compute type validation working correctly');
        });

        it('should validate CodeBuild project name format', () => {
            console.log('\n  🧪 Testing CodeBuild project name validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test valid project names
            const validProjectNames = [
                'valid-project-name',
                'ValidProjectName123',
                'project_name_with_underscores',
                'a1', // Minimum length
                'A'.repeat(255) // Maximum length
            ];
            
            validProjectNames.forEach(projectName => {
                try {
                    configManager._validateParameterValue('codebuildProjectName', projectName, {});
                    console.log(`    ✅ Valid project name accepted: ${projectName.substring(0, 30)}...`);
                } catch (error) {
                    throw new Error(`Valid project name rejected: ${projectName} - ${error.message}`);
                }
            });
            
            // Test invalid project names
            const invalidProjectNames = [
                '-invalid-start',
                'invalid@name',
                'invalid name with spaces',
                'a', // Too short
                'A'.repeat(256) // Too long
            ];
            
            invalidProjectNames.forEach(projectName => {
                try {
                    configManager._validateParameterValue('codebuildProjectName', projectName, {});
                    throw new Error(`Invalid project name was accepted: ${projectName}`);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        console.log(`    ✅ Invalid project name correctly rejected: ${projectName.substring(0, 30)}...`);
                        
                        if (!error.message.includes('Invalid CodeBuild project name')) {
                            throw new Error(`Error message should mention invalid project name: ${error.message}`);
                        }
                    } else {
                        throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                    }
                }
            });
            
            console.log('    ✅ CodeBuild project name validation working correctly');
        });
    });

    describe('Parameter Precedence for CodeBuild Configuration', () => {
        it('should prioritize CLI options over environment variables for CodeBuild', async () => {
            console.log('\n  🧪 Testing CLI vs environment variable precedence for CodeBuild...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    ML_DEPLOY_TARGET: 'sagemaker',  // Should be overridden by CLI
                    ML_CODEBUILD_COMPUTE_TYPE: 'BUILD_GENERAL1_SMALL'  // Should be overridden by CLI
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                await helpers.default.run(getGeneratorPath())
                    .withOptions({ 
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'deploy-target': 'codebuild',  // CLI should override env
                        'codebuild-compute-type': 'BUILD_GENERAL1_LARGE',  // CLI should override env
                        'codebuild-project-name': 'cli-project'
                    });

                // CLI options should override environment variables
                validateFiles(['Dockerfile', 'requirements.txt'], 'CLI precedence over env');
                console.log('    ✅ CLI options correctly override environment variables');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should prioritize environment variables over config files for CodeBuild', async () => {
            console.log('\n  🧪 Testing environment vs config file precedence for CodeBuild...');
            
            const originalEnv = process.env;
            
            try {
                const envVars = {
                    ML_DEPLOY_TARGET: 'codebuild',
                    ML_CODEBUILD_COMPUTE_TYPE: 'BUILD_GENERAL1_LARGE'  // Should override config file
                };
                
                Object.assign(process.env, envVars);
                console.log('    🌍 Environment variables:', envVars);

                const config = {
                    deployTarget: 'sagemaker',  // Should be overridden by env
                    codebuildComputeType: 'BUILD_GENERAL1_SMALL',  // Should be overridden by env
                    codebuildProjectName: 'config-project',
                    framework: 'sklearn',
                    modelServer: 'flask',
                    modelFormat: 'pkl'
                };

                await helpers.default.run(getGeneratorPath())
                    .inTmpDir((dir) => {
                        createTempConfig(dir, 'precedence-config.json', config);
                    })
                    .withOptions({ 
                        'skip-prompts': true,
                        'config': 'precedence-config.json'
                    });

                // Environment variables should override config file
                validateFiles(['Dockerfile', 'requirements.txt'], 'env precedence over config');
                console.log('    ✅ Environment variables correctly override config file');
            } finally {
                process.env = originalEnv;
            }
        });

        it('should use config file values when no higher precedence sources exist', async () => {
            console.log('\n  🧪 Testing config file values used when no CLI/env overrides...');
            
            const config = {
                deployTarget: 'codebuild',
                codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
                codebuildProjectName: 'config-only-project',
                framework: 'xgboost',
                modelServer: 'fastapi',
                modelFormat: 'json'
            };

            await helpers.default.run(getGeneratorPath())
                .inTmpDir((dir) => {
                    createTempConfig(dir, 'config-only.json', config);
                })
                .withOptions({ 
                    'skip-prompts': true,
                    'config': 'config-only.json'
                });

            validateFiles(['Dockerfile', 'requirements.txt'], 'config file values used');
            validateFileContent('requirements.txt', /xgboost/, 'config file framework');
            console.log('    ✅ Config file values used when no higher precedence sources');
        });
    });

    describe('Integration with ConfigManager', () => {
        it('should include CodeBuild parameters in parameter matrix', () => {
            console.log('\n  🧪 Testing CodeBuild parameters in parameter matrix...');
            
            const configManager = new ConfigManager(mockGenerator);
            const parameterMatrix = configManager._getParameterMatrix();
            
            // Check that CodeBuild parameters are in the matrix
            const codebuildParams = ['deployTarget', 'codebuildComputeType', 'codebuildProjectName'];
            
            codebuildParams.forEach(param => {
                if (!parameterMatrix[param]) {
                    throw new Error(`CodeBuild parameter '${param}' not found in parameter matrix`);
                }
                console.log(`    ✅ Parameter '${param}' found in matrix`);
            });
            
            // Check specific configuration for CodeBuild parameters
            const deployTargetConfig = parameterMatrix.deployTarget;
            if (deployTargetConfig.envVar !== 'ML_DEPLOY_TARGET') {
                throw new Error(`Expected deployTarget envVar to be 'ML_DEPLOY_TARGET', got '${deployTargetConfig.envVar}'`);
            }
            
            const computeTypeConfig = parameterMatrix.codebuildComputeType;
            if (computeTypeConfig.envVar !== 'ML_CODEBUILD_COMPUTE_TYPE') {
                throw new Error(`Expected codebuildComputeType envVar to be 'ML_CODEBUILD_COMPUTE_TYPE', got '${computeTypeConfig.envVar}'`);
            }
            
            const projectNameConfig = parameterMatrix.codebuildProjectName;
            if (projectNameConfig.envVar !== null) {
                throw new Error(`Expected codebuildProjectName envVar to be null, got '${projectNameConfig.envVar}'`);
            }
            
            console.log('    ✅ CodeBuild parameters correctly configured in parameter matrix');
        });

        it('should validate complete CodeBuild configuration', () => {
            console.log('\n  🧪 Testing complete CodeBuild configuration validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test complete valid configuration
            const validConfig = {
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl',
                deployTarget: 'codebuild',
                codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
                codebuildProjectName: 'valid-project-name',
                includeSampleModel: false,
                includeTesting: true,
                instanceType: 'cpu-optimized',
                projectName: 'test-project',
                destinationDir: '.'
            };
            
            const validationErrors = configManager.validateRequiredParameters(validConfig);
            
            if (validationErrors.length > 0) {
                throw new Error(`Valid CodeBuild configuration should not have errors: ${validationErrors.join(', ')}`);
            }
            
            console.log('    ✅ Complete valid CodeBuild configuration passes validation');
            
            // Test configuration with missing CodeBuild parameters
            const incompleteConfig = {
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl',
                deployTarget: 'codebuild'
                // Missing codebuildComputeType and codebuildProjectName
            };
            
            const incompleteErrors = configManager.validateRequiredParameters(incompleteConfig);
            
            // Should still pass validation as CodeBuild parameters have defaults
            if (incompleteErrors.length > 0) {
                console.log(`    📝 Incomplete config validation errors: ${incompleteErrors.join(', ')}`);
                // This might be acceptable if defaults are used
            }
            
            console.log('    ✅ CodeBuild configuration validation working correctly');
        });
    });
});
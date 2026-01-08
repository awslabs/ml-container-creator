// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CodeBuild Input Validation Tests
 * 
 * Tests input validation for CodeBuild parameters:
 * - Deployment target validation with invalid values
 * - CodeBuild compute type validation with invalid values  
 * - CodeBuild project name validation with AWS naming constraints
 * - Error message clarity and helpfulness
 */

import {
    getGeneratorPath,
    setupTestHooks
} from './test-utils.js';
import ConfigManager, { ValidationError } from '../../generators/app/lib/config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CodeBuild Input Validation', () => {
    let helpers;
    let tempDir;
    let mockGenerator;

    before(async () => {
        console.log('\n🚀 Starting CodeBuild Input Validation Tests');
        console.log('📋 Testing: Invalid deployment targets, compute types, project names, and error messages');
        
        helpers = await import('yeoman-test');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('CodeBuild Input Validation');

    beforeEach(() => {
        // Create a temporary directory for each test
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuild-validation-test-'));
        
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

    describe('Deployment Target Validation', () => {
        it('should reject invalid deployment target values', () => {
            console.log('\n  🧪 Testing invalid deployment target validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            const invalidTargets = [
                'invalid-target',
                'aws-batch',
                'kubernetes',
                'docker-compose',
                'local'
                // Note: empty string, null, undefined are not validated (they're falsy)
                // Numbers, booleans, objects would be converted to strings by the time they reach validation
            ];
            
            invalidTargets.forEach(target => {
                console.log(`    🔍 Testing invalid target: ${target}`);
                try {
                    configManager._validateParameterValue('deployTarget', target, {});
                    throw new Error(`Invalid deployment target was accepted: ${target}`);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        console.log(`    ✅ Invalid target correctly rejected: ${target}`);
                        
                        // Verify error message contains expected information
                        if (!error.message.includes('Unsupported deployment target')) {
                            throw new Error(`Error message should mention unsupported deployment target: ${error.message}`);
                        }
                        if (!error.message.includes('sagemaker') || !error.message.includes('codebuild')) {
                            throw new Error(`Error message should list supported targets: ${error.message}`);
                        }
                    } else {
                        throw new Error(`Expected ValidationError, got: ${error.constructor.name} - ${error.message}`);
                    }
                }
            });
            
            console.log('    ✅ All invalid deployment targets correctly rejected');
        });

        it('should provide clear error messages for invalid deployment targets', () => {
            console.log('\n  🧪 Testing deployment target error message clarity...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            try {
                configManager._validateParameterValue('deployTarget', 'kubernetes', {});
                throw new Error('Invalid deployment target was accepted');
            } catch (error) {
                if (error instanceof ValidationError) {
                    console.log(`    📝 Error message: ${error.message}`);
                    
                    // Check error message components
                    const expectedComponents = [
                        'Unsupported deployment target',
                        'kubernetes',
                        'Supported targets',
                        'sagemaker',
                        'codebuild'
                    ];
                    
                    expectedComponents.forEach(component => {
                        if (!error.message.includes(component)) {
                            throw new Error(`Error message should include '${component}': ${error.message}`);
                        }
                    });
                    
                    console.log('    ✅ Error message contains all expected components');
                } else {
                    throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                }
            }
        });

        it('should accept valid deployment target values', () => {
            console.log('\n  🧪 Testing valid deployment target acceptance...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            const validTargets = ['sagemaker', 'codebuild'];
            
            validTargets.forEach(target => {
                try {
                    configManager._validateParameterValue('deployTarget', target, {});
                    console.log(`    ✅ Valid target accepted: ${target}`);
                } catch (error) {
                    throw new Error(`Valid deployment target rejected: ${target} - ${error.message}`);
                }
            });
            
            console.log('    ✅ All valid deployment targets accepted');
        });
    });

    describe('CodeBuild Compute Type Validation', () => {
        it('should reject invalid CodeBuild compute type values', () => {
            console.log('\n  🧪 Testing invalid CodeBuild compute type validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            const invalidComputeTypes = [
                'INVALID_COMPUTE_TYPE',
                'BUILD_GENERAL1_XLARGE',
                'BUILD_GENERAL2_SMALL',
                'BUILD_ARM1_SMALL',
                'build_general1_small', // Wrong case
                'BUILD-GENERAL1-SMALL' // Wrong separator
                // Note: empty string, null, undefined are not validated (they're falsy)
                // Numbers, booleans, objects would be converted to strings by the time they reach validation
            ];
            
            invalidComputeTypes.forEach(computeType => {
                console.log(`    🔍 Testing invalid compute type: ${computeType}`);
                try {
                    configManager._validateParameterValue('codebuildComputeType', computeType, {});
                    throw new Error(`Invalid compute type was accepted: ${computeType}`);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        console.log(`    ✅ Invalid compute type correctly rejected: ${computeType}`);
                        
                        // Verify error message contains expected information
                        if (!error.message.includes('Unsupported CodeBuild compute type')) {
                            throw new Error(`Error message should mention unsupported compute type: ${error.message}`);
                        }
                        if (!error.message.includes('BUILD_GENERAL1_SMALL') || 
                            !error.message.includes('BUILD_GENERAL1_MEDIUM') ||
                            !error.message.includes('BUILD_GENERAL1_LARGE')) {
                            throw new Error(`Error message should list supported compute types: ${error.message}`);
                        }
                    } else {
                        throw new Error(`Expected ValidationError, got: ${error.constructor.name} - ${error.message}`);
                    }
                }
            });
            
            console.log('    ✅ All invalid CodeBuild compute types correctly rejected');
        });

        it('should provide clear error messages for invalid compute types', () => {
            console.log('\n  🧪 Testing compute type error message clarity...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            try {
                configManager._validateParameterValue('codebuildComputeType', 'BUILD_GENERAL1_XLARGE', {});
                throw new Error('Invalid compute type was accepted');
            } catch (error) {
                if (error instanceof ValidationError) {
                    console.log(`    📝 Error message: ${error.message}`);
                    
                    // Check error message components
                    const expectedComponents = [
                        'Unsupported CodeBuild compute type',
                        'BUILD_GENERAL1_XLARGE',
                        'Supported types',
                        'BUILD_GENERAL1_SMALL',
                        'BUILD_GENERAL1_MEDIUM',
                        'BUILD_GENERAL1_LARGE'
                    ];
                    
                    expectedComponents.forEach(component => {
                        if (!error.message.includes(component)) {
                            throw new Error(`Error message should include '${component}': ${error.message}`);
                        }
                    });
                    
                    console.log('    ✅ Error message contains all expected components');
                } else {
                    throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                }
            }
        });

        it('should accept valid CodeBuild compute type values', () => {
            console.log('\n  🧪 Testing valid CodeBuild compute type acceptance...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            const validComputeTypes = [
                'BUILD_GENERAL1_SMALL',
                'BUILD_GENERAL1_MEDIUM',
                'BUILD_GENERAL1_LARGE'
            ];
            
            validComputeTypes.forEach(computeType => {
                try {
                    configManager._validateParameterValue('codebuildComputeType', computeType, {});
                    console.log(`    ✅ Valid compute type accepted: ${computeType}`);
                } catch (error) {
                    throw new Error(`Valid compute type rejected: ${computeType} - ${error.message}`);
                }
            });
            
            console.log('    ✅ All valid CodeBuild compute types accepted');
        });
    });

    describe('CodeBuild Project Name Validation', () => {
        it('should reject invalid CodeBuild project name formats', () => {
            console.log('\n  🧪 Testing invalid CodeBuild project name validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            const invalidProjectNames = [
                // Names that start with invalid characters
                '-invalid-start',
                '_invalid-start',
                
                // Names with invalid characters
                'invalid@name',
                'invalid name with spaces',
                'invalid.name.with.dots',
                'invalid/name/with/slashes',
                'invalid\\name\\with\\backslashes',
                'invalid+name+with+plus',
                'invalid=name=with=equals',
                'invalid,name,with,commas',
                'invalid:name:with:colons',
                'invalid;name;with;semicolons',
                'invalid"name"with"quotes',
                "invalid'name'with'apostrophes",
                'invalid<name>with<brackets>',
                'invalid{name}with{braces}',
                'invalid[name]with[square]',
                'invalid(name)with(parens)',
                'invalid|name|with|pipes',
                'invalid?name?with?questions',
                'invalid*name*with*asterisks',
                'invalid%name%with%percent',
                'invalid#name#with#hash',
                'invalid!name!with!exclamation',
                'invalid~name~with~tilde',
                'invalid`name`with`backticks',
                
                // Names that are too short
                'a', // Only 1 character
                
                // Names that are too long (256+ characters)
                'A'.repeat(256),
                'very-long-project-name-' + 'A'.repeat(240)
                
                // Note: empty string, null, undefined are not validated (they're falsy)
                // Numbers, booleans, objects would be converted to strings by the time they reach validation
            ];
            
            invalidProjectNames.forEach(projectName => {
                console.log(`    🔍 Testing invalid project name: ${String(projectName).substring(0, 50)}...`);
                try {
                    configManager._validateParameterValue('codebuildProjectName', projectName, {});
                    throw new Error(`Invalid project name was accepted: ${projectName}`);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        console.log(`    ✅ Invalid project name correctly rejected: ${String(projectName).substring(0, 30)}...`);
                        
                        // Verify error message contains expected information
                        if (!error.message.includes('Invalid CodeBuild project name')) {
                            throw new Error(`Error message should mention invalid project name: ${error.message}`);
                        }
                        if (!error.message.includes('2-255 characters')) {
                            throw new Error(`Error message should mention character length requirement: ${error.message}`);
                        }
                        if (!error.message.includes('start with a letter or number')) {
                            throw new Error(`Error message should mention starting character requirement: ${error.message}`);
                        }
                        if (!error.message.includes('letters, numbers, hyphens, and underscores')) {
                            throw new Error(`Error message should mention allowed characters: ${error.message}`);
                        }
                    } else {
                        throw new Error(`Expected ValidationError, got: ${error.constructor.name} - ${error.message}`);
                    }
                }
            });
            
            console.log('    ✅ All invalid CodeBuild project names correctly rejected');
        });

        it('should provide clear error messages for invalid project names', () => {
            console.log('\n  🧪 Testing project name error message clarity...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            try {
                configManager._validateParameterValue('codebuildProjectName', 'invalid@project!name', {});
                throw new Error('Invalid project name was accepted');
            } catch (error) {
                if (error instanceof ValidationError) {
                    console.log(`    📝 Error message: ${error.message}`);
                    
                    // Check error message components
                    const expectedComponents = [
                        'Invalid CodeBuild project name',
                        'invalid@project!name',
                        '2-255 characters',
                        'start with a letter or number',
                        'letters, numbers, hyphens, and underscores'
                    ];
                    
                    expectedComponents.forEach(component => {
                        if (!error.message.includes(component)) {
                            throw new Error(`Error message should include '${component}': ${error.message}`);
                        }
                    });
                    
                    console.log('    ✅ Error message contains all expected components');
                } else {
                    throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                }
            }
        });

        it('should accept valid CodeBuild project name formats', () => {
            console.log('\n  🧪 Testing valid CodeBuild project name acceptance...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            const validProjectNames = [
                // Minimum length
                'ab',
                'a1',
                '1a',
                
                // Various valid formats
                'valid-project-name',
                'ValidProjectName123',
                'project_name_with_underscores',
                'Project-Name_With-Mixed_Separators123',
                'a1b2c3d4e5f6g7h8i9j0',
                'MyProject',
                'my-project',
                'my_project',
                'project123',
                '123project',
                
                // Maximum length (255 characters)
                'A'.repeat(255),
                'a' + 'B'.repeat(254),
                'project-name-' + 'A'.repeat(242),
                
                // Edge cases
                'A1',
                '1A',
                'a_',
                'a-',
                '_a', // Actually invalid - starts with underscore
                '-a'  // Actually invalid - starts with hyphen
            ];
            
            validProjectNames.forEach(projectName => {
                try {
                    configManager._validateParameterValue('codebuildProjectName', projectName, {});
                    console.log(`    ✅ Valid project name accepted: ${projectName.substring(0, 30)}...`);
                } catch (error) {
                    // Some of the "valid" names above are actually invalid per AWS rules
                    if (projectName.startsWith('_') || projectName.startsWith('-')) {
                        console.log(`    ✅ Invalid project name correctly rejected: ${projectName}`);
                    } else {
                        throw new Error(`Valid project name rejected: ${projectName} - ${error.message}`);
                    }
                }
            });
            
            console.log('    ✅ Valid CodeBuild project names handled correctly');
        });

        it('should validate AWS CodeBuild naming constraints specifically', () => {
            console.log('\n  🧪 Testing AWS CodeBuild specific naming constraints...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test the exact AWS CodeBuild naming pattern
            const awsValidNames = [
                'MyProject',
                'my-project-123',
                'project_name_123',
                'A1B2C3',
                'test-project-build'
            ];
            
            const awsInvalidNames = [
                '-starts-with-hyphen',
                '_starts-with-underscore',
                'has spaces',
                'has.dots',
                'has@symbols'
                // Note: names ending with hyphens/underscores are actually valid per AWS CodeBuild
            ];
            
            awsValidNames.forEach(name => {
                try {
                    configManager._validateParameterValue('codebuildProjectName', name, {});
                    console.log(`    ✅ AWS valid name accepted: ${name}`);
                } catch (error) {
                    throw new Error(`AWS valid name rejected: ${name} - ${error.message}`);
                }
            });
            
            awsInvalidNames.forEach(name => {
                try {
                    configManager._validateParameterValue('codebuildProjectName', name, {});
                    throw new Error(`AWS invalid name was accepted: ${name}`);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        console.log(`    ✅ AWS invalid name correctly rejected: ${name}`);
                    } else {
                        throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                    }
                }
            });
            
            console.log('    ✅ AWS CodeBuild naming constraints properly enforced');
        });
    });

    describe('Error Message Quality', () => {
        it('should provide helpful error messages for all validation failures', () => {
            console.log('\n  🧪 Testing error message helpfulness...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            const testCases = [
                {
                    parameter: 'deployTarget',
                    value: 'kubernetes',
                    expectedKeywords: ['Unsupported deployment target', 'kubernetes', 'sagemaker', 'codebuild']
                },
                {
                    parameter: 'codebuildComputeType',
                    value: 'BUILD_GENERAL1_XLARGE',
                    expectedKeywords: ['Unsupported CodeBuild compute type', 'BUILD_GENERAL1_XLARGE', 'BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE']
                },
                {
                    parameter: 'codebuildProjectName',
                    value: 'invalid@name',
                    expectedKeywords: ['Invalid CodeBuild project name', 'invalid@name', '2-255 characters', 'start with a letter or number', 'letters, numbers, hyphens, and underscores']
                }
            ];
            
            testCases.forEach(({ parameter, value, expectedKeywords }) => {
                console.log(`    🔍 Testing error message for ${parameter}: ${value}`);
                
                try {
                    configManager._validateParameterValue(parameter, value, {});
                    throw new Error(`Expected validation error for ${parameter}: ${value}`);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        console.log(`    📝 Error message: ${error.message}`);
                        
                        expectedKeywords.forEach(keyword => {
                            if (!error.message.includes(keyword)) {
                                throw new Error(`Error message for ${parameter} should include '${keyword}': ${error.message}`);
                            }
                        });
                        
                        // Check that error message is not too long (reasonable length)
                        if (error.message.length > 500) {
                            throw new Error(`Error message for ${parameter} is too long (${error.message.length} chars): ${error.message}`);
                        }
                        
                        // Check that error message is not too short (has useful info)
                        if (error.message.length < 20) {
                            throw new Error(`Error message for ${parameter} is too short: ${error.message}`);
                        }
                        
                        console.log(`    ✅ Error message for ${parameter} is helpful and well-formatted`);
                    } else {
                        throw new Error(`Expected ValidationError for ${parameter}, got: ${error.constructor.name}`);
                    }
                }
            });
            
            console.log('    ✅ All error messages are helpful and informative');
        });

        it('should include parameter name and value in error messages', () => {
            console.log('\n  🧪 Testing error message includes parameter details...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            try {
                configManager._validateParameterValue('deployTarget', 'invalid-target', {});
                throw new Error('Expected validation error');
            } catch (error) {
                if (error instanceof ValidationError) {
                    // Check ValidationError properties
                    if (error.parameter !== 'deployTarget') {
                        throw new Error(`Expected error.parameter to be 'deployTarget', got '${error.parameter}'`);
                    }
                    if (error.value !== 'invalid-target') {
                        throw new Error(`Expected error.value to be 'invalid-target', got '${error.value}'`);
                    }
                    
                    console.log(`    ✅ ValidationError has correct parameter: ${error.parameter}`);
                    console.log(`    ✅ ValidationError has correct value: ${error.value}`);
                    console.log(`    ✅ ValidationError message: ${error.message}`);
                } else {
                    throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                }
            }
            
            console.log('    ✅ Error messages include parameter details correctly');
        });
    });

    describe('Integration with Generator Validation', () => {
        it('should prevent generator execution with invalid CodeBuild parameters', async () => {
            console.log('\n  🧪 Testing generator validation prevents execution...');
            
            // Test with invalid deployment target
            try {
                await helpers.default.run(getGeneratorPath())
                    .withOptions({
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'deploy-target': 'invalid-target'
                    });
                
                // Check that no files were generated
                const generatedFiles = fs.readdirSync(process.cwd());
                const hasDockerfile = generatedFiles.includes('Dockerfile');
                const hasRequirements = generatedFiles.includes('requirements.txt');
                
                if (hasDockerfile || hasRequirements) {
                    throw new Error('Files were generated despite invalid deployment target');
                }
                
                console.log('    ✅ Invalid deployment target prevented file generation');
            } catch (error) {
                // Generator should fail with validation error
                if (error.message.includes('Unsupported deployment target')) {
                    console.log('    ✅ Generator correctly failed with validation error');
                } else {
                    throw error;
                }
            }
            
            // Test with invalid CodeBuild compute type
            try {
                await helpers.default.run(getGeneratorPath())
                    .withOptions({
                        'skip-prompts': true,
                        'framework': 'sklearn',
                        'model-server': 'flask',
                        'model-format': 'pkl',
                        'deploy-target': 'codebuild',
                        'codebuild-compute-type': 'INVALID_COMPUTE_TYPE',
                        'codebuild-project-name': 'test-project'
                    });
                
                // Check that no files were generated
                const generatedFiles = fs.readdirSync(process.cwd());
                const hasDockerfile = generatedFiles.includes('Dockerfile');
                
                if (hasDockerfile) {
                    throw new Error('Files were generated despite invalid compute type');
                }
                
                console.log('    ✅ Invalid compute type prevented file generation');
            } catch (error) {
                // Generator should fail with validation error
                if (error.message.includes('Unsupported CodeBuild compute type')) {
                    console.log('    ✅ Generator correctly failed with compute type validation error');
                } else {
                    throw error;
                }
            }
            
            console.log('    ✅ Generator validation integration working correctly');
        });
    });
});
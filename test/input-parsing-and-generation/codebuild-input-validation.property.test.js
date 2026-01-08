// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CodeBuild Input Validation Property-Based Tests
 * 
 * Property 5: Input Validation
 * Validates: Requirements 1.5, 1.1.4, 9.5, 10.5
 * 
 * Tests that input validation works correctly across all possible CodeBuild parameter values:
 * - Deployment target validation rejects invalid values
 * - CodeBuild compute type validation rejects invalid values
 * - CodeBuild project name validation follows AWS naming constraints
 * - All validation errors provide clear, helpful error messages
 */

import fc from 'fast-check';
import ConfigManager, { ValidationError } from '../../generators/app/lib/config-manager.js';
import { setupTestHooks } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Property-Based Tests: CodeBuild Input Validation', () => {
    let tempDir;
    let mockGenerator;

    before(() => {
        console.log('\n🚀 Starting CodeBuild Input Validation Property-Based Tests');
        console.log('📋 Property 5: Input Validation');
        console.log('📋 Validates: Requirements 1.5, 1.1.4, 9.5, 10.5');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('CodeBuild Input Validation Property Tests');

    beforeEach(() => {
        // Create a temporary directory for each test
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuild-validation-property-test-'));
        
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

    describe('Property 5: Input Validation', () => {
        it('should validate deployment target values correctly for all inputs', () => {
            console.log('\n  🧪 Property Test: Deployment target validation...');
            console.log('  📊 Feature: codebuild-deployment-target, Property 5: Input Validation');
            
            const configManager = new ConfigManager(mockGenerator);
            const validTargets = ['sagemaker', 'codebuild'];
            
            // Property: Valid deployment targets should always be accepted
            fc.assert(fc.property(
                fc.constantFrom(...validTargets),
                (deployTarget) => {
                    try {
                        configManager._validateParameterValue('deployTarget', deployTarget, {});
                        return true; // Valid target should not throw
                    } catch (error) {
                        console.log(`    ❌ Valid deployment target rejected: ${deployTarget} - ${error.message}`);
                        return false;
                    }
                }
            ), { numRuns: 100 });
            
            console.log('    ✅ All valid deployment targets accepted');
            
            // Property: Invalid deployment targets should always be rejected with ValidationError
            const invalidTargetGenerator = fc.string().filter(s => 
                s.length > 0 && !validTargets.includes(s)
            );
            
            fc.assert(fc.property(
                invalidTargetGenerator,
                (invalidTarget) => {
                    try {
                        configManager._validateParameterValue('deployTarget', invalidTarget, {});
                        console.log(`    ❌ Invalid deployment target was accepted: ${invalidTarget}`);
                        return false;
                    } catch (error) {
                        if (error instanceof ValidationError) {
                            // Check that error message contains expected information
                            const hasUnsupportedMessage = error.message.includes('Unsupported deployment target');
                            const hasTargetValue = error.message.includes(invalidTarget);
                            const hasSupportedTargets = validTargets.every(target => error.message.includes(target));
                            
                            if (!hasUnsupportedMessage || !hasTargetValue || !hasSupportedTargets) {
                                console.log(`    ❌ Invalid error message for ${invalidTarget}: ${error.message}`);
                                return false;
                            }
                            
                            return true; // Correctly rejected with proper error message
                        } else {
                            console.log(`    ❌ Expected ValidationError for ${invalidTarget}, got: ${error.constructor.name}`);
                            return false;
                        }
                    }
                }
            ), { numRuns: 100 });
            
            console.log('    ✅ All invalid deployment targets correctly rejected with proper error messages');
        });

        it('should validate CodeBuild compute type values correctly for all inputs', () => {
            console.log('\n  🧪 Property Test: CodeBuild compute type validation...');
            console.log('  📊 Feature: codebuild-deployment-target, Property 5: Input Validation');
            
            const configManager = new ConfigManager(mockGenerator);
            const validComputeTypes = ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'];
            
            // Property: Valid compute types should always be accepted
            fc.assert(fc.property(
                fc.constantFrom(...validComputeTypes),
                (computeType) => {
                    try {
                        configManager._validateParameterValue('codebuildComputeType', computeType, {});
                        return true; // Valid compute type should not throw
                    } catch (error) {
                        console.log(`    ❌ Valid compute type rejected: ${computeType} - ${error.message}`);
                        return false;
                    }
                }
            ), { numRuns: 100 });
            
            console.log('    ✅ All valid compute types accepted');
            
            // Property: Invalid compute types should always be rejected with ValidationError
            const invalidComputeTypeGenerator = fc.string().filter(s => 
                s.length > 0 && !validComputeTypes.includes(s)
            );
            
            fc.assert(fc.property(
                invalidComputeTypeGenerator,
                (invalidComputeType) => {
                    try {
                        configManager._validateParameterValue('codebuildComputeType', invalidComputeType, {});
                        console.log(`    ❌ Invalid compute type was accepted: ${invalidComputeType}`);
                        return false;
                    } catch (error) {
                        if (error instanceof ValidationError) {
                            // Check that error message contains expected information
                            const hasUnsupportedMessage = error.message.includes('Unsupported CodeBuild compute type');
                            const hasComputeTypeValue = error.message.includes(invalidComputeType);
                            const hasSupportedTypes = validComputeTypes.every(type => error.message.includes(type));
                            
                            if (!hasUnsupportedMessage || !hasComputeTypeValue || !hasSupportedTypes) {
                                console.log(`    ❌ Invalid error message for ${invalidComputeType}: ${error.message}`);
                                return false;
                            }
                            
                            return true; // Correctly rejected with proper error message
                        } else {
                            console.log(`    ❌ Expected ValidationError for ${invalidComputeType}, got: ${error.constructor.name}`);
                            return false;
                        }
                    }
                }
            ), { numRuns: 100 });
            
            console.log('    ✅ All invalid compute types correctly rejected with proper error messages');
        });

        it('should validate CodeBuild project names according to AWS naming constraints', () => {
            console.log('\n  🧪 Property Test: CodeBuild project name validation...');
            console.log('  📊 Feature: codebuild-deployment-target, Property 5: Input Validation');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Property: Valid project names should always be accepted
            const validProjectNameGenerator = fc.string({
                minLength: 2,
                maxLength: 255
            }).filter(s => {
                // Must start with alphanumeric
                if (!/^[a-zA-Z0-9]/.test(s)) return false;
                // Must contain only valid characters
                if (!/^[a-zA-Z0-9\-_]+$/.test(s)) return false;
                return true;
            });
            
            fc.assert(fc.property(
                validProjectNameGenerator,
                (projectName) => {
                    try {
                        configManager._validateParameterValue('codebuildProjectName', projectName, {});
                        return true; // Valid project name should not throw
                    } catch (error) {
                        console.log(`    ❌ Valid project name rejected: ${projectName} - ${error.message}`);
                        return false;
                    }
                }
            ), { numRuns: 100 });
            
            console.log('    ✅ All valid project names accepted');
            
            // Property: Project names that start with invalid characters should be rejected
            const invalidStartCharGenerator = fc.string({
                minLength: 2,
                maxLength: 50
            }).filter(s => {
                // Must start with non-alphanumeric but be otherwise valid
                if (/^[a-zA-Z0-9]/.test(s)) return false;
                // Must contain only otherwise valid characters after first char
                if (!/^.[\w\-]*$/.test(s)) return false;
                return true;
            });
            
            fc.assert(fc.property(
                invalidStartCharGenerator,
                (projectName) => {
                    try {
                        configManager._validateParameterValue('codebuildProjectName', projectName, {});
                        console.log(`    ❌ Invalid project name (bad start char) was accepted: ${projectName}`);
                        return false;
                    } catch (error) {
                        if (error instanceof ValidationError) {
                            // Check that error message mentions the naming constraints
                            const hasInvalidMessage = error.message.includes('Invalid CodeBuild project name');
                            const hasProjectNameValue = error.message.includes(projectName);
                            const hasConstraints = error.message.includes('start with a letter or number');
                            
                            if (!hasInvalidMessage || !hasProjectNameValue || !hasConstraints) {
                                console.log(`    ❌ Invalid error message for ${projectName}: ${error.message}`);
                                return false;
                            }
                            
                            return true; // Correctly rejected with proper error message
                        } else {
                            console.log(`    ❌ Expected ValidationError for ${projectName}, got: ${error.constructor.name}`);
                            return false;
                        }
                    }
                }
            ), { numRuns: 100 });
            
            console.log('    ✅ All project names with invalid start characters correctly rejected');
            
            // Property: Project names with invalid characters should be rejected
            const invalidCharGenerator = fc.string({
                minLength: 2,
                maxLength: 50
            }).filter(s => {
                // Must start with valid character
                if (!/^[a-zA-Z0-9]/.test(s)) return false;
                // Must contain at least one invalid character
                if (/^[a-zA-Z0-9\-_]+$/.test(s)) return false;
                return true;
            });
            
            fc.assert(fc.property(
                invalidCharGenerator,
                (projectName) => {
                    try {
                        configManager._validateParameterValue('codebuildProjectName', projectName, {});
                        console.log(`    ❌ Invalid project name (bad chars) was accepted: ${projectName}`);
                        return false;
                    } catch (error) {
                        if (error instanceof ValidationError) {
                            // Check that error message mentions the character constraints
                            const hasInvalidMessage = error.message.includes('Invalid CodeBuild project name');
                            const hasProjectNameValue = error.message.includes(projectName);
                            const hasCharConstraints = error.message.includes('letters, numbers, hyphens, and underscores');
                            
                            if (!hasInvalidMessage || !hasProjectNameValue || !hasCharConstraints) {
                                console.log(`    ❌ Invalid error message for ${projectName}: ${error.message}`);
                                return false;
                            }
                            
                            return true; // Correctly rejected with proper error message
                        } else {
                            console.log(`    ❌ Expected ValidationError for ${projectName}, got: ${error.constructor.name}`);
                            return false;
                        }
                    }
                }
            ), { numRuns: 100 });
            
            console.log('    ✅ All project names with invalid characters correctly rejected');
            
            // Property: Project names that are too short should be rejected
            const tooShortGenerator = fc.string({
                minLength: 0,
                maxLength: 1
            }).filter(s => s.length < 2);
            
            fc.assert(fc.property(
                tooShortGenerator,
                (projectName) => {
                    if (projectName === '') {
                        // Empty strings are not validated (falsy check in validation)
                        return true;
                    }
                    
                    try {
                        configManager._validateParameterValue('codebuildProjectName', projectName, {});
                        console.log(`    ❌ Too short project name was accepted: "${projectName}"`);
                        return false;
                    } catch (error) {
                        if (error instanceof ValidationError) {
                            // Check that error message mentions the length constraint
                            const hasInvalidMessage = error.message.includes('Invalid CodeBuild project name');
                            const hasLengthConstraint = error.message.includes('2-255 characters');
                            
                            if (!hasInvalidMessage || !hasLengthConstraint) {
                                console.log(`    ❌ Invalid error message for "${projectName}": ${error.message}`);
                                return false;
                            }
                            
                            return true; // Correctly rejected with proper error message
                        } else {
                            console.log(`    ❌ Expected ValidationError for "${projectName}", got: ${error.constructor.name}`);
                            return false;
                        }
                    }
                }
            ), { numRuns: 50 });
            
            console.log('    ✅ All too-short project names correctly rejected');
            
            // Property: Project names that are too long should be rejected
            const tooLongGenerator = fc.string({
                minLength: 256,
                maxLength: 300
            });
            
            fc.assert(fc.property(
                tooLongGenerator,
                (projectName) => {
                    try {
                        configManager._validateParameterValue('codebuildProjectName', projectName, {});
                        console.log(`    ❌ Too long project name was accepted: ${projectName.substring(0, 30)}...`);
                        return false;
                    } catch (error) {
                        if (error instanceof ValidationError) {
                            // Check that error message mentions the length constraint
                            const hasInvalidMessage = error.message.includes('Invalid CodeBuild project name');
                            const hasLengthConstraint = error.message.includes('2-255 characters');
                            
                            if (!hasInvalidMessage || !hasLengthConstraint) {
                                console.log(`    ❌ Invalid error message for long name: ${error.message}`);
                                return false;
                            }
                            
                            return true; // Correctly rejected with proper error message
                        } else {
                            console.log(`    ❌ Expected ValidationError for long name, got: ${error.constructor.name}`);
                            return false;
                        }
                    }
                }
            ), { numRuns: 50 });
            
            console.log('    ✅ All too-long project names correctly rejected');
        });

        it('should provide consistent error message format across all validation failures', () => {
            console.log('\n  🧪 Property Test: Error message consistency...');
            console.log('  📊 Feature: codebuild-deployment-target, Property 5: Input Validation');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Property: All validation errors should have consistent structure
            const testCases = [
                {
                    parameter: 'deployTarget',
                    generator: fc.string().filter(s => s.length > 0 && !['sagemaker', 'codebuild'].includes(s)),
                    expectedErrorType: 'Unsupported deployment target'
                },
                {
                    parameter: 'codebuildComputeType',
                    generator: fc.string().filter(s => s.length > 0 && !['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'].includes(s)),
                    expectedErrorType: 'Unsupported CodeBuild compute type'
                },
                {
                    parameter: 'codebuildProjectName',
                    generator: fc.string().filter(s => s.length > 0 && !/^[a-zA-Z0-9][a-zA-Z0-9\-_]{1,254}$/.test(s)),
                    expectedErrorType: 'Invalid CodeBuild project name'
                }
            ];
            
            testCases.forEach(({ parameter, generator, expectedErrorType }) => {
                fc.assert(fc.property(
                    generator,
                    (invalidValue) => {
                        try {
                            configManager._validateParameterValue(parameter, invalidValue, {});
                            console.log(`    ❌ Invalid ${parameter} was accepted: ${invalidValue}`);
                            return false;
                        } catch (error) {
                            if (error instanceof ValidationError) {
                                // Check ValidationError properties
                                if (error.parameter !== parameter) {
                                    console.log(`    ❌ Wrong parameter in error: expected ${parameter}, got ${error.parameter}`);
                                    return false;
                                }
                                
                                if (error.value !== invalidValue) {
                                    console.log(`    ❌ Wrong value in error: expected ${invalidValue}, got ${error.value}`);
                                    return false;
                                }
                                
                                // Check error message format
                                if (!error.message.includes(expectedErrorType)) {
                                    console.log(`    ❌ Error message should include "${expectedErrorType}": ${error.message}`);
                                    return false;
                                }
                                
                                if (!error.message.includes(invalidValue)) {
                                    console.log(`    ❌ Error message should include the invalid value: ${error.message}`);
                                    return false;
                                }
                                
                                // Check message length is reasonable
                                if (error.message.length < 20 || error.message.length > 500) {
                                    console.log(`    ❌ Error message length unreasonable (${error.message.length}): ${error.message}`);
                                    return false;
                                }
                                
                                return true; // Error format is consistent
                            } else {
                                console.log(`    ❌ Expected ValidationError for ${parameter}, got: ${error.constructor.name}`);
                                return false;
                            }
                        }
                    }
                ), { numRuns: 50 });
                
                console.log(`    ✅ Error message format consistent for ${parameter}`);
            });
            
            console.log('    ✅ All validation errors have consistent format and structure');
        });

        it('should handle edge cases and boundary values correctly', () => {
            console.log('\n  🧪 Property Test: Edge cases and boundary values...');
            console.log('  📊 Feature: codebuild-deployment-target, Property 5: Input Validation');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Property: Falsy values should not trigger validation errors (they're optional)
            const falsyValues = [null, undefined, '', false, 0];
            
            falsyValues.forEach(falsyValue => {
                ['deployTarget', 'codebuildComputeType', 'codebuildProjectName'].forEach(parameter => {
                    try {
                        configManager._validateParameterValue(parameter, falsyValue, {});
                        // Should not throw for falsy values
                    } catch (error) {
                        console.log(`    ❌ Falsy value ${falsyValue} caused error for ${parameter}: ${error.message}`);
                        throw new Error(`Falsy values should not be validated for ${parameter}`);
                    }
                });
            });
            
            console.log('    ✅ Falsy values correctly ignored (not validated)');
            
            // Property: Boundary values for project names
            const boundaryProjectNames = [
                'ab', // Minimum length (2 chars)
                'A'.repeat(255), // Maximum length (255 chars)
                'a1', // Minimum with number
                '1a', // Start with number
                'a_', // End with underscore
                'a-', // End with hyphen
                'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z6' // Mixed case and numbers
            ];
            
            boundaryProjectNames.forEach(projectName => {
                try {
                    configManager._validateParameterValue('codebuildProjectName', projectName, {});
                    console.log(`    ✅ Boundary project name accepted: ${projectName.substring(0, 20)}...`);
                } catch (error) {
                    console.log(`    ❌ Valid boundary project name rejected: ${projectName} - ${error.message}`);
                    throw new Error(`Boundary project name should be valid: ${projectName}`);
                }
            });
            
            console.log('    ✅ All boundary values handled correctly');
        });
    });
});
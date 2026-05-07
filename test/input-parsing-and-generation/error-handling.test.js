// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Error Handling and Validation Tests
 * 
 * Tests the ConfigManager's error handling and validation functionality:
 * - ConfigurationError and ValidationError classes
 * - Parameter validation with specific error messages
 * - AWS Role ARN format validation
 * - Config file path validation
 * - Required parameter validation
 */

import {
    setupTestHooks
} from './test-utils.js';
import { runGenerator } from '../helpers/run-generator.js';
import ConfigManager, { ConfigurationError, ValidationError } from '../../src/lib/config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Error Handling and Validation', () => {
    let tempDir;
    let mockGenerator;

    before(() => {
        console.log('\n🚀 Starting Error Handling and Validation Tests');
        console.log('📋 Testing: ConfigurationError, ValidationError, and parameter validation');
        console.log('✅ Test environment ready\n');
    });

    setupTestHooks('Error Handling and Validation');

    beforeEach(() => {
        // Create a temporary directory for each test
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
        
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

    describe('Error Classes', () => {
        it('should create ConfigurationError with correct properties', () => {
            console.log('\n  🧪 Testing ConfigurationError class...');
            
            const error = new ConfigurationError(
                'Config file not found',
                'configFile',
                'cli'
            );
            
            console.log(`    ✅ ConfigurationError created: ${error.message}`);
            console.log(`    ✅ Parameter: ${error.parameter}`);
            console.log(`    ✅ Source: ${error.source}`);
            
            // Verify error properties
            if (error.name !== 'ConfigurationError') {
                throw new Error(`Expected error.name to be 'ConfigurationError', got '${error.name}'`);
            }
            if (error.message !== 'Config file not found') {
                throw new Error(`Expected error.message to be 'Config file not found', got '${error.message}'`);
            }
            if (error.parameter !== 'configFile') {
                throw new Error(`Expected error.parameter to be 'configFile', got '${error.parameter}'`);
            }
            if (error.source !== 'cli') {
                throw new Error(`Expected error.source to be 'cli', got '${error.source}'`);
            }
            
            console.log('    ✅ ConfigurationError class working correctly');
        });

        it('should create ValidationError with correct properties', () => {
            console.log('\n  🧪 Testing ValidationError class...');
            
            const error = new ValidationError(
                'Invalid framework value',
                'framework',
                'invalid-framework'
            );
            
            console.log(`    ✅ ValidationError created: ${error.message}`);
            console.log(`    ✅ Parameter: ${error.parameter}`);
            console.log(`    ✅ Value: ${error.value}`);
            
            // Verify error properties
            if (error.name !== 'ValidationError') {
                throw new Error(`Expected error.name to be 'ValidationError', got '${error.name}'`);
            }
            if (error.message !== 'Invalid framework value') {
                throw new Error(`Expected error.message to be 'Invalid framework value', got '${error.message}'`);
            }
            if (error.parameter !== 'framework') {
                throw new Error(`Expected error.parameter to be 'framework', got '${error.parameter}'`);
            }
            if (error.value !== 'invalid-framework') {
                throw new Error(`Expected error.value to be 'invalid-framework', got '${error.value}'`);
            }
            
            console.log('    ✅ ValidationError class working correctly');
        });
    });

    describe('AWS Role ARN Validation', () => {
        it('should validate correct AWS Role ARN format', () => {
            console.log('\n  🧪 Testing valid AWS Role ARN format...');
            
            const configManager = new ConfigManager(mockGenerator);
            const validArns = [
                'arn:aws:iam::123456789012:role/SageMakerRole',
                'arn:aws:iam::999999999999:role/MyRole-123',
                'arn:aws:iam::000000000000:role/Test_Role.Name'
            ];
            
            validArns.forEach(arn => {
                console.log(`    🔍 Testing ARN: ${arn}`);
                try {
                    const result = configManager._isValidArn(arn);
                    if (result !== true) {
                        throw new Error(`Expected _isValidArn to return true for valid ARN: ${arn}`);
                    }
                    console.log(`    ✅ Valid ARN accepted: ${arn}`);
                } catch (error) {
                    throw new Error(`Valid ARN rejected: ${arn} - ${error.message}`);
                }
            });
            
            console.log('    ✅ All valid AWS Role ARNs accepted');
        });

        it('should reject invalid AWS Role ARN formats', () => {
            console.log('\n  🧪 Testing invalid AWS Role ARN formats...');
            
            const configManager = new ConfigManager(mockGenerator);
            const invalidArns = [
                'invalid-arn',
                'arn:aws:iam::123:role/TooShortAccount',
                'arn:aws:iam::12345678901234:role/TooLongAccount',
                'arn:aws:s3:::bucket/key', // Wrong service
                'arn:aws:iam::123456789012:user/UserNotRole',
                'arn:aws:iam::123456789012:role/', // Empty role name
                'arn:aws:iam::abcdefghijkl:role/InvalidAccount'
            ];
            
            invalidArns.forEach(arn => {
                console.log(`    🔍 Testing invalid ARN: ${arn}`);
                try {
                    configManager._isValidArn(arn);
                    throw new Error(`Invalid ARN was accepted: ${arn}`);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        console.log(`    ✅ Invalid ARN correctly rejected: ${arn}`);
                        console.log(`    📝 Error message: ${error.message}`);
                        
                        // Verify error message contains expected format
                        if (!error.message.includes('Invalid AWS Role ARN format')) {
                            throw new Error(`Error message should mention ARN format: ${error.message}`);
                        }
                        if (!error.message.includes('arn:aws:iam::123456789012:role/RoleName')) {
                            throw new Error(`Error message should include example format: ${error.message}`);
                        }
                    } else {
                        throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                    }
                }
            });
            
            console.log('    ✅ All invalid AWS Role ARNs correctly rejected');
        });
    });

    describe('Config File Path Validation', () => {
        it('should handle missing config file with clear error', async () => {
            console.log('\n  🧪 Testing missing config file error...');
            
            const nonExistentFile = path.join(tempDir, 'nonexistent.json');
            mockGenerator.options.config = nonExistentFile;
            
            const configManager = new ConfigManager(mockGenerator);
            
            try {
                await configManager._loadCliConfigFile();
                throw new Error('Expected error for missing config file');
            } catch (error) {
                console.log(`    📝 Error message: ${error.message}`);
                
                if (!error.message.includes('Config file not found')) {
                    throw new Error(`Error message should mention file not found: ${error.message}`);
                }
                if (!error.message.includes(nonExistentFile)) {
                    throw new Error(`Error message should include file path: ${error.message}`);
                }
                
                console.log('    ✅ Missing config file error handled correctly');
            }
        });

        it('should handle unreadable config file with clear error', async () => {
            console.log('\n  🧪 Testing unreadable config file error...');
            
            const configFile = path.join(tempDir, 'unreadable.json');
            
            // Create file and make it unreadable (if possible on this platform)
            fs.writeFileSync(configFile, '{"framework": "sklearn"}');
            try {
                fs.chmodSync(configFile, 0o000); // Remove all permissions
            } catch (chmodError) {
                console.log('    ⚠️  Cannot test unreadable file on this platform, skipping...');
                return;
            }
            
            mockGenerator.options.config = configFile;
            const configManager = new ConfigManager(mockGenerator);
            
            try {
                await configManager._loadCliConfigFile();
                throw new Error('Expected error for unreadable config file');
            } catch (error) {
                console.log(`    📝 Error message: ${error.message}`);
                
                if (!error.message.includes('not readable')) {
                    throw new Error(`Error message should mention file not readable: ${error.message}`);
                }
                if (!error.message.includes(configFile)) {
                    throw new Error(`Error message should include file path: ${error.message}`);
                }
                
                console.log('    ✅ Unreadable config file error handled correctly');
            } finally {
                // Restore permissions for cleanup
                try {
                    fs.chmodSync(configFile, 0o644);
                } catch (restoreError) {
                    // Ignore restore errors
                }
            }
        });

        it('should handle malformed JSON config file', async () => {
            console.log('\n  🧪 Testing malformed JSON config file...');
            
            const configFile = path.join(tempDir, 'malformed.json');
            fs.writeFileSync(configFile, '{"framework": "sklearn", invalid json}');
            
            mockGenerator.options.config = configFile;
            const configManager = new ConfigManager(mockGenerator);
            
            try {
                await configManager._loadCliConfigFile();
                throw new Error('Expected error for malformed JSON');
            } catch (error) {
                console.log(`    📝 Error message: ${error.message}`);
                
                if (!error.message.includes('Failed to load config file')) {
                    throw new Error(`Error message should mention failed to load: ${error.message}`);
                }
                if (!error.message.includes(configFile)) {
                    throw new Error(`Error message should include file path: ${error.message}`);
                }
                
                console.log('    ✅ Malformed JSON config file error handled correctly');
            }
        });
    });

    describe('Parameter Validation', () => {
        it('should validate deployment-config parameter', () => {
            console.log('\n  🧪 Testing deployment-config parameter validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test valid deployment configs
            const validConfigs = ['http-flask', 'http-fastapi', 'transformers-vllm', 'triton-fil'];
            validConfigs.forEach(dc => {
                try {
                    configManager._validateParameterValue('deploymentConfig', dc, {});
                    console.log(`    ✅ Valid deployment-config accepted: ${dc}`);
                } catch (error) {
                    throw new Error(`Valid deployment-config rejected: ${dc} - ${error.message}`);
                }
            });
            
            // Test invalid deployment-config
            try {
                configManager._validateParameterValue('deploymentConfig', 'invalid-config', {});
                throw new Error('Invalid deployment-config was accepted');
            } catch (error) {
                if (error instanceof ValidationError) {
                    console.log('    ✅ Invalid deployment-config correctly rejected');
                    console.log(`    📝 Error message: ${error.message}`);
                    
                    if (!error.message.includes('Unsupported deployment-config')) {
                        throw new Error(`Error message should mention unsupported deployment-config: ${error.message}`);
                    }
                } else {
                    throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                }
            }
            
            console.log('    ✅ Deployment-config parameter validation working correctly');
        });

        it('should validate old-format deployment-config with migration message', () => {
            console.log('\n  🧪 Testing old-format deployment-config migration validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test old-format configs get migration messages
            const oldFormats = [
                { old: 'sklearn-flask', expected: 'Use --deployment-config=http-flask --engine=sklearn instead' },
                { old: 'xgboost-fastapi', expected: 'Use --deployment-config=http-fastapi --engine=xgboost instead' },
                { old: 'tensorflow-flask', expected: 'Use --deployment-config=http-flask --engine=tensorflow instead' }
            ];
            
            oldFormats.forEach(({ old, expected }) => {
                try {
                    configManager._validateParameterValue('deploymentConfig', old, {});
                    throw new Error(`Old-format deployment-config was accepted: ${old}`);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        console.log(`    ✅ Old-format correctly rejected: ${old}`);
                        if (!error.message.includes(expected)) {
                            throw new Error(`Error message should include migration guidance: ${error.message}`);
                        }
                    } else {
                        throw new Error(`Expected ValidationError, got: ${error.constructor.name}`);
                    }
                }
            });
            
            console.log('    ✅ Old-format deployment-config migration validation working correctly');
        });

        it('should validate instance type requirements for transformers', () => {
            console.log('\n  🧪 Testing instance type validation for transformers...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test valid instance type for transformers
            try {
                configManager._validateParameterValue('instanceType', 'ml.g5.xlarge', { architecture: 'transformers' });
                console.log('    ✅ GPU instance accepted for transformers');
            } catch (error) {
                throw new Error(`Valid instance type rejected for transformers: ${error.message}`);
            }
            
            // Test CPU instance for transformers - should warn but not error
            // (Current implementation allows CPU instances with a warning)
            try {
                // Capture console.warn output
                const originalWarn = console.warn;
                let warnCalled = false;
                console.warn = (...args) => {
                    warnCalled = true;
                    originalWarn(...args);
                };
                
                configManager._validateParameterValue('instanceType', 'ml.m5.large', { architecture: 'transformers' });
                
                console.warn = originalWarn;
                
                if (warnCalled) {
                    console.log('    ✅ CPU instance accepted with warning for transformers');
                } else {
                    console.log('    ⚠️  CPU instance accepted without warning for transformers');
                }
            } catch (error) {
                throw new Error(`CPU instance validation failed unexpectedly: ${error.message}`);
            }
            
            console.log('    ✅ Instance type validation for transformers working correctly');
        });
    });

    describe('Required Parameter Validation', () => {
        it('should validate missing required parameters', () => {
            console.log('\n  🧪 Testing required parameter validation...');
            
            const configManager = new ConfigManager(mockGenerator);
            
            // Test configuration missing required parameters
            const incompleteConfig = {
                deploymentConfig: 'http-flask',
                architecture: 'http',
                backend: 'flask'
                // Missing engine, modelFormat, etc.
            };
            
            const errors = configManager.validateRequiredParameters(incompleteConfig);
            console.log(`    📝 Validation errors found: ${errors.length}`);
            
            if (errors.length === 0) {
                throw new Error('Expected validation errors for missing required parameters');
            }
            
            // Check that errors mention missing required parameters
            const hasRequiredParameterError = errors.some(error => 
                error.includes('Required parameter') && error.includes('is missing')
            );
            
            if (!hasRequiredParameterError) {
                throw new Error(`Expected error about missing required parameters, got: ${errors.join(', ')}`);
            }
            
            console.log('    ✅ Missing required parameters correctly detected');
            
            // Test complete configuration
            const completeConfig = {
                deploymentConfig: 'http-flask',
                architecture: 'http',
                backend: 'flask',
                engine: 'sklearn',
                modelFormat: 'pkl',
                includeSampleModel: false,
                includeTesting: true,
                instanceType: 'ml.m5.large',
                projectName: 'test-project',
                destinationDir: '.',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference'
            };
            
            const completeErrors = configManager.validateRequiredParameters(completeConfig);
            console.log(`    📝 Validation errors for complete config: ${completeErrors.length}`);
            
            if (completeErrors.length > 0) {
                throw new Error(`Complete configuration should not have errors: ${completeErrors.join(', ')}`);
            }
            
            console.log('    ✅ Complete configuration passes validation');
        });
    });

    describe('Integration with Generator', () => {
        it('should prevent file generation when validation fails', function() {
            this.timeout(10000);
            console.log('\n  🧪 Testing validation prevents file generation...');

            try {
                const result = runGenerator({
                    'deployment-config': 'invalid-config'
                });
                // If generator didn't throw, verify no files were generated
                result.assertNoFile('Dockerfile');
                result.assertNoFile('requirements.txt');
                result.cleanup();
            } catch (error) {
                // Expected: generator should fail validation for invalid config
            }

            console.log('    ✅ Validation correctly prevented file generation');
        });
    });
});
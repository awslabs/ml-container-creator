// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ValidationEngine Unit Tests
 * 
 * Tests the ValidationEngine class for accelerator compatibility validation
 * and environment variable validation.
 * 
 * Feature: transformer-server-env-config
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ValidationEngine from '../../src/lib/validation-engine.js';
import AcceleratorValidator from '../../src/lib/accelerator-validator.js';

describe('ValidationEngine', () => {
    let validationEngine;

    before(() => {
        validationEngine = new ValidationEngine();
    });

    describe('Constructor and Initialization', () => {
        it('should initialize with default accelerator validators', () => {
            const engine = new ValidationEngine();
            
            // Should have validators for cuda, neuron, cpu, rocm
            assert(engine.acceleratorValidators.has('cuda'), 'Should have CUDA validator');
            assert(engine.acceleratorValidators.has('neuron'), 'Should have Neuron validator');
            assert(engine.acceleratorValidators.has('cpu'), 'Should have CPU validator');
            assert(engine.acceleratorValidators.has('rocm'), 'Should have ROCm validator');
        });
    });

    describe('registerAcceleratorValidator', () => {
        it('should allow registering custom accelerator validators', () => {
            const engine = new ValidationEngine();
            
            // Create a custom validator
            class CustomValidator extends AcceleratorValidator {
                validate() {
                    return { compatible: true, info: 'Custom validator' };
                }
                
                getVersionMismatchMessage() {
                    return 'Custom error message';
                }
            }
            
            const customValidator = new CustomValidator();
            engine.registerAcceleratorValidator('custom', customValidator);
            
            assert(engine.acceleratorValidators.has('custom'), 'Should have custom validator');
            assert.strictEqual(engine.acceleratorValidators.get('custom'), customValidator,
                'Should store the custom validator instance');
        });
    });

    describe('validateAcceleratorCompatibility', () => {
        it('should detect accelerator type mismatch', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'neuron',
                    versions: ['2.15.0']
                }
            };
            
            const result = validationEngine.validateAcceleratorCompatibility(
                frameworkConfig,
                instanceConfig
            );
            
            assert.strictEqual(result.compatible, false, 'Should be incompatible');
            assert(result.error, 'Should have error message');
            assert(result.error.includes('cuda'), 'Error should mention CUDA');
            assert(result.error.includes('neuron'), 'Error should mention Neuron');
        });
        
        it('should validate CUDA version compatibility', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'cuda',
                    versions: ['12.1', '12.2']
                }
            };
            
            const result = validationEngine.validateAcceleratorCompatibility(
                frameworkConfig,
                instanceConfig
            );
            
            assert.strictEqual(result.compatible, true, 'Should be compatible');
            assert(result.info, 'Should have info message');
            assert(result.info.includes('12.1'), 'Info should mention version');
        });
        
        it('should detect CUDA version incompatibility', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'cuda',
                    versions: ['11.8']
                }
            };
            
            const result = validationEngine.validateAcceleratorCompatibility(
                frameworkConfig,
                instanceConfig
            );
            
            assert.strictEqual(result.compatible, false, 'Should be incompatible');
            assert(result.error, 'Should have error message');
            assert(result.error.includes('12.1'), 'Error should mention required version');
            assert(result.error.includes('11.8'), 'Error should mention provided version');
        });
        
        it('should validate Neuron SDK version compatibility', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'neuron',
                    version: '2.15.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'neuron',
                    versions: ['2.15.0', '2.16.0']
                }
            };
            
            const result = validationEngine.validateAcceleratorCompatibility(
                frameworkConfig,
                instanceConfig
            );
            
            assert.strictEqual(result.compatible, true, 'Should be compatible');
            assert(result.info, 'Should have info message');
        });
        
        it('should always validate CPU as compatible', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cpu',
                    version: null
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'cpu',
                    versions: null
                }
            };
            
            const result = validationEngine.validateAcceleratorCompatibility(
                frameworkConfig,
                instanceConfig
            );
            
            assert.strictEqual(result.compatible, true, 'CPU should always be compatible');
            assert(result.info, 'Should have info message');
        });
        
        it('should handle unknown accelerator types gracefully', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'unknown-accelerator',
                    version: '1.0.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'unknown-accelerator',
                    versions: ['1.0.0']
                }
            };
            
            const result = validationEngine.validateAcceleratorCompatibility(
                frameworkConfig,
                instanceConfig
            );
            
            assert.strictEqual(result.compatible, true, 'Should be compatible (no validator)');
            assert(result.warning, 'Should have warning message');
            assert(result.warning.includes('No validator'), 'Warning should mention missing validator');
        });
    });

    describe('getRecommendedInstanceTypes', () => {
        it('should return compatible instance types', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };
            
            const instanceAcceleratorMapping = {
                'ml.g5.xlarge': {
                    accelerator: {
                        type: 'cuda',
                        versions: ['12.1', '12.2']
                    }
                },
                'ml.g4dn.xlarge': {
                    accelerator: {
                        type: 'cuda',
                        versions: ['11.8']
                    }
                },
                'ml.inf2.xlarge': {
                    accelerator: {
                        type: 'neuron',
                        versions: ['2.15.0']
                    }
                }
            };
            
            const recommendations = validationEngine.getRecommendedInstanceTypes(
                frameworkConfig,
                instanceAcceleratorMapping
            );
            
            assert(Array.isArray(recommendations), 'Should return an array');
            assert(recommendations.length > 0, 'Should have at least one recommendation');
            
            // Should only include compatible instances
            const instanceTypes = recommendations.map(r => r.instanceType);
            assert(instanceTypes.includes('ml.g5.xlarge'), 'Should include ml.g5.xlarge');
            assert(!instanceTypes.includes('ml.g4dn.xlarge'), 'Should not include ml.g4dn.xlarge');
            assert(!instanceTypes.includes('ml.inf2.xlarge'), 'Should not include ml.inf2.xlarge');
        });
        
        it('should return empty array when no compatible instances', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '13.0'
                }
            };
            
            const instanceAcceleratorMapping = {
                'ml.g5.xlarge': {
                    accelerator: {
                        type: 'cuda',
                        versions: ['12.1']
                    }
                }
            };
            
            const recommendations = validationEngine.getRecommendedInstanceTypes(
                frameworkConfig,
                instanceAcceleratorMapping
            );
            
            assert(Array.isArray(recommendations), 'Should return an array');
            assert.strictEqual(recommendations.length, 0, 'Should have no recommendations');
        });
    });

    describe('validateEnvironmentVariables', () => {
        it('should validate using known flags registry', () => {
            const envVars = {
                'MAX_BATCH_SIZE': '32',
                'TEMPERATURE': '0.7'
            };
            
            const frameworkConfig = {
                knownFlags: {
                    'MAX_BATCH_SIZE': {
                        type: 'integer',
                        min: 1,
                        max: 128,
                        deprecated: false
                    },
                    'TEMPERATURE': {
                        type: 'float',
                        min: 0,
                        max: 2,
                        deprecated: false
                    }
                }
            };
            
            const result = validationEngine.validateEnvironmentVariables(
                envVars,
                frameworkConfig,
                { useKnownFlags: true, useCommunityReports: false, useDockerIntrospection: false }
            );
            
            assert(Array.isArray(result.errors), 'Should have errors array');
            assert(Array.isArray(result.warnings), 'Should have warnings array');
            assert(Array.isArray(result.strategiesUsed), 'Should have strategiesUsed array');
            assert(result.strategiesUsed.includes('known-flags-registry'), 
                'Should use known-flags-registry');
            assert.strictEqual(result.errors.length, 0, 'Should have no errors for valid values');
        });
        
        it('should detect type constraint violations', () => {
            const envVars = {
                'MAX_BATCH_SIZE': 'not-a-number'
            };
            
            const frameworkConfig = {
                knownFlags: {
                    'MAX_BATCH_SIZE': {
                        type: 'integer',
                        min: 1,
                        max: 128,
                        deprecated: false
                    }
                }
            };
            
            const result = validationEngine.validateEnvironmentVariables(
                envVars,
                frameworkConfig,
                { useKnownFlags: true, useCommunityReports: false, useDockerIntrospection: false }
            );
            
            assert(result.errors.length > 0, 'Should have type error');
            const typeError = result.errors.find(e => e.variable === 'MAX_BATCH_SIZE');
            assert(typeError, 'Should have error for MAX_BATCH_SIZE');
            assert(typeError.message.includes('type'), 'Error should mention type');
        });
        
        it('should detect range constraint violations', () => {
            const envVars = {
                'MAX_BATCH_SIZE': '200'
            };
            
            const frameworkConfig = {
                knownFlags: {
                    'MAX_BATCH_SIZE': {
                        type: 'integer',
                        min: 1,
                        max: 128,
                        deprecated: false
                    }
                }
            };
            
            const result = validationEngine.validateEnvironmentVariables(
                envVars,
                frameworkConfig,
                { useKnownFlags: true, useCommunityReports: false, useDockerIntrospection: false }
            );
            
            assert(result.errors.length > 0, 'Should have range error');
            const rangeError = result.errors.find(e => e.variable === 'MAX_BATCH_SIZE');
            assert(rangeError, 'Should have error for MAX_BATCH_SIZE');
            assert(rangeError.message.includes('<='), 'Error should mention max constraint');
        });
        
        it('should warn about deprecated flags', () => {
            const envVars = {
                'OLD_FLAG': 'value'
            };
            
            const frameworkConfig = {
                knownFlags: {
                    'OLD_FLAG': {
                        type: 'string',
                        deprecated: true,
                        deprecationMessage: 'Use NEW_FLAG instead',
                        replacement: 'NEW_FLAG'
                    }
                }
            };
            
            const result = validationEngine.validateEnvironmentVariables(
                envVars,
                frameworkConfig,
                { useKnownFlags: true, useCommunityReports: false, useDockerIntrospection: false }
            );
            
            assert(result.warnings.length > 0, 'Should have deprecation warning');
            const deprecationWarning = result.warnings.find(w => w.variable === 'OLD_FLAG');
            assert(deprecationWarning, 'Should have warning for OLD_FLAG');
            assert(deprecationWarning.message.includes('deprecated'), 
                'Warning should mention deprecated');
            assert.strictEqual(deprecationWarning.replacement, 'NEW_FLAG', 
                'Should suggest replacement');
        });
        
        it('should validate using community reports', () => {
            const envVars = {
                'PROBLEMATIC_FLAG': 'value'
            };
            
            const frameworkConfig = {
                communityReports: {
                    'PROBLEMATIC_FLAG': [
                        {
                            status: 'invalid',
                            message: 'Known to cause crashes'
                        }
                    ]
                }
            };
            
            const result = validationEngine.validateEnvironmentVariables(
                envVars,
                frameworkConfig,
                { useKnownFlags: false, useCommunityReports: true, useDockerIntrospection: false }
            );
            
            assert(result.strategiesUsed.includes('community-reports'), 
                'Should use community-reports');
            assert(result.warnings.length > 0, 'Should have community warning');
        });
        
        it('should support disabling all validation', () => {
            const envVars = {
                'ANY_FLAG': 'any_value'
            };
            
            const frameworkConfig = {
                knownFlags: {
                    'ANY_FLAG': {
                        type: 'integer',
                        deprecated: true
                    }
                }
            };
            
            const result = validationEngine.validateEnvironmentVariables(
                envVars,
                frameworkConfig,
                { useKnownFlags: false, useCommunityReports: false, useDockerIntrospection: false }
            );
            
            assert.strictEqual(result.strategiesUsed.length, 0, 'Should use no strategies');
            assert.strictEqual(result.errors.length, 0, 'Should have no errors');
            assert.strictEqual(result.warnings.length, 0, 'Should have no warnings');
        });
        
        it('should add experimental warning for Docker introspection', () => {
            const envVars = {};
            const frameworkConfig = {};
            
            const result = validationEngine.validateEnvironmentVariables(
                envVars,
                frameworkConfig,
                { useKnownFlags: false, useCommunityReports: false, useDockerIntrospection: true }
            );
            
            assert(result.strategiesUsed.includes('docker-introspection'), 
                'Should use docker-introspection');
            assert(result.warnings.length > 0, 'Should have experimental warning');
            const experimentalWarning = result.warnings.find(w => 
                w.message && w.message.includes('experimental')
            );
            assert(experimentalWarning, 'Should have experimental warning');
        });
    });
});

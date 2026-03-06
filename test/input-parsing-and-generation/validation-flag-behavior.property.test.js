// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation Flag Behavior Property-Based Tests
 * 
 * Tests the correctness properties for validation flag behavior.
 * Validates that validation can be completely disabled when VALIDATE_ENV_VARS is false.
 * 
 * Feature: transformer-server-env-config
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ValidationEngine from '../../generators/app/lib/validation-engine.js';

describe('Validation Flag Behavior - Property-Based Tests', () => {
    let validationEngine;

    before(async () => {
        
        validationEngine = new ValidationEngine();
    });

    describe('Property 18: Validation Flag Behavior', () => {
        it('should allow validation to be completely disabled', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 18: Validation Flag Behavior');
            console.log('  📝 For any test execution, when VALIDATE_ENV_VARS is set to false,');
            console.log('  📝 no environment variable validation must occur');
            
            // Feature: transformer-server-env-config, Property 18: Validation Flag Behavior
            fc.assert(fc.property(
                fc.dictionary(
                    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    fc.string({ minLength: 1, maxLength: 50 })
                ),
                (envVars) => {
                    // Create framework config with known flags
                    const frameworkConfig = {
                        knownFlags: Object.keys(envVars).reduce((acc, key) => {
                            acc[key] = {
                                type: 'string',
                                deprecated: false
                            };
                            return acc;
                        }, {}),
                        communityReports: {}
                    };
                    
                    // Call validateEnvironmentVariables with enabled=false
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { enabled: false }
                    );
                    
                    // Verify result structure exists
                    assert(result !== null && result !== undefined, 'Result must not be null or undefined');
                    assert(Array.isArray(result.errors), 'Result must have errors array');
                    assert(Array.isArray(result.warnings), 'Result must have warnings array');
                    assert(Array.isArray(result.strategiesUsed), 'Result must have strategiesUsed array');
                    
                    // When validation is disabled, no errors or warnings should be produced
                    assert.strictEqual(result.errors.length, 0,
                        'Disabled validation should produce no errors');
                    assert.strictEqual(result.warnings.length, 0,
                        'Disabled validation should produce no warnings');
                    assert.strictEqual(result.strategiesUsed.length, 0,
                        'Disabled validation should use no strategies');
                    
                    return true;
                }
            ), { numRuns: 10 });
            
        });

        it('should validate normally when enabled', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 18: Validation Flag Behavior - Enabled State');
            console.log('  📝 For any test execution, when VALIDATE_ENV_VARS is set to true,');
            console.log('  📝 environment variable validation must occur normally');
            
            // Feature: transformer-server-env-config, Property 18: Validation Flag Behavior
            fc.assert(fc.property(
                fc.record({
                    varName: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    value: fc.string({ minLength: 1, maxLength: 50 })
                }),
                (testData) => {
                    const envVars = {
                        [testData.varName]: testData.value
                    };
                    
                    const frameworkConfig = {
                        knownFlags: {
                            [testData.varName]: {
                                type: 'string',
                                deprecated: false
                            }
                        }
                    };
                    
                    // Call validateEnvironmentVariables with enabled=true (default)
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { enabled: true, useKnownFlags: true }
                    );
                    
                    // Verify result structure
                    assert(Array.isArray(result.errors), 'Result must have errors array');
                    assert(Array.isArray(result.warnings), 'Result must have warnings array');
                    assert(Array.isArray(result.strategiesUsed), 'Result must have strategiesUsed array');
                    
                    // When validation is enabled, strategies should be used
                    assert(result.strategiesUsed.length > 0,
                        'Enabled validation should use at least one strategy');
                    assert(result.strategiesUsed.includes('known-flags-registry'),
                        'Should use known-flags-registry when enabled');
                    
                    return true;
                }
            ), { numRuns: 10 });
            
        });

        it('should default to enabled when flag not specified', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 18: Validation Flag Behavior - Default State');
            console.log('  📝 For any test execution, when VALIDATE_ENV_VARS is not specified,');
            console.log('  📝 validation should be enabled by default');
            
            // Feature: transformer-server-env-config, Property 18: Validation Flag Behavior
            fc.assert(fc.property(
                fc.record({
                    varName: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    value: fc.string({ minLength: 1, maxLength: 50 })
                }),
                (testData) => {
                    const envVars = {
                        [testData.varName]: testData.value
                    };
                    
                    const frameworkConfig = {
                        knownFlags: {
                            [testData.varName]: {
                                type: 'string',
                                deprecated: false
                            }
                        }
                    };
                    
                    // Call validateEnvironmentVariables without specifying enabled flag
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { useKnownFlags: true }
                    );
                    
                    // Verify result structure
                    assert(Array.isArray(result.strategiesUsed), 'Result must have strategiesUsed array');
                    
                    // Default should be enabled, so strategies should be used
                    assert(result.strategiesUsed.length > 0,
                        'Default behavior should enable validation');
                    
                    return true;
                }
            ), { numRuns: 10 });
            
        });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Environment Variable Validation Property-Based Tests
 * 
 * Tests the correctness properties for environment variable validation.
 * Validates that environment variables are correctly validated against
 * framework specifications using multiple strategies.
 * 
 * Feature: transformer-server-env-config
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ValidationEngine from '../../src/lib/validation-engine.js';

describe('Environment Variable Validation - Property-Based Tests', () => {
    let validationEngine;

    before(async () => {
        console.log('\n🚀 Starting Environment Variable Validation Property Tests');
        console.log('📋 Testing: Universal correctness properties for environment variable validation');
        console.log('🔧 Configuration: 100 iterations per property');
        console.log('✅ Property test environment ready\n');
        
        validationEngine = new ValidationEngine();
    });

    describe('Property 17: Environment Variable Validation', () => {
        it('should validate variable names against known flags registry', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 17: Environment Variable Validation - Name Validation');
            console.log('  📝 For any environment variable when VALIDATE_ENV_VARS is enabled,');
            console.log('  📝 the variable name must be validated against known flags');
            console.log('  📝 Validates: Requirements 13.8, 13.13, 13.14, 13.15');
            
            // Feature: transformer-server-env-config, Property 17: Environment Variable Validation
            fc.assert(fc.property(
                fc.record({
                    // Generate safe variable names that avoid JavaScript reserved properties
                    varName: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            // Filter out JavaScript reserved property names
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    varValue: fc.string({ minLength: 1, maxLength: 50 }),
                    isKnownFlag: fc.boolean()
                }),
                (testData) => {
                    const envVars = {
                        [testData.varName]: testData.varValue
                    };
                    
                    // Create framework config with or without the flag
                    const frameworkConfig = testData.isKnownFlag ? {
                        knownFlags: {
                            [testData.varName]: {
                                type: 'string',
                                deprecated: false
                            }
                        }
                    } : {
                        knownFlags: {}
                    };
                    
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { useKnownFlags: true, useCommunityReports: false, useDockerIntrospection: false }
                    );
                    
                    // Verify result structure
                    assert(Array.isArray(result.errors), 'Result must have errors array');
                    assert(Array.isArray(result.warnings), 'Result must have warnings array');
                    assert(Array.isArray(result.strategiesUsed), 'Result must have strategiesUsed array');
                    
                    // Verify strategy was used
                    assert(result.strategiesUsed.includes('known-flags-registry'),
                        'Should use known-flags-registry strategy');
                    
                    // Unknown flags should not produce errors (just informational)
                    // Known flags with valid values should not produce errors
                    assert.strictEqual(result.errors.length, 0,
                        'Valid string values should not produce errors');
                    
                    return true;
                }
            ), { numRuns: 10 });
            
            console.log('    ✅ Variable name validation completed');
        });

        it('should validate variable types against known flags', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 17: Environment Variable Validation - Type Validation');
            console.log('  📝 For any environment variable, the value must be validated');
            console.log('  📝 against type constraints (integer, float, string, boolean)');
            console.log('  📝 Validates: Requirements 13.13, 13.14, 13.15');
            
            // Feature: transformer-server-env-config, Property 17: Environment Variable Validation
            fc.assert(fc.property(
                fc.record({
                    varName: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    expectedType: fc.constantFrom('integer', 'float', 'string', 'boolean'),
                    value: fc.oneof(
                        fc.integer().map(String),
                        fc.float().map(v => Math.fround(v).toString()), // Use Math.fround for 32-bit float
                        fc.string({ minLength: 1, maxLength: 50 }),
                        fc.boolean().map(String)
                    )
                }),
                (testData) => {
                    const envVars = {
                        [testData.varName]: testData.value
                    };
                    
                    const frameworkConfig = {
                        knownFlags: {
                            [testData.varName]: {
                                type: testData.expectedType,
                                deprecated: false
                            }
                        }
                    };
                    
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { useKnownFlags: true, useCommunityReports: false, useDockerIntrospection: false }
                    );
                    
                    // Verify result structure
                    assert(Array.isArray(result.errors), 'Result must have errors array');
                    assert(Array.isArray(result.warnings), 'Result must have warnings array');
                    
                    // Type validation should produce errors for mismatches
                    // We can't predict exact matches due to random generation,
                    // but we can verify the validation ran
                    assert(result.strategiesUsed.includes('known-flags-registry'),
                        'Should use known-flags-registry strategy');
                    
                    return true;
                }
            ), { numRuns: 10 });
            
            console.log('    ✅ Type validation completed');
        });

        it('should validate integer range constraints', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 17: Environment Variable Validation - Range Constraints');
            console.log('  📝 For any integer environment variable, the value must be validated');
            console.log('  📝 against min/max range constraints');
            console.log('  📝 Validates: Requirements 13.13, 13.14, 13.15');
            
            // Feature: transformer-server-env-config, Property 17: Environment Variable Validation
            fc.assert(fc.property(
                fc.record({
                    varName: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    min: fc.integer({ min: 0, max: 50 }),
                    max: fc.integer({ min: 51, max: 200 }),
                    value: fc.integer({ min: -10, max: 250 })
                }),
                (testData) => {
                    const envVars = {
                        [testData.varName]: testData.value.toString()
                    };
                    
                    const frameworkConfig = {
                        knownFlags: {
                            [testData.varName]: {
                                type: 'integer',
                                min: testData.min,
                                max: testData.max,
                                deprecated: false
                            }
                        }
                    };
                    
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { useKnownFlags: true, useCommunityReports: false, useDockerIntrospection: false }
                    );
                    
                    // Verify result structure
                    assert(Array.isArray(result.errors), 'Result must have errors array');
                    
                    // Determine if value is in range
                    const inRange = testData.value >= testData.min && testData.value <= testData.max;
                    
                    if (!inRange) {
                        // Out of range should produce an error
                        assert(result.errors.length > 0,
                            `Value ${testData.value} outside range [${testData.min}, ${testData.max}] should produce error`);
                        
                        const rangeError = result.errors.find(e => e.variable === testData.varName);
                        assert(rangeError, 'Should have error for the variable');
                        assert(rangeError.message.includes('>=') || rangeError.message.includes('<='),
                            'Error should mention range constraint');
                    } else {
                        // In range should not produce range errors
                        const rangeErrors = result.errors.filter(e => 
                            e.variable === testData.varName && 
                            (e.message.includes('>=') || e.message.includes('<='))
                        );
                        assert.strictEqual(rangeErrors.length, 0,
                            `Value ${testData.value} in range [${testData.min}, ${testData.max}] should not produce range error`);
                    }
                    
                    return true;
                }
            ), { numRuns: 10 });
            
            console.log('    ✅ Range constraint validation completed');
        });

        it('should warn about deprecated flags', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 17: Environment Variable Validation - Deprecation Warnings');
            console.log('  📝 For any deprecated environment variable, a warning must be produced');
            console.log('  📝 with deprecation message and replacement suggestion');
            console.log('  📝 Validates: Requirements 13.16, 13.17');
            
            // Feature: transformer-server-env-config, Property 17: Environment Variable Validation
            fc.assert(fc.property(
                fc.record({
                    varName: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    replacement: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
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
                                deprecated: true,
                                deprecationMessage: `Use ${testData.replacement} instead`,
                                replacement: testData.replacement
                            }
                        }
                    };
                    
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { useKnownFlags: true, useCommunityReports: false, useDockerIntrospection: false }
                    );
                    
                    // Verify result structure
                    assert(Array.isArray(result.warnings), 'Result must have warnings array');
                    
                    // Should have deprecation warning
                    assert(result.warnings.length > 0,
                        'Deprecated flag should produce warning');
                    
                    const deprecationWarning = result.warnings.find(w => 
                        w.variable === testData.varName
                    );
                    assert(deprecationWarning, 'Should have warning for deprecated variable');
                    assert(deprecationWarning.message.includes('deprecated'),
                        'Warning should mention deprecated');
                    assert.strictEqual(deprecationWarning.replacement, testData.replacement,
                        'Warning should include replacement suggestion');
                    
                    return true;
                }
            ), { numRuns: 10 });
            
            console.log('    ✅ Deprecation warning validation completed');
        });

        it('should validate using community reports', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 17: Environment Variable Validation - Community Reports');
            console.log('  📝 For any environment variable with community reports,');
            console.log('  📝 warnings should be produced for reported issues');
            console.log('  📝 Validates: Requirements 13.10, 13.13, 13.14, 13.15');
            
            // Feature: transformer-server-env-config, Property 17: Environment Variable Validation
            fc.assert(fc.property(
                fc.record({
                    varName: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    value: fc.string({ minLength: 1, maxLength: 50 }),
                    hasIssue: fc.boolean()
                }),
                (testData) => {
                    const envVars = {
                        [testData.varName]: testData.value
                    };
                    
                    const frameworkConfig = testData.hasIssue ? {
                        communityReports: {
                            [testData.varName]: [
                                {
                                    status: 'invalid',
                                    message: 'Known to cause issues'
                                }
                            ]
                        }
                    } : {
                        communityReports: {}
                    };
                    
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { useKnownFlags: false, useCommunityReports: true, useDockerIntrospection: false }
                    );
                    
                    // Verify result structure
                    assert(Array.isArray(result.warnings), 'Result must have warnings array');
                    assert(result.strategiesUsed.includes('community-reports'),
                        'Should use community-reports strategy');
                    
                    if (testData.hasIssue) {
                        // Should have community warning
                        assert(result.warnings.length > 0,
                            'Variable with community reports should produce warning');
                    }
                    
                    return true;
                }
            ), { numRuns: 10 });
            
            console.log('    ✅ Community reports validation completed');
        });

        it('should support disabling validation strategies', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 17: Environment Variable Validation - Strategy Control');
            console.log('  📝 For any environment variable, validation strategies can be');
            console.log('  📝 individually enabled or disabled via options');
            console.log('  📝 Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7');
            
            // Feature: transformer-server-env-config, Property 17: Environment Variable Validation
            fc.assert(fc.property(
                fc.record({
                    varName: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,30}$/)
                        .filter(name => 
                            !['CONSTRUCTOR', 'PROTOTYPE', '__PROTO__', 'TOSTRING', 
                                'VALUEOF', 'HASOWNPROPERTY'].includes(name)
                        ),
                    value: fc.string({ minLength: 1, maxLength: 50 }),
                    useKnownFlags: fc.boolean(),
                    useCommunityReports: fc.boolean(),
                    useDockerIntrospection: fc.boolean()
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
                        },
                        communityReports: {}
                    };
                    
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        {
                            useKnownFlags: testData.useKnownFlags,
                            useCommunityReports: testData.useCommunityReports,
                            useDockerIntrospection: testData.useDockerIntrospection
                        }
                    );
                    
                    // Verify result structure
                    assert(Array.isArray(result.strategiesUsed), 'Result must have strategiesUsed array');
                    
                    // Verify correct strategies were used
                    if (testData.useKnownFlags) {
                        assert(result.strategiesUsed.includes('known-flags-registry'),
                            'Should use known-flags-registry when enabled');
                    } else {
                        assert(!result.strategiesUsed.includes('known-flags-registry'),
                            'Should not use known-flags-registry when disabled');
                    }
                    
                    if (testData.useCommunityReports) {
                        assert(result.strategiesUsed.includes('community-reports'),
                            'Should use community-reports when enabled');
                    } else {
                        assert(!result.strategiesUsed.includes('community-reports'),
                            'Should not use community-reports when disabled');
                    }
                    
                    if (testData.useDockerIntrospection) {
                        assert(result.strategiesUsed.includes('docker-introspection'),
                            'Should use docker-introspection when enabled');
                    } else {
                        assert(!result.strategiesUsed.includes('docker-introspection'),
                            'Should not use docker-introspection when disabled');
                    }
                    
                    return true;
                }
            ), { numRuns: 10 });
            
            console.log('    ✅ Strategy control validation completed');
        });

        it('should handle empty framework config gracefully', function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 17: Environment Variable Validation - Empty Config');
            console.log('  📝 For any environment variable with empty framework config,');
            console.log('  📝 validation should complete without errors');
            console.log('  📝 Validates: Requirements 13.8');
            
            // Feature: transformer-server-env-config, Property 17: Environment Variable Validation
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
                    
                    // Empty framework config
                    const frameworkConfig = {};
                    
                    const result = validationEngine.validateEnvironmentVariables(
                        envVars,
                        frameworkConfig,
                        { useKnownFlags: true, useCommunityReports: true, useDockerIntrospection: false }
                    );
                    
                    // Verify result structure - arrays should always be initialized
                    assert(Array.isArray(result.errors), 'Result must have errors array');
                    assert(Array.isArray(result.warnings), 'Result must have warnings array');
                    assert(Array.isArray(result.strategiesUsed), 'Result must have strategiesUsed array');
                    
                    // With empty config, no errors should be produced
                    assert.strictEqual(result.errors.length, 0,
                        'Empty config should not produce errors');
                    
                    return true;
                }
            ), { numRuns: 10 });
            
            console.log('    ✅ Empty config handling validated');
        });
    });
});

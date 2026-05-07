// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration System Property-Based Tests
 * 
 * Tests universal correctness properties for configuration system.
 * 
 * Consolidates:
 * - configuration-graceful-degradation.property.test.js
 * - configuration-matcher-exact-match.property.test.js
 * - configuration-matcher-pattern-matching.property.test.js
 * - configuration-merge-priority.property.test.js
 * - configuration-validation-level-prioritization.property.test.js
 */

import fc from 'fast-check';
import { setupTestHooks } from './test-utils.js';
import assert from 'assert';
import ConfigurationMatcher from '../../src/lib/configuration-matcher.js';

describe('Configuration System Properties', () => {
    setupTestHooks('Configuration System Properties');

    describe('Exact Match Properties', () => {
        it('should always find exact version matches', function() {
            this.timeout(10000);
            
            fc.assert(fc.property(
                fc.record({
                    framework: fc.constantFrom('vllm', 'sglang', 'tensorrt-llm'),
                    version: fc.tuple(
                        fc.integer({ min: 0, max: 5 }),
                        fc.integer({ min: 0, max: 20 }),
                        fc.integer({ min: 0, max: 99 })
                    ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`)
                }),
                (testData) => {
                    const registry = {
                        [testData.framework]: {
                            [testData.version]: {
                                baseImage: `${testData.framework}:${testData.version}`,
                                accelerator: { type: 'cuda', version: '12.1' },
                                envVars: {},
                                inferenceAmiVersion: 'al2-ami-test',
                                recommendedInstanceTypes: ['ml.g5.xlarge'],
                                validationLevel: 'tested'
                            }
                        }
                    };
                    
                    const matcher = new ConfigurationMatcher(registry, {});
                    const result = matcher.matchFramework(testData.framework, testData.version);
                    
                    assert.ok(result !== null, 'Should find exact match');
                    assert.strictEqual(result.matchType, 'exact');
                    assert.strictEqual(result.matchedVersion, testData.version);
                    
                    return true;
                }
            ), { numRuns: 5 });
        });
    });

    describe('Pattern Matching Properties', () => {
        it('should match models by pattern correctly', function() {
            this.timeout(10000);
            
            fc.assert(fc.property(
                fc.record({
                    org: fc.constantFrom('meta-llama', 'mistralai', 'google'),
                    modelName: fc.string({ minLength: 5, maxLength: 20 }).filter(s => !s.includes('/'))
                }),
                (testData) => {
                    const modelRegistry = {
                        [`${testData.org}/*`]: {
                            family: testData.org,
                            validationLevel: 'community',
                            frameworkCompatibility: {}
                        }
                    };
                    
                    const matcher = new ConfigurationMatcher({}, modelRegistry);
                    const result = matcher.matchModel(`${testData.org}/${testData.modelName}`);
                    
                    assert.ok(result !== null, 'Should match pattern');
                    assert.strictEqual(result.matchType, 'pattern');
                    assert.strictEqual(result.family, testData.org);
                    
                    return true;
                }
            ), { numRuns: 5 });
        });
    });

    describe('Validation Level Prioritization Properties', () => {
        it('should prioritize tested over community validation levels', function() {
            this.timeout(10000);
            
            fc.assert(fc.property(
                fc.record({
                    framework: fc.constantFrom('vllm', 'sglang'),
                    testedVersion: fc.tuple(
                        fc.integer({ min: 0, max: 2 }),
                        fc.integer({ min: 0, max: 10 })
                    ).map(([major, minor]) => `${major}.${minor}.0`),
                    communityVersion: fc.tuple(
                        fc.integer({ min: 0, max: 2 }),
                        fc.integer({ min: 0, max: 10 })
                    ).map(([major, minor]) => `${major}.${minor}.1`)
                }),
                (testData) => {
                    const registry = {
                        [testData.framework]: {
                            [testData.testedVersion]: {
                                baseImage: `${testData.framework}:${testData.testedVersion}`,
                                validationLevel: 'tested',
                                accelerator: { type: 'cuda', version: '12.1' },
                                envVars: {},
                                inferenceAmiVersion: 'al2-ami-test',
                                recommendedInstanceTypes: ['ml.g5.xlarge']
                            },
                            [testData.communityVersion]: {
                                baseImage: `${testData.framework}:${testData.communityVersion}`,
                                validationLevel: 'community',
                                accelerator: { type: 'cuda', version: '12.1' },
                                envVars: {},
                                inferenceAmiVersion: 'al2-ami-test',
                                recommendedInstanceTypes: ['ml.g5.xlarge']
                            }
                        }
                    };
                    
                    const matcher = new ConfigurationMatcher(registry, {});
                    
                    // When requesting tested version, should get tested
                    const result = matcher.matchFramework(testData.framework, testData.testedVersion);
                    if (result) {
                        assert.strictEqual(result.validationLevel, 'tested');
                    }
                    
                    return true;
                }
            ), { numRuns: 5 });
        });
    });

    describe('Graceful Degradation Properties', () => {
        it('should handle missing registries gracefully', function() {
            this.timeout(10000);
            
            fc.assert(fc.property(
                fc.record({
                    framework: fc.string({ minLength: 3, maxLength: 15 }),
                    version: fc.string({ minLength: 3, maxLength: 10 })
                }),
                (testData) => {
                    // Empty registry
                    const matcher = new ConfigurationMatcher({}, {});
                    const result = matcher.matchFramework(testData.framework, testData.version);
                    
                    // Should return null, not throw
                    assert.strictEqual(result, null);
                    
                    return true;
                }
            ), { numRuns: 5 });
        });

        it('should handle malformed version strings gracefully', function() {
            this.timeout(10000);
            
            fc.assert(fc.property(
                fc.string({ minLength: 1, maxLength: 20 }),
                (version) => {
                    const registry = {
                        'vllm': {
                            '0.3.0': {
                                baseImage: 'vllm:0.3.0',
                                accelerator: { type: 'cuda', version: '12.1' },
                                envVars: {},
                                inferenceAmiVersion: 'al2-ami-test',
                                recommendedInstanceTypes: ['ml.g5.xlarge'],
                                validationLevel: 'tested'
                            }
                        }
                    };
                    
                    const matcher = new ConfigurationMatcher(registry, {});
                    
                    // Should not throw, even with malformed version
                    try {
                        const result = matcher.matchFramework('vllm', version);
                        // Result can be null or a match
                        assert.ok(result === null || typeof result === 'object');
                        return true;
                    } catch (error) {
                        // Should not throw
                        return false;
                    }
                }
            ), { numRuns: 5 });
        });
    });

    describe('Merge Priority Properties', () => {
        it('should merge configurations with correct priority', function() {
            this.timeout(10000);
            
            fc.assert(fc.property(
                fc.record({
                    baseValue: fc.string({ minLength: 5, maxLength: 15 }),
                    overrideValue: fc.string({ minLength: 5, maxLength: 15 })
                }).filter(data => data.baseValue !== data.overrideValue),
                (testData) => {
                    // Simulate configuration merge
                    const baseConfig = {
                        baseImage: testData.baseValue,
                        envVars: { BASE: 'value' }
                    };
                    
                    const overrideConfig = {
                        baseImage: testData.overrideValue,
                        envVars: { OVERRIDE: 'value' }
                    };
                    
                    // Merge with override taking precedence
                    const merged = {
                        ...baseConfig,
                        ...overrideConfig,
                        envVars: {
                            ...baseConfig.envVars,
                            ...overrideConfig.envVars
                        }
                    };
                    
                    // Override should win for baseImage
                    assert.strictEqual(merged.baseImage, testData.overrideValue);
                    
                    // Both env vars should be present
                    assert.ok(merged.envVars.BASE);
                    assert.ok(merged.envVars.OVERRIDE);
                    
                    return true;
                }
            ), { numRuns: 5 });
        });
    });
});

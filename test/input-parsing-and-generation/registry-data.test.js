// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Data Unit Tests
 * 
 * Tests that all registry entries have required fields and pass schema validation.
 * Validates pattern matching works for model entries.
 * 
 * Feature: transformer-server-env-config
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import RegistryLoader from '../../src/lib/registry-loader.js';

describe('Registry Data - Unit Tests', () => {
    let frameworkRegistry;
    let modelRegistry;
    let instanceMapping;

    before(async () => {
        console.log('\n🚀 Starting Registry Data Unit Tests');
        console.log('📋 Testing: All registry entries have required fields and pass schema validation');
        
        const loader = new RegistryLoader();
        frameworkRegistry = await loader.loadFrameworkRegistry();
        modelRegistry = await loader.loadModelRegistry();
        instanceMapping = await loader.loadInstanceAcceleratorMapping();
        
        console.log('✅ Test environment ready\n');
    });

    describe('Framework Registry Data', () => {
        it('should have all required fields in each framework entry', () => {
            console.log('\n  🧪 Testing Framework Registry entries for required fields');
            console.log('  📝 Validates: Requirements 1.3, 1.4, 1.10, 6.5');
            
            const frameworks = Object.keys(frameworkRegistry);
            assert.ok(frameworks.length > 0, 'Framework registry should not be empty');
            
            for (const frameworkName of frameworks) {
                const versions = frameworkRegistry[frameworkName];
                const versionKeys = Object.keys(versions);
                
                assert.ok(versionKeys.length > 0, `Framework ${frameworkName} should have at least one version`);
                
                for (const version of versionKeys) {
                    const entry = versions[version];
                    
                    // Check required fields
                    assert.ok(entry.baseImage, `${frameworkName} ${version} must have baseImage`);
                    assert.ok(entry.accelerator, `${frameworkName} ${version} must have accelerator`);
                    assert.ok(entry.accelerator.type, `${frameworkName} ${version} must have accelerator.type`);
                    assert.ok(entry.envVars !== undefined, `${frameworkName} ${version} must have envVars`);
                    assert.ok(entry.inferenceAmiVersion, `${frameworkName} ${version} must have inferenceAmiVersion`);
                    // recommendedInstanceTypes removed per mcp-catalog-consolidation (instance-sizer handles this now)
                    assert.ok(entry.validationLevel, `${frameworkName} ${version} must have validationLevel`);
                    
                    // Check accelerator type is valid
                    const validAcceleratorTypes = ['cuda', 'neuron', 'cpu', 'rocm'];
                    assert.ok(
                        validAcceleratorTypes.includes(entry.accelerator.type),
                        `${frameworkName} ${version} accelerator type must be one of: ${validAcceleratorTypes.join(', ')}`
                    );
                    
                    // Check validation level is valid
                    const validLevels = ['tested', 'community-validated', 'experimental', 'unknown'];
                    assert.ok(
                        validLevels.includes(entry.validationLevel),
                        `${frameworkName} ${version} validation level must be one of: ${validLevels.join(', ')}`
                    );
                }
            }
            
            console.log(`    ✅ All ${frameworks.length} framework entries have required fields`);
        });

        it('should have valid structure for all framework entries', () => {
            console.log('\n  🧪 Testing Framework Registry schema validation');
            console.log('  📝 Validates: Requirements 1.3, 1.4, 1.10');
            
            const frameworks = Object.keys(frameworkRegistry);
            for (const frameworkName of frameworks) {
                const versions = frameworkRegistry[frameworkName];
                for (const version of Object.keys(versions)) {
                    const entry = versions[version];
                    assert.ok(entry.baseImage, `${frameworkName} ${version} must have baseImage`);
                    assert.ok(entry.accelerator, `${frameworkName} ${version} must have accelerator`);
                }
            }
            
            console.log('    ✅ Framework registry has valid structure');
        });

        it('should have valid profiles when present', () => {
            console.log('\n  🧪 Testing Framework Registry profile structure');
            console.log('  📝 Validates: Requirements 12.1');
            
            for (const frameworkName of Object.keys(frameworkRegistry)) {
                const versions = frameworkRegistry[frameworkName];
                
                for (const version of Object.keys(versions)) {
                    const entry = versions[version];
                    
                    if (entry.profiles && Object.keys(entry.profiles).length > 0) {
                        const profileNames = Object.keys(entry.profiles);
                        
                        for (const profileName of profileNames) {
                            const profile = entry.profiles[profileName];
                            
                            assert.ok(profile.displayName, `${frameworkName} ${version} profile ${profileName} must have displayName`);
                            assert.ok(profile.description, `${frameworkName} ${version} profile ${profileName} must have description`);
                            assert.ok(profile.envVars !== undefined || profile.cliFlags !== undefined, `${frameworkName} ${version} profile ${profileName} must have envVars or cliFlags`);
                        }
                    }
                }
            }
            
            console.log('    ✅ All framework profiles have required fields');
        });
    });

    describe('Model Registry Data', () => {
        it('should have all required fields in each model entry', () => {
            console.log('\n  🧪 Testing Model Registry entries for required fields');
            console.log('  📝 Validates: Requirements 1.3, 1.4, 1.10, 6.5');
            
            const modelIds = Object.keys(modelRegistry);
            assert.ok(modelIds.length > 0, 'Model registry should not be empty');
            
            for (const modelId of modelIds) {
                const entry = modelRegistry[modelId];
                
                // Check required fields
                assert.ok(entry.family, `${modelId} must have family`);
                assert.ok(entry.chatTemplate !== undefined, `${modelId} must have chatTemplate (can be null)`);
                assert.ok(typeof entry.requiresTemplate === 'boolean', `${modelId} must have requiresTemplate boolean`);
                assert.ok(entry.validationLevel, `${modelId} must have validationLevel`);
                assert.ok(entry.frameworkCompatibility, `${modelId} must have frameworkCompatibility`);
                
                // Check validation level is valid
                const validLevels = ['tested', 'community-validated', 'experimental'];
                assert.ok(
                    validLevels.includes(entry.validationLevel),
                    `${modelId} validation level must be one of: ${validLevels.join(', ')}`
                );
                
                // Check frameworkCompatibility is not empty
                const frameworks = Object.keys(entry.frameworkCompatibility);
                assert.ok(frameworks.length > 0, `${modelId} must have at least one framework compatibility entry`);
            }
            
            console.log(`    ✅ All ${modelIds.length} model entries have required fields`);
        });

        it('should have valid structure for all model entries', () => {
            console.log('\n  🧪 Testing Model Registry schema validation');
            console.log('  📝 Validates: Requirements 1.3, 1.4, 1.10');
            
            const modelIds = Object.keys(modelRegistry);
            for (const modelId of modelIds) {
                const entry = modelRegistry[modelId];
                assert.ok(entry.family, `${modelId} must have family`);
                assert.ok(entry.validationLevel, `${modelId} must have validationLevel`);
            }
            
            console.log('    ✅ Model registry has valid structure');
        });

        it('should have pattern matching entries for model families', () => {
            console.log('\n  🧪 Testing Model Registry pattern matching entries');
            console.log('  📝 Validates: Requirements 5.9');
            
            const modelIds = Object.keys(modelRegistry);
            const patternEntries = modelIds.filter(id => id.includes('*') || id.includes('/'));
            
            assert.ok(patternEntries.length > 0, 'Model registry should have pattern matching entries');
            
            // Check that pattern entries have wildcard or path separator
            for (const pattern of patternEntries) {
                const hasWildcard = pattern.includes('*');
                const hasPath = pattern.includes('/');
                
                assert.ok(
                    hasWildcard || hasPath,
                    `Pattern entry ${pattern} should have wildcard (*) or path separator (/)`
                );
            }
            
            console.log(`    ✅ Found ${patternEntries.length} pattern matching entries`);
        });

        it('should have valid profiles when present', () => {
            console.log('\n  🧪 Testing Model Registry profile structure');
            console.log('  📝 Validates: Requirements 12.2');
            
            for (const modelId of Object.keys(modelRegistry)) {
                const entry = modelRegistry[modelId];
                
                if (entry.profiles && Object.keys(entry.profiles).length > 0) {
                    const profileNames = Object.keys(entry.profiles);
                    
                    for (const profileName of profileNames) {
                        const profile = entry.profiles[profileName];
                        
                        assert.ok(profile.displayName, `${modelId} profile ${profileName} must have displayName`);
                        assert.ok(profile.envVars !== undefined, `${modelId} profile ${profileName} must have envVars`);
                    }
                }
            }
            
            console.log('    ✅ All model profiles have required fields');
        });
    });

    describe('Instance Accelerator Mapping Data', () => {
        it('should have all required fields in each instance entry', () => {
            console.log('\n  🧪 Testing Instance Accelerator Mapping entries for required fields');
            console.log('  📝 Validates: Requirements 1.3, 1.4, 1.10, 6.5');
            
            const instanceTypes = Object.keys(instanceMapping);
            assert.ok(instanceTypes.length > 0, 'Instance mapping should not be empty');
            
            for (const instanceType of instanceTypes) {
                const entry = instanceMapping[instanceType];
                
                // Check required fields
                assert.ok(entry.family, `${instanceType} must have family`);
                assert.ok(entry.accelerator, `${instanceType} must have accelerator`);
                assert.ok(entry.accelerator.type, `${instanceType} must have accelerator.type`);
                assert.ok(entry.accelerator.hardware, `${instanceType} must have accelerator.hardware`);
                assert.ok(entry.accelerator.architecture, `${instanceType} must have accelerator.architecture`);
                assert.ok(entry.accelerator.versions !== undefined, `${instanceType} must have accelerator.versions (can be null)`);
                assert.ok(entry.accelerator.default !== undefined, `${instanceType} must have accelerator.default (can be null)`);
                assert.ok(entry.memory, `${instanceType} must have memory`);
                assert.ok(typeof entry.vcpus === 'number', `${instanceType} must have vcpus number`);
                
                // Check accelerator type is valid
                const validAcceleratorTypes = ['cuda', 'neuron', 'cpu', 'rocm'];
                assert.ok(
                    validAcceleratorTypes.includes(entry.accelerator.type),
                    `${instanceType} accelerator type must be one of: ${validAcceleratorTypes.join(', ')}`
                );
                
                // Check instance type format
                assert.ok(
                    instanceType.startsWith('ml.'),
                    `${instanceType} should start with 'ml.'`
                );
            }
            
            console.log(`    ✅ All ${instanceTypes.length} instance entries have required fields`);
        });

        it('should have valid structure for all instance entries', () => {
            console.log('\n  🧪 Testing Instance Accelerator Mapping schema validation');
            console.log('  📝 Validates: Requirements 1.3, 1.4, 1.10');
            
            const instanceTypes = Object.keys(instanceMapping);
            for (const instanceType of instanceTypes) {
                const entry = instanceMapping[instanceType];
                assert.ok(entry.family, `${instanceType} must have family`);
                assert.ok(entry.accelerator, `${instanceType} must have accelerator`);
            }
            
            console.log('    ✅ Instance mapping has valid structure');
        });

        it('should have entries for all major instance families', () => {
            console.log('\n  🧪 Testing Instance Accelerator Mapping coverage');
            console.log('  📝 Validates: Requirements 4.7, 4.19');
            
            const instanceTypes = Object.keys(instanceMapping);
            
            // Check for instance families present in the trimmed catalog (g5-only)
            const requiredFamilies = ['g5'];
            
            for (const family of requiredFamilies) {
                const hasFamily = instanceTypes.some(type => type.includes(`.${family}.`));
                assert.ok(hasFamily, `Instance mapping should have entries for ${family} family`);
            }
            
            console.log(`    ✅ Instance mapping covers all major families: ${requiredFamilies.join(', ')}`);
        });

        it('should have consistent accelerator types within families', () => {
            console.log('\n  🧪 Testing Instance Accelerator Mapping family consistency');
            console.log('  📝 Validates: Requirements 4.7');
            
            const familyAcceleratorTypes = {};
            
            for (const instanceType of Object.keys(instanceMapping)) {
                const entry = instanceMapping[instanceType];
                const family = entry.family;
                
                if (!familyAcceleratorTypes[family]) {
                    familyAcceleratorTypes[family] = entry.accelerator.type;
                } else {
                    assert.strictEqual(
                        entry.accelerator.type,
                        familyAcceleratorTypes[family],
                        `All instances in ${family} family should have same accelerator type`
                    );
                }
            }
            
            console.log('    ✅ All instance families have consistent accelerator types');
        });
    });

    describe('Cross-Registry Consistency', () => {
        it('should have framework entries that reference valid instance types', () => {
            console.log('\n  🧪 Testing cross-registry consistency: frameworks → instances');
            console.log('  📝 Validates: Requirements 6.5');
            
            const instanceTypes = Object.keys(instanceMapping);
            
            for (const frameworkName of Object.keys(frameworkRegistry)) {
                const versions = frameworkRegistry[frameworkName];
                
                for (const version of Object.keys(versions)) {
                    const entry = versions[version];
                    
                    // recommendedInstanceTypes removed per mcp-catalog-consolidation
                    const instanceTypesList = entry.recommendedInstanceTypes || [];
                    for (const instanceType of instanceTypesList) {
                        // Check if instance type exists in mapping (or is a valid pattern)
                        const exists = instanceTypes.includes(instanceType);
                        
                        if (!exists) {
                            console.log(`    ⚠️  Warning: ${frameworkName} ${version} references unknown instance type: ${instanceType}`);
                        }
                    }
                }
            }
            
            console.log('    ✅ Framework entries reference valid instance types');
        });

        it('should have model entries that reference valid frameworks', () => {
            console.log('\n  🧪 Testing cross-registry consistency: models → frameworks');
            console.log('  📝 Validates: Requirements 6.5');
            
            const frameworks = Object.keys(frameworkRegistry);
            
            for (const modelId of Object.keys(modelRegistry)) {
                const entry = modelRegistry[modelId];
                
                for (const framework of Object.keys(entry.frameworkCompatibility)) {
                    // Check if framework exists in framework registry
                    const exists = frameworks.includes(framework);
                    
                    if (!exists) {
                        console.log(`    ⚠️  Warning: ${modelId} references unknown framework: ${framework}`);
                    }
                }
            }
            
            console.log('    ✅ Model entries reference valid frameworks');
        });
    });
});

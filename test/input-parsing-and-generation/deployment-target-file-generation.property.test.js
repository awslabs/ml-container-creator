// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment Target File Generation Property-Based Tests
 * 
 * Tests the correctness properties for deployment target file generation logic.
 * Each property validates universal behavior across many generated inputs.
 * 
 * Feature: codebuild-deployment-target
 */

import fc from 'fast-check';
import TemplateManager from '../../generators/app/lib/template-manager.js';
import { setupTestHooks } from './test-utils.js';

describe('Deployment Target File Generation - Property-Based Tests', () => {
    before(async () => {
        console.log('\n🚀 Starting Deployment Target File Generation Property Tests');
        console.log('📋 Testing: Universal correctness properties for deployment target file generation');
        console.log('🔧 Configuration: 100 iterations per property');
        console.log('✅ Property test environment ready\n');
    });

    setupTestHooks('Deployment Target File Generation Properties');

    describe('Property 1: Deployment Target Selection', () => {
        it('should only generate files appropriate for the selected deployment target and exclude conflicting artifacts', async function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 1: Deployment Target Selection');
            console.log('  📝 For any deployment target selection ("codebuild" or "sagemaker"), the generator should only generate files appropriate for that target and exclude conflicting deployment artifacts');
            
            // Feature: codebuild-deployment-target, Property 1: Deployment Target Selection
            await fc.assert(fc.property(
                fc.constantFrom('sagemaker', 'codebuild'),
                fc.constantFrom('sklearn', 'xgboost', 'tensorflow', 'transformers'),
                fc.constantFrom('flask', 'fastapi', 'vllm', 'sglang'),
                fc.boolean(),
                fc.boolean(),
                (deployTarget, framework, modelServer, includeSampleModel, includeTesting) => {
                    console.log(`    🔍 Testing file generation: deployTarget=${deployTarget}, framework=${framework}, modelServer=${modelServer}`);
                    
                    // Skip invalid combinations
                    if (framework === 'transformers' && !['vllm', 'sglang'].includes(modelServer)) {
                        console.log(`    ⏭️  Skipping invalid combination: ${framework} + ${modelServer}`);
                        return true;
                    }
                    
                    if (framework !== 'transformers' && ['vllm', 'sglang'].includes(modelServer)) {
                        console.log(`    ⏭️  Skipping invalid combination: ${framework} + ${modelServer}`);
                        return true;
                    }
                    
                    const answers = {
                        framework,
                        modelServer,
                        deployTarget,
                        includeSampleModel,
                        includeTesting
                    };
                    
                    const templateManager = new TemplateManager(answers);
                    const ignorePatterns = templateManager.getIgnorePatterns();
                    
                    console.log(`    📋 Generated ${ignorePatterns.length} ignore patterns for ${deployTarget}`);
                    
                    // Define deployment-specific files
                    const codebuildOnlyFiles = [
                        '**/buildspec.yml',
                        '**/deploy/submit_build.sh',
                        '**/IAM_PERMISSIONS.md'
                    ];
                    
                    const sagemakerOnlyFiles = [
                        '**/deploy/build_and_push.sh'
                    ];
                    
                    if (deployTarget === 'codebuild') {
                        // CodeBuild should exclude SageMaker-only files
                        sagemakerOnlyFiles.forEach(file => {
                            if (!ignorePatterns.includes(file)) {
                                throw new Error(`CodeBuild deployment should exclude SageMaker file: ${file}`);
                            }
                        });
                        
                        // CodeBuild should NOT exclude its own files
                        codebuildOnlyFiles.forEach(file => {
                            if (ignorePatterns.includes(file)) {
                                throw new Error(`CodeBuild deployment should not exclude its own file: ${file}`);
                            }
                        });
                        
                        console.log(`    ✅ CodeBuild correctly excludes SageMaker files and includes CodeBuild files`);
                        
                    } else if (deployTarget === 'sagemaker') {
                        // SageMaker should exclude CodeBuild-only files
                        codebuildOnlyFiles.forEach(file => {
                            if (!ignorePatterns.includes(file)) {
                                throw new Error(`SageMaker deployment should exclude CodeBuild file: ${file}`);
                            }
                        });
                        
                        // SageMaker should NOT exclude its own files
                        sagemakerOnlyFiles.forEach(file => {
                            if (ignorePatterns.includes(file)) {
                                throw new Error(`SageMaker deployment should not exclude its own file: ${file}`);
                            }
                        });
                        
                        console.log(`    ✅ SageMaker correctly excludes CodeBuild files and includes SageMaker files`);
                    }
                    
                    // Verify no deployment target excludes ALL deployment files
                    const allDeploymentFiles = [...codebuildOnlyFiles, ...sagemakerOnlyFiles];
                    const excludesAllFiles = allDeploymentFiles.every(file => ignorePatterns.includes(file));
                    
                    if (excludesAllFiles) {
                        throw new Error(`Deployment target ${deployTarget} should not exclude all deployment files`);
                    }
                    
                    console.log(`    ✅ Deployment target ${deployTarget} file generation correct`);
                    return true;
                }
            ), { 
                numRuns: 100,
                verbose: false
            });
            
            console.log('  ✅ Property 1 validated: Deployment target selection working correctly');
        });

        it('should maintain consistent exclusion patterns across framework variations', async function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 1b: Framework-Independent Deployment Exclusions');
            console.log('  📝 For any framework and model server combination, deployment target exclusions should be consistent');
            
            // Feature: codebuild-deployment-target, Property 1: Deployment Target Selection (consistency aspect)
            await fc.assert(fc.property(
                fc.constantFrom('sagemaker', 'codebuild'),
                fc.constantFrom('sklearn', 'xgboost', 'tensorflow'),
                fc.constantFrom('flask', 'fastapi'),
                fc.constantFrom('pkl', 'joblib', 'json', 'model', 'keras', 'h5'),
                (deployTarget, framework, modelServer, modelFormat) => {
                    console.log(`    🔍 Testing consistency: deployTarget=${deployTarget}, framework=${framework}, modelServer=${modelServer}`);
                    
                    // Skip invalid format combinations
                    if (framework === 'sklearn' && !['pkl', 'joblib'].includes(modelFormat)) {
                        return true;
                    }
                    if (framework === 'xgboost' && !['json', 'model'].includes(modelFormat)) {
                        return true;
                    }
                    if (framework === 'tensorflow' && !['keras', 'h5'].includes(modelFormat)) {
                        return true;
                    }
                    
                    const answers = {
                        framework,
                        modelServer,
                        modelFormat,
                        deployTarget,
                        includeSampleModel: true,
                        includeTesting: true
                    };
                    
                    const templateManager = new TemplateManager(answers);
                    const ignorePatterns = templateManager.getIgnorePatterns();
                    
                    // Deployment exclusions should be consistent regardless of framework
                    if (deployTarget === 'codebuild') {
                        // Should always exclude SageMaker files
                        if (!ignorePatterns.includes('**/deploy/build_and_push.sh')) {
                            throw new Error(`CodeBuild should always exclude build_and_push.sh regardless of framework ${framework}`);
                        }
                        
                        // Should never exclude CodeBuild files
                        const codebuildFiles = ['**/buildspec.yml', '**/deploy/submit_build.sh', '**/IAM_PERMISSIONS.md'];
                        codebuildFiles.forEach(file => {
                            if (ignorePatterns.includes(file)) {
                                throw new Error(`CodeBuild should never exclude ${file} regardless of framework ${framework}`);
                            }
                        });
                        
                    } else if (deployTarget === 'sagemaker') {
                        // Should always exclude CodeBuild files
                        const codebuildFiles = ['**/buildspec.yml', '**/deploy/submit_build.sh', '**/IAM_PERMISSIONS.md'];
                        codebuildFiles.forEach(file => {
                            if (!ignorePatterns.includes(file)) {
                                throw new Error(`SageMaker should always exclude ${file} regardless of framework ${framework}`);
                            }
                        });
                        
                        // Should never exclude SageMaker files
                        if (ignorePatterns.includes('**/deploy/build_and_push.sh')) {
                            throw new Error(`SageMaker should never exclude build_and_push.sh regardless of framework ${framework}`);
                        }
                    }
                    
                    console.log(`    ✅ Deployment exclusions consistent for ${framework} + ${modelServer}`);
                    return true;
                }
            ), { 
                numRuns: 100,
                verbose: false
            });
            
            console.log('  ✅ Property 1b validated: Framework-independent deployment exclusions working correctly');
        });

        it('should handle transformer framework deployment exclusions correctly', async function() {
            this.timeout(30000);
            
            console.log('\n  🧪 Property 1c: Transformer Framework Deployment Exclusions');
            console.log('  📝 For transformer framework with any deployment target, both framework and deployment exclusions should work together');
            
            // Feature: codebuild-deployment-target, Property 1: Deployment Target Selection (transformer aspect)
            await fc.assert(fc.property(
                fc.constantFrom('sagemaker', 'codebuild'),
                fc.constantFrom('vllm', 'sglang'),
                fc.boolean(),
                fc.boolean(),
                (deployTarget, modelServer, includeSampleModel, includeTesting) => {
                    console.log(`    🔍 Testing transformer exclusions: deployTarget=${deployTarget}, modelServer=${modelServer}`);
                    
                    const answers = {
                        framework: 'transformers',
                        modelServer,
                        deployTarget,
                        includeSampleModel,
                        includeTesting
                    };
                    
                    const templateManager = new TemplateManager(answers);
                    const ignorePatterns = templateManager.getIgnorePatterns();
                    
                    // Transformers should always exclude traditional ML files
                    const transformerExclusions = [
                        '**/code/model_handler.py',
                        '**/code/start_server.py',
                        '**/code/serve.py',
                        '**/nginx.conf**',
                        '**/requirements.txt**',
                        '**/test/test_local_image.sh',
                        '**/test/test_model_handler.py'
                    ];
                    
                    transformerExclusions.forEach(file => {
                        if (!ignorePatterns.includes(file)) {
                            throw new Error(`Transformers should always exclude traditional ML file: ${file}`);
                        }
                    });
                    
                    // Deployment-specific exclusions should still apply
                    if (deployTarget === 'codebuild') {
                        if (!ignorePatterns.includes('**/deploy/build_and_push.sh')) {
                            throw new Error(`Transformers + CodeBuild should exclude SageMaker build script`);
                        }
                        
                        const codebuildFiles = ['**/buildspec.yml', '**/deploy/submit_build.sh', '**/IAM_PERMISSIONS.md'];
                        codebuildFiles.forEach(file => {
                            if (ignorePatterns.includes(file)) {
                                throw new Error(`Transformers + CodeBuild should not exclude CodeBuild file: ${file}`);
                            }
                        });
                        
                    } else if (deployTarget === 'sagemaker') {
                        const codebuildFiles = ['**/buildspec.yml', '**/deploy/submit_build.sh', '**/IAM_PERMISSIONS.md'];
                        codebuildFiles.forEach(file => {
                            if (!ignorePatterns.includes(file)) {
                                throw new Error(`Transformers + SageMaker should exclude CodeBuild file: ${file}`);
                            }
                        });
                        
                        if (ignorePatterns.includes('**/deploy/build_and_push.sh')) {
                            throw new Error(`Transformers + SageMaker should not exclude SageMaker build script`);
                        }
                    }
                    
                    console.log(`    ✅ Transformer + ${deployTarget} exclusions working correctly`);
                    return true;
                }
            ), { 
                numRuns: 100,
                verbose: false
            });
            
            console.log('  ✅ Property 1c validated: Transformer framework deployment exclusions working correctly');
        });
    });

    after(() => {
        console.log('\n📊 Deployment Target File Generation Property Tests completed');
        console.log('✅ All universal correctness properties validated');
    });
});
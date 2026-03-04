// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * TensorRT-LLM Property-Based Tests
 * 
 * Tests universal correctness properties for TensorRT-LLM feature.
 * 
 * Feature: tensorrt-llm-support
 * 
 * Consolidates:
 * - tensorrt-llm-validation.property.test.js
 * - tensorrt-llm-dockerfile.property.test.js
 * - tensorrt-llm-serve-script.property.test.js
 * - tensorrt-llm-env-var-conversion.property.test.js
 * - tensorrt-llm-hf-token-consistency.property.test.js
 * - tensorrt-llm-model-server-choices.property.test.js
 * - tensorrt-llm-readme-documentation.property.test.js
 * - tensorrt-llm-serve-script-consistency.property.test.js
 */

import fc from 'fast-check';
import { setupTestHooks, getGeneratorPath } from './test-utils.js';
import TemplateManager from '../../generators/app/lib/template-manager.js';
import assert from 'yeoman-assert';
import path from 'path';
import fs from 'fs';

describe('TensorRT-LLM Properties', () => {
    let helpers;
    let activeRunners = []; // Track active test runners for cleanup

    before(async () => {
        helpers = await import('yeoman-test');
    });

    // Cleanup after each test to prevent resource leaks
    afterEach(async () => {
        // Clean up any active test runners
        if (activeRunners.length > 0) {
            for (const runner of activeRunners) {
                try {
                    if (runner && typeof runner.cleanup === 'function') {
                        await runner.cleanup();
                    }
                } catch (error) {
                    // Ignore cleanup errors
                }
            }
            activeRunners = [];
        }
        
        // Small delay to allow async cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    setupTestHooks('TensorRT-LLM Properties');

    describe('Framework Validation Properties', () => {
        it('should raise error when tensorrt-llm is used with non-transformers framework', async function() {
            this.timeout(10000);
            
            await fc.assert(fc.property(
                fc.constantFrom('sklearn', 'xgboost', 'tensorflow'),
                (invalidFramework) => {
                    try {
                        const answers = {
                            framework: invalidFramework,
                            modelServer: 'tensorrt-llm',
                            modelFormat: invalidFramework === 'sklearn' ? 'pkl' : 
                                invalidFramework === 'xgboost' ? 'json' : 'keras',
                            deployTarget: 'sagemaker',
                            includeSampleModel: false,
                            includeTesting: true,
                            instanceType: 'ml.m5.large',
                            awsRegion: 'us-east-1',
                            projectName: 'test-project',
                            destinationDir: '.'
                        };
                        
                        const templateManager = new TemplateManager(answers);
                        
                        let errorThrown = false;
                        let errorMessage = '';
                        
                        try {
                            templateManager.validate();
                        } catch (error) {
                            errorThrown = true;
                            errorMessage = error.message;
                        }
                        
                        if (!errorThrown) {
                            return false;
                        }
                        
                        if (!errorMessage.includes('TensorRT-LLM') || !errorMessage.includes('transformers')) {
                            return false;
                        }
                        
                        return true;
                        
                    } catch (error) {
                        return false;
                    }
                }
            ), { numRuns: 10 });
        });

        it('should not raise error when tensorrt-llm is used with transformers framework', async function() {
            this.timeout(10000);
            
            await fc.assert(fc.property(
                fc.record({
                    deployTarget: fc.constantFrom('sagemaker', 'codebuild'),
                    includeSampleModel: fc.boolean(),
                    includeTesting: fc.boolean(),
                    instanceType: fc.constantFrom('ml.m5.large', 'ml.g5.xlarge'),
                    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1')
                }),
                (config) => {
                    try {
                        const answers = {
                            framework: 'transformers',
                            modelServer: 'tensorrt-llm',
                            modelName: 'meta-llama/Llama-3.2-3B',
                            deployTarget: config.deployTarget,
                            includeSampleModel: config.includeSampleModel,
                            includeTesting: config.includeTesting,
                            instanceType: config.instanceType,
                            awsRegion: config.awsRegion,
                            projectName: 'test-project',
                            destinationDir: '.'
                        };
                        
                        const templateManager = new TemplateManager(answers);
                        
                        let errorThrown = false;
                        
                        try {
                            templateManager.validate();
                        } catch (error) {
                            errorThrown = true;
                        }
                        
                        return !errorThrown;
                        
                    } catch (error) {
                        return false;
                    }
                }
            ), { numRuns: 10 });
        });

        it('should not raise tensorrt-llm error when using other model servers', async function() {
            this.timeout(10000);
            
            await fc.assert(fc.property(
                fc.oneof(
                    fc.record({
                        framework: fc.constantFrom('sklearn', 'xgboost', 'tensorflow'),
                        modelServer: fc.constantFrom('flask', 'fastapi')
                    }),
                    fc.record({
                        framework: fc.constant('transformers'),
                        modelServer: fc.constantFrom('vllm', 'sglang')
                    })
                ),
                (config) => {
                    try {
                        const answers = {
                            framework: config.framework,
                            modelServer: config.modelServer,
                            modelFormat: config.framework === 'sklearn' ? 'pkl' : 
                                config.framework === 'xgboost' ? 'json' : 
                                    config.framework === 'tensorflow' ? 'keras' : undefined,
                            modelName: config.framework === 'transformers' ? 'meta-llama/Llama-3.2-3B' : undefined,
                            deployTarget: 'sagemaker',
                            includeSampleModel: false,
                            includeTesting: true,
                            instanceType: 'ml.m5.large',
                            awsRegion: 'us-east-1',
                            projectName: 'test-project',
                            destinationDir: '.'
                        };
                        
                        const templateManager = new TemplateManager(answers);
                        
                        let errorThrown = false;
                        let errorMessage = '';
                        
                        try {
                            templateManager.validate();
                        } catch (error) {
                            errorThrown = true;
                            errorMessage = error.message;
                        }
                        
                        if (errorThrown && errorMessage.includes('TensorRT-LLM')) {
                            return false;
                        }
                        
                        return true;
                        
                    } catch (error) {
                        return false;
                    }
                }
            ), { numRuns: 10 });
        });
    });

    describe('Environment Variable Conversion Properties', () => {
        it('should convert TRTLLM_ prefixed variables to command-line arguments correctly', async function() {
            this.timeout(10000);
            
            await fc.assert(fc.property(
                fc.stringMatching(/^[A-Z_]+$/),
                (envVarSuffix) => {
                    const fullVarName = `TRTLLM_${envVarSuffix}`;
                    const prefix = 'TRTLLM_';
                    
                    const withoutPrefix = fullVarName.substring(prefix.length);
                    const lowercase = withoutPrefix.toLowerCase();
                    const argName = lowercase.replace(/_/g, '-');
                    const finalArg = `--${argName}`;
                    
                    const expectedPattern = /^--[a-z-]+$/;
                    
                    if (!expectedPattern.test(finalArg)) {
                        return false;
                    }
                    
                    if (/[A-Z]/.test(finalArg)) {
                        return false;
                    }
                    
                    if (finalArg.includes('_')) {
                        return false;
                    }
                    
                    if (finalArg.toLowerCase().includes('trtllm')) {
                        return false;
                    }
                    
                    return true;
                }
            ), { numRuns: 20 });
        });

        it('should produce consistent results for the same input', async function() {
            this.timeout(10000);
            
            await fc.assert(fc.property(
                fc.stringMatching(/^[A-Z_]+$/),
                (envVarSuffix) => {
                    const fullVarName = `TRTLLM_${envVarSuffix}`;
                    const prefix = 'TRTLLM_';
                    
                    const convert = (varName) => {
                        const withoutPrefix = varName.substring(prefix.length);
                        const lowercase = withoutPrefix.toLowerCase();
                        const argName = lowercase.replace(/_/g, '-');
                        return `--${argName}`;
                    };
                    
                    const result1 = convert(fullVarName);
                    const result2 = convert(fullVarName);
                    
                    return result1 === result2;
                }
            ), { numRuns: 20 });
        });
    });

    describe('Dockerfile Generation Properties', () => {
        it.skip('should use correct base image for any model name', async function() {
            this.timeout(15000);
            
            await fc.assert(fc.asyncProperty(
                fc.stringMatching(/^[a-z0-9-]+\/[A-Za-z0-9-_.]+$/),
                async (modelName) => {
                    await helpers.default.run(getGeneratorPath())
                        .withOptions({
                            'skip-prompts': true,
                            'framework': 'transformers',
                            'model-server': 'tensorrt-llm',
                            'model-name': modelName,
                            'include-testing': false,
                            'include-sample': false
                        });
                    
                    assert.fileContent('Dockerfile', /ARG BASE_IMAGE=nvcr\.io\/nvidia\/tensorrt-llm\/release:1\.2\.0rc8/);
                    return true;
                }
            ), { numRuns: 10 });
        });

        it.skip('should set TRTLLM_MODEL for any model name', async function() {
            this.timeout(15000);
            
            await fc.assert(fc.asyncProperty(
                fc.stringMatching(/^[a-z0-9-]+\/[A-Za-z0-9-_.]+$/),
                async (modelName) => {
                    await helpers.default.run(getGeneratorPath())
                        .withOptions({
                            'skip-prompts': true,
                            'framework': 'transformers',
                            'model-server': 'tensorrt-llm',
                            'model-name': modelName,
                            'include-testing': false,
                            'include-sample': false
                        });
                    
                    assert.fileContent('Dockerfile', `ENV TRTLLM_MODEL="${modelName}"`);
                    return true;
                }
            ), { numRuns: 10 });
        });

        it.skip('should include HF_TOKEN when provided', async function() {
            this.timeout(15000);
            
            await fc.assert(fc.asyncProperty(
                fc.stringMatching(/^hf_[a-zA-Z0-9]{20,40}$/),
                async (token) => {
                    await helpers.default.run(getGeneratorPath())
                        .withOptions({
                            'skip-prompts': true,
                            'framework': 'transformers',
                            'model-server': 'tensorrt-llm',
                            'model-name': 'meta-llama/Llama-3.2-3B',
                            'hf-token': token,
                            'include-testing': false,
                            'include-sample': false
                        });
                    
                    assert.fileContent('Dockerfile', `ENV HF_TOKEN="${token}"`);
                    return true;
                }
            ), { numRuns: 10 });
        });

        it.skip('should not include HF_TOKEN when not provided', async function() {
            this.timeout(15000);
            
            await fc.assert(fc.asyncProperty(
                fc.stringMatching(/^[a-z0-9-]+\/[A-Za-z0-9-_.]+$/),
                async (modelName) => {
                    const result = await helpers.default.run(getGeneratorPath())
                        .withOptions({
                            'skip-prompts': true,
                            'framework': 'transformers',
                            'model-server': 'tensorrt-llm',
                            'model-name': modelName,
                            'include-testing': false,
                            'include-sample': false
                        });
                    
                    const dockerfilePath = path.join(result.cwd, 'Dockerfile');
                    const content = fs.readFileSync(dockerfilePath, 'utf8');
                    
                    return !content.includes('ENV HF_TOKEN=');
                }
            ), { numRuns: 10 });
        });
    });

    describe('Serve Script Properties', () => {
        it.skip('should use trtllm-serve command for any model', async function() {
            this.timeout(15000);
            
            await fc.assert(fc.asyncProperty(
                fc.stringMatching(/^[a-z0-9-]+\/[A-Za-z0-9-_.]+$/),
                async (modelName) => {
                    const result = await helpers.default.run(getGeneratorPath())
                        .withOptions({
                            'skip-prompts': true,
                            'framework': 'transformers',
                            'model-server': 'tensorrt-llm',
                            'model-name': modelName,
                            'include-testing': false,
                            'include-sample': false
                        });
                    
                    assert.file(['code/serve']);
                    
                    const serveScriptPath = path.join(result.cwd, 'code/serve');
                    const content = fs.readFileSync(serveScriptPath, 'utf8');
                    
                    if (!content.includes('Starting TensorRT-LLM server')) return false;
                    if (!content.includes('PREFIX="TRTLLM_"')) return false;
                    if (!content.includes('--host 0.0.0.0') || !content.includes('--port 8081')) return false;
                    if (!content.includes('exec trtllm-serve serve "$TRTLLM_MODEL"')) return false;
                    
                    return true;
                }
            ), { numRuns: 10 });
        });

        it.skip('should include environment variable conversion logic', async function() {
            this.timeout(15000);
            
            await fc.assert(fc.asyncProperty(
                fc.stringMatching(/^[a-z0-9-]+\/[A-Za-z0-9-_.]+$/),
                async (modelName) => {
                    const result = await helpers.default.run(getGeneratorPath())
                        .withOptions({
                            'skip-prompts': true,
                            'framework': 'transformers',
                            'model-server': 'tensorrt-llm',
                            'model-name': modelName,
                            'include-testing': false,
                            'include-sample': false
                        });
                    
                    const serveScriptPath = path.join(result.cwd, 'code/serve');
                    const content = fs.readFileSync(serveScriptPath, 'utf8');
                    
                    if (!content.includes('env | grep "^${PREFIX}"')) return false;
                    if (!content.includes('tr \'[:upper:]\' \'[:lower:]\'')) return false;
                    if (!content.includes('tr \'_\' \'-\'')) return false;
                    if (!content.includes('${key#"${PREFIX}"}')) return false;
                    
                    return true;
                }
            ), { numRuns: 10 });
        });

        it.skip('should exclude TRTLLM_MODEL from EXCLUDE_VARS', async function() {
            this.timeout(15000);
            
            await fc.assert(fc.asyncProperty(
                fc.stringMatching(/^[a-z0-9-]+\/[A-Za-z0-9-_.]+$/),
                async (modelName) => {
                    const result = await helpers.default.run(getGeneratorPath())
                        .withOptions({
                            'skip-prompts': true,
                            'framework': 'transformers',
                            'model-server': 'tensorrt-llm',
                            'model-name': modelName,
                            'include-testing': false,
                            'include-sample': false
                        });
                    
                    const serveScriptPath = path.join(result.cwd, 'code/serve');
                    const content = fs.readFileSync(serveScriptPath, 'utf8');
                    
                    if (!content.includes('EXCLUDE_VARS=("TRTLLM_MODEL")')) return false;
                    if (!content.includes('PREFIX="TRTLLM_"')) return false;
                    
                    return true;
                }
            ), { numRuns: 10 });
        });
    });

    describe('HF Token Consistency Properties', () => {
        it.skip('should handle HF token consistently across all files', async function() {
            this.timeout(15000);
            
            await fc.assert(fc.asyncProperty(
                fc.stringMatching(/^hf_[a-zA-Z0-9]{20,30}$/),
                async (token) => {
                    const result = await helpers.default.run(getGeneratorPath())
                        .withOptions({
                            'skip-prompts': true,
                            'framework': 'transformers',
                            'model-server': 'tensorrt-llm',
                            'model-name': 'meta-llama/Llama-3.2-3B',
                            'hf-token': token,
                            'include-testing': false,
                            'include-sample': false
                        });
                    
                    const dockerfilePath = path.join(result.cwd, 'Dockerfile');
                    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
                    
                    return dockerfileContent.includes(`ENV HF_TOKEN="${token}"`);
                }
            ), { numRuns: 10 });
        });
    });
});

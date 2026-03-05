// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ConfigManager Unit Tests
 * 
 * Fast, focused unit tests for ConfigManager methods in isolation.
 * No Yeoman test helpers needed - uses mock generator objects.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import ConfigManager, { ValidationError } from '../../generators/app/lib/config-manager.js';
import {
    createMockGenerator,
    createMockGeneratorWithOptions,
    createMockGeneratorWithArgs,
    cleanupEnvVars
} from '../helpers/mock-generator.js';

describe('ConfigManager Unit Tests', () => {
    let configManager;
    let mockGenerator;
    let envVarsToCleanup = [];

    afterEach(() => {
        // Clean up environment variables after each test
        cleanupEnvVars(envVarsToCleanup);
        envVarsToCleanup = [];
    });

    describe('loadConfiguration()', () => {
        describe('CLI Options (Highest Priority)', () => {
            it('should load framework from CLI option', async () => {
                mockGenerator = createMockGeneratorWithOptions({ framework: 'xgboost' });
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.framework, 'xgboost');
            });

            it('should load model-server from CLI option', async () => {
                mockGenerator = createMockGeneratorWithOptions({ 'model-server': 'fastapi' });
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.modelServer, 'fastapi');
            });

            it('should load multiple CLI options', async () => {
                mockGenerator = createMockGeneratorWithOptions({
                    framework: 'sklearn',
                    'model-server': 'flask',
                    'model-format': 'pkl',
                    'include-sample': true,
                    'include-testing': false
                });
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.framework, 'sklearn');
                assert.strictEqual(config.modelServer, 'flask');
                assert.strictEqual(config.modelFormat, 'pkl');
                assert.strictEqual(config.includeSampleModel, true);
                assert.strictEqual(config.includeTesting, false);
            });

            it('should parse boolean CLI options correctly', async () => {
                mockGenerator = createMockGeneratorWithOptions({
                    'include-sample': 'true',
                    'include-testing': 'false'
                });
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.includeSampleModel, true);
                assert.strictEqual(config.includeTesting, false);
            });
        });

        describe('CLI Arguments (Positional)', () => {
            it('should load project name from first positional argument', async () => {
                mockGenerator = createMockGeneratorWithArgs(['my-awesome-project']);
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.projectName, 'my-awesome-project');
            });

            it('should track that project name came from argument', async () => {
                mockGenerator = createMockGeneratorWithArgs(['test-project']);
                configManager = new ConfigManager(mockGenerator);
                
                await configManager.loadConfiguration();
                
                assert.strictEqual(configManager.projectNameFromArgument, true);
            });

            it('should ignore additional positional arguments', async () => {
                mockGenerator = createMockGeneratorWithArgs(['project1', 'project2', 'project3']);
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.projectName, 'project1');
            });
        });

        describe('Environment Variables', () => {
            it('should load AWS_REGION from environment', async () => {
                process.env.AWS_REGION = 'eu-west-1';
                envVarsToCleanup.push('AWS_REGION');
                
                mockGenerator = createMockGenerator();
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.awsRegion, 'eu-west-1');
            });

            it('should load ML_INSTANCE_TYPE from environment', async () => {
                process.env.ML_INSTANCE_TYPE = 'ml.g5.xlarge';
                envVarsToCleanup.push('ML_INSTANCE_TYPE');
                
                mockGenerator = createMockGenerator();
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.instanceType, 'ml.g5.xlarge');
            });

            it('should load ML_DEPLOY_TARGET from environment', async () => {
                process.env.ML_DEPLOY_TARGET = 'codebuild';
                envVarsToCleanup.push('ML_DEPLOY_TARGET');
                
                mockGenerator = createMockGenerator();
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.deployTarget, 'codebuild');
            });

            it('should load AWS_ROLE from environment', async () => {
                process.env.AWS_ROLE = 'arn:aws:iam::123456789012:role/TestRole';
                envVarsToCleanup.push('AWS_ROLE');
                
                mockGenerator = createMockGenerator();
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.awsRoleArn, 'arn:aws:iam::123456789012:role/TestRole');
            });

            it('should ignore unsupported environment variables', async () => {
                process.env.ML_FRAMEWORK = 'sklearn';
                process.env.ML_MODEL_SERVER = 'flask';
                envVarsToCleanup.push('ML_FRAMEWORK', 'ML_MODEL_SERVER');
                
                mockGenerator = createMockGenerator();
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.framework, null);
                assert.strictEqual(config.modelServer, null);
            });
        });

        describe('Source Precedence', () => {
            it('should prioritize CLI options over environment variables', async () => {
                process.env.AWS_REGION = 'us-west-2';
                envVarsToCleanup.push('AWS_REGION');
                
                mockGenerator = createMockGeneratorWithOptions({ region: 'eu-central-1' });
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.awsRegion, 'eu-central-1');
            });

            it('should prioritize CLI options over CLI arguments for project name', async () => {
                mockGenerator = createMockGenerator(
                    { 'project-name': 'option-project' },
                    ['argument-project']
                );
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                // CLI options have higher precedence than CLI arguments
                assert.strictEqual(config.projectName, 'option-project');
            });

            it('should use defaults when no explicit configuration provided', async () => {
                mockGenerator = createMockGenerator();
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.awsRegion, 'us-east-1'); // Default
                assert.strictEqual(config.deployTarget, 'codebuild'); // Default
                assert.strictEqual(config.includeTesting, true); // Default
            });
        });
    });

    describe('validateConfiguration()', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
        });

        describe('Framework Validation', () => {
            it('should accept valid frameworks', async () => {
                await configManager.loadConfiguration();
                configManager.config.framework = 'sklearn';
                
                const errors = configManager.validateConfiguration();
                
                assert.ok(Array.isArray(errors));
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid frameworks', async () => {
                await configManager.loadConfiguration();
                configManager.config.framework = 'pytorch';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Unsupported framework: pytorch'));
            });
        });

        describe('Model Server Validation', () => {
            it('should accept valid sklearn + flask combination', async () => {
                await configManager.loadConfiguration();
                configManager.config.framework = 'sklearn';
                configManager.config.modelServer = 'flask';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should accept valid transformers + vllm combination', async () => {
                await configManager.loadConfiguration();
                configManager.config.framework = 'transformers';
                configManager.config.modelServer = 'vllm';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid sklearn + vllm combination', async () => {
                await configManager.loadConfiguration();
                configManager.config.framework = 'sklearn';
                configManager.config.modelServer = 'vllm';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Unsupported model server'));
            });

            it('should provide special error for tensorrt-llm with non-transformers', async () => {
                await configManager.loadConfiguration();
                configManager.config.framework = 'sklearn';
                configManager.config.modelServer = 'tensorrt-llm';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('TensorRT-LLM is only supported with the transformers framework'));
            });
        });

        describe('Model Format Validation', () => {
            it('should accept valid sklearn + pkl combination', async () => {
                await configManager.loadConfiguration();
                configManager.config.framework = 'sklearn';
                configManager.config.modelFormat = 'pkl';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid sklearn + keras combination', async () => {
                await configManager.loadConfiguration();
                configManager.config.framework = 'sklearn';
                configManager.config.modelFormat = 'keras';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Unsupported model format'));
            });
        });

        describe('AWS Role ARN Validation', () => {
            it('should accept valid ARN format', async () => {
                await configManager.loadConfiguration();
                configManager.config.awsRoleArn = 'arn:aws:iam::123456789012:role/MyRole';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid ARN format', async () => {
                await configManager.loadConfiguration();
                configManager.config.awsRoleArn = 'invalid-arn';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Invalid AWS Role ARN format'));
            });
        });

        describe('CodeBuild Validation', () => {
            it('should accept valid CodeBuild compute type', async () => {
                await configManager.loadConfiguration();
                configManager.config.codebuildComputeType = 'BUILD_GENERAL1_MEDIUM';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid CodeBuild compute type', async () => {
                await configManager.loadConfiguration();
                configManager.config.codebuildComputeType = 'BUILD_INVALID_TYPE';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Unsupported CodeBuild compute type'));
            });

            it('should accept valid CodeBuild project name', async () => {
                await configManager.loadConfiguration();
                configManager.config.codebuildProjectName = 'my-build-project-123';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid CodeBuild project name', async () => {
                await configManager.loadConfiguration();
                configManager.config.codebuildProjectName = '-invalid-name';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Invalid CodeBuild project name'));
            });
        });
    });

    describe('getFinalConfiguration()', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
        });

        it('should merge prompt answers with explicit configuration', async () => {
            await configManager.loadConfiguration();
            configManager.explicitConfig = { framework: 'sklearn' };
            
            const promptAnswers = {
                framework: 'xgboost', // Should be overridden
                modelServer: 'flask'
            };
            
            const finalConfig = configManager.getFinalConfiguration(promptAnswers);
            
            assert.strictEqual(finalConfig.framework, 'sklearn'); // Explicit config wins
            assert.strictEqual(finalConfig.modelServer, 'flask'); // From prompts
        });

        it('should fill in missing values with defaults', async () => {
            await configManager.loadConfiguration();
            
            const finalConfig = configManager.getFinalConfiguration({});
            
            assert.strictEqual(finalConfig.awsRegion, 'us-east-1');
            assert.strictEqual(finalConfig.deployTarget, 'codebuild');
            assert.strictEqual(finalConfig.includeTesting, true);
        });

        it('should disable sample models for transformers framework', async () => {
            await configManager.loadConfiguration();
            
            const promptAnswers = {
                framework: 'transformers',
                includeSampleModel: true
            };
            
            const finalConfig = configManager.getFinalConfiguration(promptAnswers);
            
            assert.strictEqual(finalConfig.includeSampleModel, false);
        });

        it('should generate CodeBuild project name when deployTarget is codebuild', async () => {
            await configManager.loadConfiguration();
            
            const promptAnswers = {
                projectName: 'my-project',
                framework: 'sklearn',
                deployTarget: 'codebuild'
            };
            
            const finalConfig = configManager.getFinalConfiguration(promptAnswers);
            
            assert.ok(typeof finalConfig.codebuildProjectName === 'string');
            assert.ok(finalConfig.codebuildProjectName.includes('my-project'));
            assert.ok(finalConfig.codebuildProjectName.includes('sklearn'));
        });

        it('should add build timestamp', async () => {
            await configManager.loadConfiguration();
            
            const finalConfig = configManager.getFinalConfiguration({});
            
            assert.ok(typeof finalConfig.buildTimestamp === 'string');
            assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(finalConfig.buildTimestamp));
        });

        it('should create subdirectory when project name from argument', async () => {
            mockGenerator = createMockGeneratorWithArgs(['my-project']);
            configManager = new ConfigManager(mockGenerator);
            await configManager.loadConfiguration();
            
            const finalConfig = configManager.getFinalConfiguration({});
            
            assert.strictEqual(finalConfig.destinationDir, './my-project');
        });

        it('should not create subdirectory when project-dir explicitly provided', async () => {
            mockGenerator = createMockGenerator(
                { 'project-dir': '/tmp/output' },
                ['my-project']
            );
            configManager = new ConfigManager(mockGenerator);
            await configManager.loadConfiguration();
            
            const finalConfig = configManager.getFinalConfiguration({});
            
            assert.strictEqual(finalConfig.destinationDir, '/tmp/output');
        });
    });

    describe('shouldSkipPrompts()', () => {
        it('should return true when --skip-prompts flag is set', async () => {
            mockGenerator = createMockGeneratorWithOptions({ 'skip-prompts': true });
            configManager = new ConfigManager(mockGenerator);
            
            await configManager.loadConfiguration();
            
            assert.strictEqual(configManager.shouldSkipPrompts(), true);
        });

        it('should return true when all required parameters are provided', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                framework: 'sklearn',
                'model-server': 'flask',
                'model-format': 'pkl',
                'instance-type': 'ml.m5.large',
                'project-name': 'test-project'
            });
            configManager = new ConfigManager(mockGenerator);
            
            await configManager.loadConfiguration();
            
            assert.strictEqual(configManager.shouldSkipPrompts(), true);
        });

        it('should return false when required parameters are missing', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                framework: 'sklearn'
                // Missing other required parameters
            });
            configManager = new ConfigManager(mockGenerator);
            
            await configManager.loadConfiguration();
            
            assert.strictEqual(configManager.shouldSkipPrompts(), false);
        });
    });

    describe('validateRequiredParameters()', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
        });

        it('should pass validation with all required parameters', async () => {
            await configManager.loadConfiguration();
            
            const finalConfig = {
                framework: 'sklearn',
                modelServer: 'flask',
                modelFormat: 'pkl',
                instanceType: 'ml.m5.large',
                projectName: 'test-project',
                destinationDir: '.',
                deployTarget: 'codebuild',
                includeSampleModel: false,
                includeTesting: true
            };
            
            const errors = configManager.validateRequiredParameters(finalConfig);
            
            assert.strictEqual(errors.length, 0);
        });

        it('should fail validation when required parameter is missing', async () => {
            await configManager.loadConfiguration();
            
            const finalConfig = {
                framework: 'sklearn',
                // Missing modelServer
                modelFormat: 'pkl',
                instanceType: 'ml.m5.large'
            };
            
            const errors = configManager.validateRequiredParameters(finalConfig);
            
            assert.ok(errors.length > 0);
            assert.ok(errors.some(e => e.includes('modelServer')));
        });

        it('should not require modelFormat for transformers', async () => {
            await configManager.loadConfiguration();
            
            const finalConfig = {
                framework: 'transformers',
                modelServer: 'vllm',
                // No modelFormat - should be OK for transformers
                instanceType: 'ml.g5.xlarge',
                projectName: 'test-project',
                destinationDir: '.',
                deployTarget: 'codebuild',
                includeSampleModel: false,
                includeTesting: true
            };
            
            const errors = configManager.validateRequiredParameters(finalConfig);
            
            assert.strictEqual(errors.length, 0);
        });
    });

    describe('getExplicitConfiguration()', () => {
        it('should return only explicitly set configuration', async () => {
            mockGenerator = createMockGeneratorWithOptions({
                framework: 'sklearn',
                'model-server': 'flask'
            });
            configManager = new ConfigManager(mockGenerator);
            
            await configManager.loadConfiguration();
            const explicitConfig = configManager.getExplicitConfiguration();
            
            assert.strictEqual(explicitConfig.framework, 'sklearn');
            assert.strictEqual(explicitConfig.modelServer, 'flask');
            // Defaults should not be in explicit config
            assert.strictEqual(explicitConfig.awsRegion, undefined);
        });

        it('should include environment variables in explicit config', async () => {
            process.env.AWS_REGION = 'eu-west-1';
            envVarsToCleanup.push('AWS_REGION');
            
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
            
            await configManager.loadConfiguration();
            const explicitConfig = configManager.getExplicitConfiguration();
            
            assert.strictEqual(explicitConfig.awsRegion, 'eu-west-1');
        });
    });

    describe('Private Methods', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
        });

        describe('_generateProjectName()', () => {
            it('should generate project name for sklearn', () => {
                const projectName = configManager._generateProjectName('sklearn');
                
                assert.ok(typeof projectName === 'string');
                assert.ok(/^[a-z]+-[a-z]+-[a-z]+$/.test(projectName));
            });

            it('should generate project name for transformers', () => {
                const projectName = configManager._generateProjectName('transformers');
                
                assert.ok(typeof projectName === 'string');
                assert.ok(/^[a-z]+-[a-z]+-[a-z]+$/.test(projectName));
            });
        });

        describe('_generateCodeBuildProjectName()', () => {
            it('should generate valid CodeBuild project name', () => {
                const buildName = configManager._generateCodeBuildProjectName('my-project', 'sklearn');
                
                assert.ok(typeof buildName === 'string');
                assert.ok(buildName.includes('my-project'));
                assert.ok(buildName.includes('sklearn'));
                assert.ok(/^[a-z0-9][a-z0-9\-_]+$/.test(buildName));
            });

            it('should sanitize invalid characters', () => {
                const buildName = configManager._generateCodeBuildProjectName('my@project!', 'sklearn');
                
                assert.ok(!buildName.includes('@'));
                assert.ok(!buildName.includes('!'));
            });
        });

        describe('_resolveHfToken()', () => {
            it('should return direct token value', () => {
                const token = configManager._resolveHfToken('hf_abc123');
                
                assert.strictEqual(token, 'hf_abc123');
            });

            it('should resolve $HF_TOKEN reference', () => {
                process.env.HF_TOKEN = 'hf_from_env';
                envVarsToCleanup.push('HF_TOKEN');
                
                const token = configManager._resolveHfToken('$HF_TOKEN');
                
                assert.strictEqual(token, 'hf_from_env');
            });

            it('should return null when $HF_TOKEN not set', () => {
                delete process.env.HF_TOKEN;
                
                const token = configManager._resolveHfToken('$HF_TOKEN');
                
                assert.strictEqual(token, null);
            });

            it('should return null for empty string', () => {
                const token = configManager._resolveHfToken('');
                
                assert.strictEqual(token, null);
            });
        });

        describe('_isValidArn()', () => {
            it('should accept valid ARN', () => {
                assert.doesNotThrow(() => {
                    configManager._isValidArn('arn:aws:iam::123456789012:role/MyRole');
                });
            });

            it('should reject invalid ARN', () => {
                assert.throws(() => {
                    configManager._isValidArn('invalid-arn');
                }, ValidationError);
            });
        });

        describe('_canAutoGenerate()', () => {
            it('should return true for auto-generatable parameters', () => {
                assert.strictEqual(configManager._canAutoGenerate('framework'), true);
                assert.strictEqual(configManager._canAutoGenerate('modelServer'), true);
                assert.strictEqual(configManager._canAutoGenerate('instanceType'), true);
            });

            it('should return false for non-auto-generatable parameters', () => {
                assert.strictEqual(configManager._canAutoGenerate('projectName'), false);
                assert.strictEqual(configManager._canAutoGenerate('awsRoleArn'), false);
            });
        });
    });
});

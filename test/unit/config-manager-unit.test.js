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
import ConfigManager, { ValidationError } from '../../src/lib/config-manager.js';
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
            it('should load deployment-config from CLI option', async () => {
                mockGenerator = createMockGeneratorWithOptions({ 'deployment-config': 'http-flask' });
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.deploymentConfig, 'http-flask');
            });

            it('should load engine from CLI option', async () => {
                mockGenerator = createMockGeneratorWithOptions({ engine: 'sklearn' });
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.engine, 'sklearn');
            });

            it('should load multiple CLI options', async () => {
                mockGenerator = createMockGeneratorWithOptions({
                    'deployment-config': 'http-flask',
                    engine: 'sklearn',
                    'model-format': 'pkl',
                    'include-sample': true,
                    'include-testing': false
                });
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.deploymentConfig, 'http-flask');
                assert.strictEqual(config.engine, 'sklearn');
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

            it('should load ML_BUILD_TARGET from environment', async () => {
                process.env.ML_BUILD_TARGET = 'codebuild';
                envVarsToCleanup.push('ML_BUILD_TARGET');
                
                mockGenerator = createMockGenerator();
                configManager = new ConfigManager(mockGenerator);
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.buildTarget, 'codebuild');
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
                
                // These env vars are not mapped to any parameter
                assert.strictEqual(config.architecture, null);
                assert.strictEqual(config.backend, null);
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
                configManager._loadBootstrapConfig = async () => {};
                
                const config = await configManager.loadConfiguration();
                
                assert.strictEqual(config.awsRegion, 'us-east-1'); // Default
                assert.strictEqual(config.buildTarget, 'codebuild'); // Default
                assert.strictEqual(config.includeTesting, true); // Default
            });
        });
    });

    describe('validateConfiguration()', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
        });

        describe('Deployment Config Validation', () => {
            it('should accept valid deployment configs', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'http-flask';
                
                const errors = configManager.validateConfiguration();
                
                assert.ok(Array.isArray(errors));
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid deployment configs', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'invalid-config';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Unsupported deployment-config: invalid-config'));
            });
        });

        describe('Old Format Migration', () => {
            it('should reject old-format sklearn-flask with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'sklearn-flask';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Use --deployment-config=http-flask --engine=sklearn instead'));
            });

            it('should reject old-format xgboost-fastapi with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'xgboost-fastapi';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Use --deployment-config=http-fastapi --engine=xgboost instead'));
            });

            it('should reject old-format tensorflow-flask with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'tensorflow-flask';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Use --deployment-config=http-flask --engine=tensorflow instead'));
            });
        });

        describe('Engine Validation', () => {
            it('should accept valid engines', async () => {
                await configManager.loadConfiguration();
                configManager.config.engine = 'sklearn';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid engines', async () => {
                await configManager.loadConfiguration();
                configManager.config.engine = 'pytorch';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Unsupported engine: pytorch'));
            });
        });

        describe('Model Server Validation', () => {
            it('should accept valid http-flask deployment config', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'http-flask';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should accept valid transformers-vllm deployment config', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'transformers-vllm';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid sklearn + vllm combination (old format)', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'sklearn-vllm';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Unsupported deployment-config'));
            });

            it('should reject unsupported triton backend', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'triton-openvino';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Unsupported deployment-config'));
            });
        });

        describe('Model Format Validation', () => {
            it('should accept valid sklearn + pkl combination', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'http-flask';
                configManager.config.engine = 'sklearn';
                configManager.config.modelFormat = 'pkl';
                
                const errors = configManager.validateConfiguration();
                
                assert.strictEqual(errors.length, 0);
            });

            it('should reject invalid sklearn + keras combination', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'http-flask';
                configManager.config.engine = 'sklearn';
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
            configManager.explicitConfig = { deploymentConfig: 'http-flask' };
            
            const promptAnswers = {
                deploymentConfig: 'http-fastapi', // Should be overridden
                engine: 'sklearn'
            };
            
            const finalConfig = configManager.getFinalConfiguration(promptAnswers);
            
            assert.strictEqual(finalConfig.deploymentConfig, 'http-flask'); // Explicit config wins
            assert.strictEqual(finalConfig.engine, 'sklearn'); // From prompts
        });

        it('should fill in missing values with defaults', async () => {
            configManager._loadBootstrapConfig = async () => {};
            await configManager.loadConfiguration();
            
            const finalConfig = configManager.getFinalConfiguration({});
            
            assert.strictEqual(finalConfig.awsRegion, 'us-east-1');
            assert.strictEqual(finalConfig.buildTarget, 'codebuild');
            assert.strictEqual(finalConfig.includeTesting, true);
        });

        it('should disable sample models for transformers architecture', async () => {
            await configManager.loadConfiguration();
            
            const promptAnswers = {
                deploymentConfig: 'transformers-vllm',
                includeSampleModel: true
            };
            
            const finalConfig = configManager.getFinalConfiguration(promptAnswers);
            
            assert.strictEqual(finalConfig.includeSampleModel, false);
        });

        it('should generate CodeBuild project name when buildTarget is codebuild', async () => {
            await configManager.loadConfiguration();
            
            const promptAnswers = {
                projectName: 'my-project',
                deploymentConfig: 'http-flask',
                engine: 'sklearn',
                buildTarget: 'codebuild'
            };
            
            const finalConfig = configManager.getFinalConfiguration(promptAnswers);
            
            assert.ok(typeof finalConfig.codebuildProjectName === 'string');
            assert.ok(finalConfig.codebuildProjectName.includes('my-project'));
            assert.ok(finalConfig.codebuildProjectName.includes('http'));
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
                'deployment-config': 'http-flask',
                engine: 'sklearn',
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
                'deployment-config': 'http-flask'
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
                deploymentConfig: 'http-flask',
                architecture: 'http',
                backend: 'flask',
                engine: 'sklearn',
                modelFormat: 'pkl',
                instanceType: 'ml.m5.large',
                projectName: 'test-project',
                destinationDir: '.',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference',
                includeSampleModel: false,
                includeTesting: true
            };
            
            const errors = configManager.validateRequiredParameters(finalConfig);
            
            assert.strictEqual(errors.length, 0);
        });

        it('should fail validation when required parameter is missing', async () => {
            await configManager.loadConfiguration();
            
            const finalConfig = {
                deploymentConfig: 'http-flask',
                architecture: 'http',
                backend: 'flask',
                // Missing engine, modelFormat, etc.
                instanceType: 'ml.m5.large'
            };
            
            const errors = configManager.validateRequiredParameters(finalConfig);
            
            assert.ok(errors.length > 0);
        });

        it('should not require modelFormat for transformers', async () => {
            await configManager.loadConfiguration();
            
            const finalConfig = {
                deploymentConfig: 'transformers-vllm',
                architecture: 'transformers',
                backend: 'vllm',
                // No modelFormat - should be OK for transformers
                instanceType: 'ml.g5.xlarge',
                projectName: 'test-project',
                destinationDir: '.',
                buildTarget: 'codebuild',
                deploymentTarget: 'managed-inference',
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
                'deployment-config': 'http-flask',
                engine: 'sklearn'
            });
            configManager = new ConfigManager(mockGenerator);
            configManager._loadBootstrapConfig = async () => {};
            
            await configManager.loadConfiguration();
            const explicitConfig = configManager.getExplicitConfiguration();
            
            assert.strictEqual(explicitConfig.deploymentConfig, 'http-flask');
            assert.strictEqual(explicitConfig.engine, 'sklearn');
            // Defaults should not be in explicit config
            assert.strictEqual(explicitConfig.awsRegion, undefined);
        });

        it('should include environment variables in explicit config', async () => {
            process.env.ML_INSTANCE_TYPE = 'ml.m5.xlarge';
            envVarsToCleanup.push('ML_INSTANCE_TYPE');
            
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
            
            await configManager.loadConfiguration();
            const explicitConfig = configManager.getExplicitConfiguration();
            
            assert.strictEqual(explicitConfig.instanceType, 'ml.m5.xlarge');
        });

        it('should treat ambient env vars as defaults, not explicit config', async () => {
            process.env.AWS_REGION = 'eu-west-1';
            envVarsToCleanup.push('AWS_REGION');
            
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
            configManager._loadBootstrapConfig = async () => {};
            
            await configManager.loadConfiguration();
            const explicitConfig = configManager.getExplicitConfiguration();
            
            // AWS_REGION is ambient — sets the config value but not explicit config
            assert.strictEqual(configManager.config.awsRegion, 'eu-west-1');
            assert.strictEqual(explicitConfig.awsRegion, undefined);
        });
    });

    describe('Private Methods', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
        });

        describe('_generateProjectName()', () => {
            it('should generate project name for http architecture', () => {
                const projectName = configManager._generateProjectName('http');
                
                assert.ok(typeof projectName === 'string');
                assert.ok(/^[a-z]+-[a-z]+-[a-z]+$/.test(projectName));
            });

            it('should generate project name for transformers architecture', () => {
                const projectName = configManager._generateProjectName('transformers');
                
                assert.ok(typeof projectName === 'string');
                assert.ok(/^[a-z]+-[a-z]+-[a-z]+$/.test(projectName));
            });
        });

        describe('_generateCodeBuildProjectName()', () => {
            it('should generate valid CodeBuild project name', () => {
                const buildName = configManager._generateCodeBuildProjectName('my-project', 'http');
                
                assert.ok(typeof buildName === 'string');
                assert.ok(buildName.includes('my-project'));
                assert.ok(buildName.includes('http'));
                assert.ok(/^[a-z0-9][a-z0-9\-_]+$/.test(buildName));
            });

            it('should sanitize invalid characters', () => {
                const buildName = configManager._generateCodeBuildProjectName('my@project!', 'http');
                
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
                assert.strictEqual(configManager._canAutoGenerate('modelFormat'), true);
                assert.strictEqual(configManager._canAutoGenerate('includeSampleModel'), true);
                assert.strictEqual(configManager._canAutoGenerate('instanceType'), true);
            });

            it('should return false for non-auto-generatable parameters', () => {
                assert.strictEqual(configManager._canAutoGenerate('projectName'), false);
                assert.strictEqual(configManager._canAutoGenerate('awsRoleArn'), false);
            });
        });
    });

    /**
     * DeploymentConfigResolver Integration Tests
     *
     * Validates that ConfigManager correctly uses DeploymentConfigResolver
     * to populate architecture/backend/engine and rejects old-format configs.
     *
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4
     */
    describe('DeploymentConfigResolver Integration', () => {
        let configManager;
        let mockGenerator;

        beforeEach(() => {
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
        });

        describe('getFinalConfiguration() populates architecture, backend, engine (Req 6.1)', () => {
            it('should derive architecture, backend, engine for http-flask', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'http-flask',
                    engine: 'sklearn'
                });

                assert.strictEqual(finalConfig.architecture, 'http');
                assert.strictEqual(finalConfig.backend, 'flask');
                assert.strictEqual(finalConfig.engine, 'sklearn');
            });

            it('should derive architecture, backend, engine for http-fastapi', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'http-fastapi',
                    engine: 'xgboost'
                });

                assert.strictEqual(finalConfig.architecture, 'http');
                assert.strictEqual(finalConfig.backend, 'fastapi');
                assert.strictEqual(finalConfig.engine, 'xgboost');
            });

            it('should derive architecture, backend, engine for transformers-vllm', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'transformers-vllm'
                });

                assert.strictEqual(finalConfig.architecture, 'transformers');
                assert.strictEqual(finalConfig.backend, 'vllm');
                assert.strictEqual(finalConfig.engine, null);
            });

            it('should derive architecture, backend, engine for triton-fil', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'triton-fil'
                });

                assert.strictEqual(finalConfig.architecture, 'triton');
                assert.strictEqual(finalConfig.backend, 'fil');
                assert.strictEqual(finalConfig.engine, null);
            });

            it('should derive architecture, backend, engine for triton-vllm', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'triton-vllm'
                });

                assert.strictEqual(finalConfig.architecture, 'triton');
                assert.strictEqual(finalConfig.backend, 'vllm');
                assert.strictEqual(finalConfig.engine, null);
            });

            it('should derive architecture, backend, engine for triton-tensorrtllm', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'triton-tensorrtllm'
                });

                assert.strictEqual(finalConfig.architecture, 'triton');
                assert.strictEqual(finalConfig.backend, 'tensorrtllm');
                assert.strictEqual(finalConfig.engine, null);
            });

            it('should derive architecture, backend, engine for triton-python', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'triton-python'
                });

                assert.strictEqual(finalConfig.architecture, 'triton');
                assert.strictEqual(finalConfig.backend, 'python');
                assert.strictEqual(finalConfig.engine, null);
            });
        });

        describe('framework and modelServer are no longer populated (Req 6.2)', () => {
            it('should not populate framework for http-flask config', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'http-flask',
                    engine: 'sklearn'
                });

                assert.strictEqual(finalConfig.framework, undefined);
                assert.strictEqual(finalConfig.modelServer, undefined);
            });

            it('should not populate framework for transformers-vllm config', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'transformers-vllm'
                });

                assert.strictEqual(finalConfig.framework, undefined);
                assert.strictEqual(finalConfig.modelServer, undefined);
            });

            it('should not populate framework for triton-fil config', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'triton-fil'
                });

                assert.strictEqual(finalConfig.framework, undefined);
                assert.strictEqual(finalConfig.modelServer, undefined);
            });
        });

        describe('parameter matrix includes architecture, backend, engine (Req 6.3)', () => {
            it('should include architecture in parameter matrix', () => {
                const matrix = configManager.parameterMatrix;
                assert.ok(matrix.architecture, 'architecture should be in parameter matrix');
                assert.strictEqual(matrix.architecture.valueSpace, 'bounded');
            });

            it('should include backend in parameter matrix', () => {
                const matrix = configManager.parameterMatrix;
                assert.ok(matrix.backend, 'backend should be in parameter matrix');
                assert.strictEqual(matrix.backend.valueSpace, 'bounded');
            });

            it('should include engine in parameter matrix', () => {
                const matrix = configManager.parameterMatrix;
                assert.ok(matrix.engine, 'engine should be in parameter matrix');
                assert.strictEqual(matrix.engine.cliOption, 'engine');
            });

            it('should not include framework in parameter matrix', () => {
                const matrix = configManager.parameterMatrix;
                assert.strictEqual(matrix.framework, undefined);
            });

            it('should not include modelServer in parameter matrix', () => {
                const matrix = configManager.parameterMatrix;
                assert.strictEqual(matrix.modelServer, undefined);
            });
        });

        describe('old-format values rejected with migration messages (Req 6.4)', () => {
            it('should reject sklearn-flask with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'sklearn-flask';

                const errors = configManager.validateConfiguration();

                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('sklearn-flask'));
                assert.ok(errors[0].includes('Use --deployment-config=http-flask --engine=sklearn instead'));
            });

            it('should reject sklearn-fastapi with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'sklearn-fastapi';

                const errors = configManager.validateConfiguration();

                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Use --deployment-config=http-fastapi --engine=sklearn instead'));
            });

            it('should reject xgboost-flask with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'xgboost-flask';

                const errors = configManager.validateConfiguration();

                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Use --deployment-config=http-flask --engine=xgboost instead'));
            });

            it('should reject xgboost-fastapi with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'xgboost-fastapi';

                const errors = configManager.validateConfiguration();

                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Use --deployment-config=http-fastapi --engine=xgboost instead'));
            });

            it('should reject tensorflow-flask with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'tensorflow-flask';

                const errors = configManager.validateConfiguration();

                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Use --deployment-config=http-flask --engine=tensorflow instead'));
            });

            it('should reject tensorflow-fastapi with migration message', async () => {
                await configManager.loadConfiguration();
                configManager.config.deploymentConfig = 'tensorflow-fastapi';

                const errors = configManager.validateConfiguration();

                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('Use --deployment-config=http-fastapi --engine=tensorflow instead'));
            });
        });

        describe('--engine flag parsing for http architecture (Req 6.1, 6.3)', () => {
            it('should use engine from CLI option for http-flask', async () => {
                mockGenerator = createMockGeneratorWithOptions({
                    'deployment-config': 'http-flask',
                    engine: 'sklearn'
                });
                configManager = new ConfigManager(mockGenerator);
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({});

                assert.strictEqual(finalConfig.architecture, 'http');
                assert.strictEqual(finalConfig.backend, 'flask');
                assert.strictEqual(finalConfig.engine, 'sklearn');
            });

            it('should use engine from prompt answers when not in CLI', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'http-flask',
                    engine: 'tensorflow'
                });

                assert.strictEqual(finalConfig.engine, 'tensorflow');
            });

            it('should prefer CLI engine over prompt engine', async () => {
                mockGenerator = createMockGeneratorWithOptions({
                    engine: 'sklearn'
                });
                configManager = new ConfigManager(mockGenerator);
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'http-flask',
                    engine: 'xgboost'
                });

                assert.strictEqual(finalConfig.engine, 'sklearn');
            });

            it('should not set engine for triton configs even if provided', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'triton-fil'
                });

                assert.strictEqual(finalConfig.engine, null);
            });

            it('should not set engine for transformers configs', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'transformers-vllm'
                });

                assert.strictEqual(finalConfig.engine, null);
            });
        });
    });

    describe('Diffusors Architecture Support', () => {
        beforeEach(() => {
            mockGenerator = createMockGenerator();
            configManager = new ConfigManager(mockGenerator);
        });

        describe('getFinalConfiguration() for diffusors (Req 8.1)', () => {
            it('should resolve architecture to diffusors and backend to vllm-omni', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'diffusors-vllm-omni',
                    modelName: 'stabilityai/stable-diffusion-3.5-medium'
                });

                assert.strictEqual(finalConfig.architecture, 'diffusors');
                assert.strictEqual(finalConfig.backend, 'vllm-omni');
                assert.strictEqual(finalConfig.engine, null);
            });

            it('should populate modelName from prompt answers', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'diffusors-vllm-omni',
                    modelName: 'black-forest-labs/FLUX.1-dev'
                });

                assert.strictEqual(finalConfig.modelName, 'black-forest-labs/FLUX.1-dev');
            });
        });

        describe('includeSampleModel override for diffusors (Req 8.1)', () => {
            it('should set includeSampleModel to false for diffusors architecture', async () => {
                await configManager.loadConfiguration();

                const finalConfig = configManager.getFinalConfiguration({
                    deploymentConfig: 'diffusors-vllm-omni',
                    modelName: 'stabilityai/stable-diffusion-3.5-medium',
                    includeSampleModel: true
                });

                assert.strictEqual(finalConfig.includeSampleModel, false);
            });
        });

        describe('modelName validation for diffusors with --skip-prompts (Req 8.2)', () => {
            it('should return error when modelName missing for diffusors with skip-prompts', async () => {
                mockGenerator = createMockGeneratorWithOptions({
                    'skip-prompts': true,
                    'deployment-config': 'diffusors-vllm-omni'
                });
                configManager = new ConfigManager(mockGenerator);
                await configManager.loadConfiguration();

                const errors = configManager.validateConfiguration();

                const modelNameError = errors.find(e => e.includes('Model name is required for diffusors'));
                assert.ok(modelNameError, 'Expected a validation error about missing model name for diffusors');
            });

            it('should not return modelName error when modelName is provided', async () => {
                mockGenerator = createMockGeneratorWithOptions({
                    'skip-prompts': true,
                    'deployment-config': 'diffusors-vllm-omni',
                    'model-name': 'stabilityai/stable-diffusion-3.5-medium'
                });
                configManager = new ConfigManager(mockGenerator);
                await configManager.loadConfiguration();

                const errors = configManager.validateConfiguration();

                const modelNameError = errors.find(e => e.includes('Model name is required for diffusors'));
                assert.strictEqual(modelNameError, undefined);
            });

            it('should not return modelName error for non-diffusors architectures', async () => {
                mockGenerator = createMockGeneratorWithOptions({
                    'skip-prompts': true,
                    'deployment-config': 'transformers-vllm'
                });
                configManager = new ConfigManager(mockGenerator);
                await configManager.loadConfiguration();

                const errors = configManager.validateConfiguration();

                const modelNameError = errors.find(e => e.includes('Model name is required for diffusors'));
                assert.strictEqual(modelNameError, undefined);
            });
        });

        describe('modelFormat not required for diffusors', () => {
            it('should not require modelFormat for diffusors architecture', async () => {
                await configManager.loadConfiguration();

                const finalConfig = {
                    deploymentConfig: 'diffusors-vllm-omni',
                    architecture: 'diffusors',
                    backend: 'vllm-omni',
                    modelName: 'stabilityai/stable-diffusion-3.5-medium',
                    instanceType: 'ml.g5.2xlarge',
                    projectName: 'test-diffusion',
                    destinationDir: '.',
                    buildTarget: 'codebuild',
                    deploymentTarget: 'managed-inference',
                    includeSampleModel: false,
                    includeTesting: true
                };

                const errors = configManager.validateRequiredParameters(finalConfig);

                assert.strictEqual(errors.length, 0);
            });
        });

        describe('_validateParameterCombinations for diffusors', () => {
            it('should flag includeSampleModel=true for diffusors as invalid', async () => {
                await configManager.loadConfiguration();

                const errors = configManager._validateParameterCombinations({
                    architecture: 'diffusors',
                    backend: 'vllm-omni',
                    includeSampleModel: true
                });

                assert.strictEqual(errors.length, 1);
                assert.ok(errors[0].includes('does not support sample models'));
            });

            it('should not flag includeSampleModel=false for diffusors', async () => {
                await configManager.loadConfiguration();

                const errors = configManager._validateParameterCombinations({
                    architecture: 'diffusors',
                    backend: 'vllm-omni',
                    includeSampleModel: false
                });

                assert.strictEqual(errors.length, 0);
            });
        });

        describe('_generateProjectName for diffusors', () => {
            it('should generate a valid project name for diffusors architecture', () => {
                const projectName = configManager._generateProjectName('diffusors');

                assert.ok(typeof projectName === 'string');
                assert.ok(projectName.length > 0);
            });
        });

        describe('_generateCodeBuildProjectName for diffusors', () => {
            it('should include diffusion in CodeBuild project name', () => {
                const buildName = configManager._generateCodeBuildProjectName('my-project', 'diffusors');

                assert.ok(buildName.includes('diffusion'));
                assert.ok(buildName.includes('my-project'));
            });
        });

        describe('diffusors-vllm-omni in supported options (Req 8.4)', () => {
            it('should include diffusors-vllm-omni in deployment configs', () => {
                const supportedOptions = configManager._getSupportedOptions();

                assert.ok(supportedOptions.deploymentConfigs.includes('diffusors-vllm-omni'));
            });
        });
    });
});

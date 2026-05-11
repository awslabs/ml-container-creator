// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for smart-mode gating and MCP integration point.
 *
 * Tests:
 * - ValidationContext is sufficient for external MCP tools (18.1)
 * - Smart validators don't run without --smart flag (18.4)
 * - Smart findings are labeled advisory (18.4)
 * - Static-only mode works with no smart validators configured (18.4)
 * - MCP validator configuration reading (18.3)
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.5, 15.6, 15.7
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import PayloadBuilder from '../../src/lib/payload-builder.js';
import SchemaValidationEngine from '../../src/lib/schema-validation-engine.js';
import ValidationReport from '../../src/lib/validation-report.js';
import BaseValidator from '../../src/lib/validators/base-validator.js';
import { loadSmartValidatorConfig, spawnSmartValidator } from '../../src/lib/mcp-validator-config.js';

// ── Test Validator Classes ───────────────────────────────────────────────────

class MockSmartValidator extends BaseValidator {
    constructor(findings = []) {
        super();
        this._findings = findings;
        this.wasExecuted = false;
        this.receivedContext = null;
        this.receivedOptions = null;
    }

    get name() {
        return 'mock-smart';
    }

    get mode() {
        return 'smart';
    }

    async validate(context, options) {
        this.wasExecuted = true;
        this.receivedContext = context;
        this.receivedOptions = options;
        return this._findings;
    }
}

class MockStaticValidator extends BaseValidator {
    constructor(findings = []) {
        super();
        this._findings = findings;
        this.wasExecuted = false;
    }

    get name() {
        return 'mock-static';
    }

    get mode() {
        return 'static';
    }

    async validate(_context, _options) {
        this.wasExecuted = true;
        return this._findings;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempDir() {
    const tempDir = path.join(os.tmpdir(), `mlcc-smart-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

function cleanupTempDir(tempDir) {
    if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Smart-Mode Gating', () => {

    describe('18.1 - ValidationContext sufficiency for external MCP tools', () => {

        it('ValidationContext contains all constructed payloads', () => {
            const builder = new PayloadBuilder();
            const config = {
                INSTANCE_TYPE: 'ml.g5.xlarge',
                INFERENCE_AMI_VERSION: 'al2-ami-sagemaker-inference-gpu-2',
                ENDPOINT_VARIANT_NAME: 'AllTraffic',
                ENDPOINT_INITIAL_INSTANCE_COUNT: 1,
                IC_CPU_COUNT: 4,
                IC_MEMORY_SIZE: 16384,
                IC_GPU_COUNT: 1
            };

            const context = builder.build(config, 'realtime-inference');

            assert.ok(context.payloads, 'Context should have payloads');
            assert.ok(context.payloads['sagemaker:CreateEndpointConfig'], 'Should have CreateEndpointConfig payload');
            assert.ok(context.payloads['sagemaker:CreateInferenceComponent'], 'Should have CreateInferenceComponent payload');
        });

        it('ValidationContext contains raw config values', () => {
            const builder = new PayloadBuilder();
            const config = {
                INSTANCE_TYPE: 'ml.g5.xlarge',
                ROLE_ARN: 'arn:aws:iam::123456789012:role/SageMakerRole'
            };

            const context = builder.build(config, 'realtime-inference');

            assert.ok(context.config, 'Context should have config');
            assert.strictEqual(context.config.INSTANCE_TYPE, 'ml.g5.xlarge');
            assert.strictEqual(context.config.ROLE_ARN, 'arn:aws:iam::123456789012:role/SageMakerRole');
        });

        it('ValidationContext contains deployment target', () => {
            const builder = new PayloadBuilder();
            const config = { INSTANCE_TYPE: 'ml.m5.xlarge' };

            const context = builder.build(config, 'batch-transform');

            assert.strictEqual(context.deploymentTarget, 'batch-transform');
        });

        it('ValidationContext contains service model metadata', () => {
            const builder = new PayloadBuilder();
            const config = {
                INSTANCE_TYPE: 'ml.g5.xlarge',
                IC_GPU_COUNT: 1
            };

            const context = builder.build(config, 'realtime-inference');

            assert.ok(context.metadata, 'Context should have metadata');
            assert.ok(context.metadata.generatedAt, 'Metadata should have generatedAt');
            assert.ok(context.metadata.generatorVersion, 'Metadata should have generatorVersion');
            assert.ok(Array.isArray(context.metadata.services), 'Metadata should have services array');
        });

        it('ValidationContext is JSON-serializable for stdio transport', () => {
            const builder = new PayloadBuilder();
            const config = {
                INSTANCE_TYPE: 'ml.g5.xlarge',
                INFERENCE_AMI_VERSION: 'al2-ami-sagemaker-inference-gpu-2',
                ENDPOINT_VARIANT_NAME: 'AllTraffic',
                ENDPOINT_INITIAL_INSTANCE_COUNT: 1,
                ENDPOINT_VOLUME_SIZE: 100,
                IC_CPU_COUNT: 4,
                IC_MEMORY_SIZE: 16384,
                IC_GPU_COUNT: 1,
                IC_COPY_COUNT: 1,
                ROLE_ARN: 'arn:aws:iam::123456789012:role/SageMakerRole',
                CONTAINER_IMAGE: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-model:latest',
                MODEL_DATA_URL: 's3://my-bucket/model.tar.gz'
            };

            const context = builder.build(config, 'realtime-inference');

            // JSON round-trip should produce deeply equal object
            const serialized = JSON.stringify(context);
            const deserialized = JSON.parse(serialized);

            assert.deepStrictEqual(deserialized.payloads, context.payloads);
            assert.deepStrictEqual(deserialized.config, context.config);
            assert.strictEqual(deserialized.deploymentTarget, context.deploymentTarget);
            assert.strictEqual(deserialized.metadata.generatorVersion, context.metadata.generatorVersion);
            assert.deepStrictEqual(deserialized.metadata.services, context.metadata.services);
        });

        it('ValidationContext includes async-inference payloads when target is async', () => {
            const builder = new PayloadBuilder();
            const config = {
                INSTANCE_TYPE: 'ml.g5.xlarge',
                CONTAINER_IMAGE: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-model:latest',
                MODEL_DATA_URL: 's3://my-bucket/model.tar.gz',
                ROLE_ARN: 'arn:aws:iam::123456789012:role/SageMakerRole'
            };

            const context = builder.build(config, 'async-inference');

            assert.ok(context.payloads['sagemaker:CreateModel'], 'Should have CreateModel payload for async-inference');
            assert.strictEqual(context.deploymentTarget, 'async-inference');
        });

        it('ValidationContext includes batch-transform payloads when target is batch', () => {
            const builder = new PayloadBuilder();
            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge',
                BATCH_INSTANCE_COUNT: 2,
                BATCH_SPLIT_TYPE: 'Line',
                BATCH_STRATEGY: 'MultiRecord'
            };

            const context = builder.build(config, 'batch-transform');

            assert.ok(context.payloads['sagemaker:CreateTransformJob'], 'Should have CreateTransformJob payload for batch-transform');
            assert.strictEqual(context.deploymentTarget, 'batch-transform');
        });
    });

    describe('18.2 - Smart-mode validator gating and advisory labeling', () => {

        it('smart-mode findings are labeled advisory by default', () => {
            const report = new ValidationReport();

            report.addFinding({
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InstanceType',
                severity: 'warning',
                confidence: 'medium',
                source: 'smart-mode',
                remediationHint: 'Consider using a larger instance for this model size'
            });

            assert.strictEqual(report.advisoryFindings.length, 1, 'Smart-mode finding should be advisory');
            assert.strictEqual(report.schemaErrors.length, 0, 'Should not be in schema errors');
        });

        it('smart-mode findings with confidence:definitive and severity:error are blocking', () => {
            const report = new ValidationReport();

            report.addFinding({
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InstanceType',
                invalidValue: 'ml.invalid.type',
                severity: 'error',
                confidence: 'definitive',
                source: 'smart-mode',
                remediationHint: 'This instance type does not exist'
            });

            assert.strictEqual(report.schemaErrors.length, 1, 'Definitive error from smart-mode should be blocking');
            assert.strictEqual(report.advisoryFindings.length, 0, 'Should not be advisory');
        });

        it('smart-mode findings with confidence:high and severity:error are advisory', () => {
            const report = new ValidationReport();

            report.addFinding({
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InstanceType',
                severity: 'error',
                confidence: 'high',
                source: 'smart-mode',
                remediationHint: 'This instance may not have enough memory'
            });

            assert.strictEqual(report.advisoryFindings.length, 1, 'High confidence smart-mode finding should be advisory');
            assert.strictEqual(report.schemaErrors.length, 0, 'Should not be blocking');
        });

        it('smart-mode findings with confidence:low are advisory', () => {
            const report = new ValidationReport();

            report.addFinding({
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].VolumeSizeInGB',
                severity: 'warning',
                confidence: 'low',
                source: 'smart-mode',
                remediationHint: 'Volume size might be insufficient'
            });

            assert.strictEqual(report.advisoryFindings.length, 1, 'Low confidence finding should be advisory');
            assert.strictEqual(report.schemaErrors.length, 0);
        });

        it('smart-mode findings with smart: prefix source are handled correctly', () => {
            const report = new ValidationReport();

            report.addFinding({
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InstanceType',
                severity: 'warning',
                confidence: 'medium',
                source: 'smart:bedrock-validator',
                remediationHint: 'Consider a different instance type'
            });

            assert.strictEqual(report.advisoryFindings.length, 1, 'smart: prefixed source should be advisory');
            assert.strictEqual(report.schemaErrors.length, 0);
        });

        it('system functions fully in static-only mode with no degradation', async () => {
            const engine = new SchemaValidationEngine({ smartMode: false });
            engine.validators = [];

            const staticValidator = new MockStaticValidator([{
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InferenceAmiVersion',
                invalidValue: 'invalid-value',
                constraint: { type: 'enum', values: ['valid-1', 'valid-2'] },
                severity: 'error',
                confidence: 'definitive',
                source: 'enum',
                remediationHint: 'Use a valid InferenceAmiVersion'
            }]);

            engine.registerValidator(staticValidator);

            const context = {
                payloads: { 'sagemaker:CreateEndpointConfig': {} },
                config: { INSTANCE_TYPE: 'ml.m5.xlarge' },
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: ['sagemaker'] }
            };

            const report = await engine.validate(context);

            assert.ok(staticValidator.wasExecuted, 'Static validator should execute');
            assert.strictEqual(report.schemaErrors.length, 1, 'Should have schema error from static validator');
        });
    });

    describe('18.3 - MCP validator configuration support', () => {
        let tempDir;

        beforeEach(() => {
            tempDir = createTempDir();
        });

        afterEach(() => {
            cleanupTempDir(tempDir);
        });

        it('loads smart validator configuration from mcp.json', () => {
            const mcpConfig = {
                mcpServers: {},
                smartValidators: [
                    {
                        name: 'bedrock-validator',
                        command: 'node',
                        args: ['path/to/validator.js'],
                        timeout: 15000,
                        enabled: true
                    }
                ]
            };

            const configPath = path.join(tempDir, 'mcp.json');
            writeFileSync(configPath, JSON.stringify(mcpConfig), 'utf8');

            const result = loadSmartValidatorConfig(configPath);

            assert.strictEqual(result.loaded, true);
            assert.strictEqual(result.validators.length, 1);
            assert.strictEqual(result.validators[0].name, 'bedrock-validator');
            assert.strictEqual(result.validators[0].command, 'node');
            assert.deepStrictEqual(result.validators[0].args, ['path/to/validator.js']);
            assert.strictEqual(result.validators[0].timeout, 15000);
        });

        it('filters out disabled validators', () => {
            const mcpConfig = {
                mcpServers: {},
                smartValidators: [
                    { name: 'enabled-validator', command: 'node', args: [], enabled: true },
                    { name: 'disabled-validator', command: 'node', args: [], enabled: false }
                ]
            };

            const configPath = path.join(tempDir, 'mcp.json');
            writeFileSync(configPath, JSON.stringify(mcpConfig), 'utf8');

            const result = loadSmartValidatorConfig(configPath);

            assert.strictEqual(result.validators.length, 1);
            assert.strictEqual(result.validators[0].name, 'enabled-validator');
        });

        it('returns empty validators when no smartValidators key exists', () => {
            const mcpConfig = {
                mcpServers: {
                    'region-picker': { command: 'node', args: ['index.js'] }
                }
            };

            const configPath = path.join(tempDir, 'mcp.json');
            writeFileSync(configPath, JSON.stringify(mcpConfig), 'utf8');

            const result = loadSmartValidatorConfig(configPath);

            assert.strictEqual(result.loaded, true);
            assert.strictEqual(result.validators.length, 0);
        });

        it('returns loaded:false when config file does not exist', () => {
            const result = loadSmartValidatorConfig(path.join(tempDir, 'nonexistent.json'));

            assert.strictEqual(result.loaded, false);
            assert.strictEqual(result.validators.length, 0);
        });

        it('returns loaded:false when config file is invalid JSON', () => {
            const configPath = path.join(tempDir, 'mcp.json');
            writeFileSync(configPath, 'not valid json {{{', 'utf8');

            const result = loadSmartValidatorConfig(configPath);

            assert.strictEqual(result.loaded, false);
            assert.strictEqual(result.validators.length, 0);
        });

        it('provides default values for missing validator fields', () => {
            const mcpConfig = {
                smartValidators: [
                    { name: 'minimal-validator' }
                ]
            };

            const configPath = path.join(tempDir, 'mcp.json');
            writeFileSync(configPath, JSON.stringify(mcpConfig), 'utf8');

            const result = loadSmartValidatorConfig(configPath);

            assert.strictEqual(result.validators.length, 1);
            assert.strictEqual(result.validators[0].command, 'node');
            assert.deepStrictEqual(result.validators[0].args, []);
            assert.strictEqual(result.validators[0].timeout, 15000);
        });

        it('spawnSmartValidator stub returns empty findings array', async () => {
            const validatorConfig = {
                name: 'test-validator',
                command: 'node',
                args: ['validator.js'],
                timeout: 15000
            };

            const context = {
                payloads: {},
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
            };

            const findings = await spawnSmartValidator(validatorConfig, context, { priorFindings: [] });

            assert.ok(Array.isArray(findings), 'Should return an array');
            assert.strictEqual(findings.length, 0, 'Stub should return empty findings');
        });
    });

    describe('18.4 - Smart-mode gating behavior', () => {

        it('smart validators do not run without --smart flag', async () => {
            const engine = new SchemaValidationEngine({ smartMode: false });
            engine.validators = [];

            const smartValidator = new MockSmartValidator([{
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InstanceType',
                severity: 'warning',
                confidence: 'medium',
                source: 'smart-mode',
                remediationHint: 'Consider a larger instance'
            }]);

            engine.registerValidator(smartValidator);

            const context = {
                payloads: {},
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
            };

            const report = await engine.validate(context);

            assert.strictEqual(smartValidator.wasExecuted, false, 'Smart validator should NOT execute without --smart');
            assert.strictEqual(report.advisoryFindings.length, 0, 'Should have no advisory findings');
        });

        it('smart validators run when --smart flag is enabled', async () => {
            const engine = new SchemaValidationEngine({ smartMode: true });
            engine.validators = [];

            const smartValidator = new MockSmartValidator([{
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InstanceType',
                severity: 'warning',
                confidence: 'medium',
                source: 'smart-mode',
                remediationHint: 'Consider a larger instance'
            }]);

            engine.registerValidator(smartValidator);

            const context = {
                payloads: {},
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
            };

            const report = await engine.validate(context);

            assert.strictEqual(smartValidator.wasExecuted, true, 'Smart validator should execute with --smart');
            assert.strictEqual(report.advisoryFindings.length, 1, 'Should have advisory finding from smart validator');
        });

        it('smart findings are labeled advisory in the report', async () => {
            const engine = new SchemaValidationEngine({ smartMode: true });
            engine.validators = [];

            const smartValidator = new MockSmartValidator([
                {
                    service: 'sagemaker',
                    operation: 'CreateEndpointConfig',
                    fieldPath: 'ProductionVariants[0].InstanceType',
                    severity: 'warning',
                    confidence: 'medium',
                    source: 'smart-mode',
                    remediationHint: 'Consider a larger instance'
                },
                {
                    service: 'sagemaker',
                    operation: 'CreateEndpointConfig',
                    fieldPath: 'ProductionVariants[0].VolumeSizeInGB',
                    severity: 'error',
                    confidence: 'high',
                    source: 'smart-mode',
                    remediationHint: 'Volume size may be too small'
                }
            ]);

            engine.registerValidator(smartValidator);

            const context = {
                payloads: {},
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
            };

            const report = await engine.validate(context);

            assert.strictEqual(report.advisoryFindings.length, 2, 'Both smart findings should be advisory');
            assert.strictEqual(report.schemaErrors.length, 0, 'Should not have blocking errors');
        });

        it('smart findings with confidence:definitive and severity:error are blocking', async () => {
            const engine = new SchemaValidationEngine({ smartMode: true });
            engine.validators = [];

            const smartValidator = new MockSmartValidator([{
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InstanceType',
                invalidValue: 'ml.nonexistent.type',
                severity: 'error',
                confidence: 'definitive',
                source: 'smart-mode',
                remediationHint: 'This instance type does not exist in the target region'
            }]);

            engine.registerValidator(smartValidator);

            const context = {
                payloads: {},
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
            };

            const report = await engine.validate(context);

            assert.strictEqual(report.schemaErrors.length, 1, 'Definitive error should be blocking');
            assert.strictEqual(report.advisoryFindings.length, 0, 'Should not be advisory');
        });

        it('static-only mode works with no smart validators configured', async () => {
            const engine = new SchemaValidationEngine({ smartMode: false });
            engine.validators = [];

            const staticValidator = new MockStaticValidator([{
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InferenceAmiVersion',
                invalidValue: 'bad-value',
                constraint: { type: 'enum', values: ['valid-1'] },
                severity: 'error',
                confidence: 'definitive',
                source: 'enum',
                remediationHint: 'Use a valid value'
            }]);

            engine.registerValidator(staticValidator);

            const context = {
                payloads: { 'sagemaker:CreateEndpointConfig': {} },
                config: { INFERENCE_AMI_VERSION: 'bad-value' },
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: ['sagemaker'] }
            };

            const report = await engine.validate(context);

            assert.ok(staticValidator.wasExecuted, 'Static validator should execute');
            assert.strictEqual(report.schemaErrors.length, 1, 'Should have schema error');
            const summary = report.getSummary();
            assert.strictEqual(summary.errors, 1);
            assert.strictEqual(summary.advisory, 0);
        });

        it('smart validators receive priorFindings from static validators', async () => {
            const engine = new SchemaValidationEngine({ smartMode: true });
            engine.validators = [];

            const staticFindings = [{
                service: 'sagemaker',
                operation: 'CreateEndpointConfig',
                fieldPath: 'ProductionVariants[0].InferenceAmiVersion',
                invalidValue: 'bad-value',
                constraint: { type: 'enum', values: ['valid-1'] },
                severity: 'error',
                confidence: 'definitive',
                source: 'enum',
                remediationHint: 'Use a valid value'
            }];

            const staticValidator = new MockStaticValidator(staticFindings);
            const smartValidator = new MockSmartValidator([]);

            engine.registerValidator(staticValidator);
            engine.registerValidator(smartValidator);

            const context = {
                payloads: {},
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
            };

            await engine.validate(context);

            assert.ok(smartValidator.wasExecuted, 'Smart validator should execute');
            assert.ok(smartValidator.receivedOptions.priorFindings.length >= 1,
                'Smart validator should receive prior findings from static validators');
            assert.strictEqual(
                smartValidator.receivedOptions.priorFindings[0].fieldPath,
                'ProductionVariants[0].InferenceAmiVersion'
            );
        });

        it('engine handles smart validator exceptions gracefully', async () => {
            const engine = new SchemaValidationEngine({ smartMode: true });
            engine.validators = [];

            class ThrowingSmartValidator extends BaseValidator {
                get name() { return 'throwing-smart'; }
                get mode() { return 'smart'; }
                async validate() { throw new Error('MCP connection failed'); }
            }

            engine.registerValidator(new ThrowingSmartValidator());

            const context = {
                payloads: {},
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
            };

            // Should not throw
            const report = await engine.validate(context);

            assert.ok(report.warnings.length > 0, 'Should have a warning about the failed plugin');
            assert.ok(
                report.warnings[0].remediationHint.includes('throwing-smart'),
                'Warning should mention the failing plugin name'
            );
        });

        it('multiple smart validators all receive complete priorFindings', async () => {
            const engine = new SchemaValidationEngine({ smartMode: true });
            engine.validators = [];

            const staticFindings = [
                {
                    service: 'sagemaker',
                    operation: 'CreateEndpointConfig',
                    fieldPath: 'field1',
                    severity: 'error',
                    confidence: 'definitive',
                    source: 'enum',
                    remediationHint: 'Fix field1'
                },
                {
                    service: 'sagemaker',
                    operation: 'CreateEndpointConfig',
                    fieldPath: 'field2',
                    severity: 'error',
                    confidence: 'definitive',
                    source: 'type',
                    remediationHint: 'Fix field2'
                }
            ];

            const staticValidator = new MockStaticValidator(staticFindings);
            const smartValidator1 = new MockSmartValidator([]);
            const smartValidator2 = new MockSmartValidator([]);

            engine.registerValidator(staticValidator);
            engine.registerValidator(smartValidator1);
            engine.registerValidator(smartValidator2);

            const context = {
                payloads: {},
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { generatedAt: new Date().toISOString(), generatorVersion: '0.2.5', services: [] }
            };

            await engine.validate(context);

            assert.ok(smartValidator1.wasExecuted, 'First smart validator should execute');
            assert.ok(smartValidator2.wasExecuted, 'Second smart validator should execute');
            assert.ok(smartValidator1.receivedOptions.priorFindings.length >= 2,
                'First smart validator should receive all static findings');
            assert.ok(smartValidator2.receivedOptions.priorFindings.length >= 2,
                'Second smart validator should receive all static findings');
        });
    });
});

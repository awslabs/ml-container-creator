// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for pre-deploy blocking validation behavior.
 *
 * Tests:
 * - do/validate runner exits with code 1 on errors
 * - dry-run validator blocks on errors
 * - Report includes operation name, field path, constraint, and remediation hint
 *
 * Validates: Requirements 9.1, 9.2, 9.3
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, parseDoConfig } from '../../src/lib/validate-runner.js';
import { validateDryRun } from '../../src/lib/dry-run-validator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempRegistry() {
    const tempDir = path.join(os.tmpdir(), `mlcc-val-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

function cleanupTempRegistry(tempDir) {
    if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function writeManifest(registryPath) {
    const manifest = {
        lastSynced: new Date().toISOString(),
        services: {
            sagemaker: { shapeCount: 10, enumCount: 2, version: '2017-07-24' }
        },
        source: 'https://github.com/aws/aws-sdk-js-v3/tree/main/codegen/sdk-codegen/aws-models'
    };
    writeFileSync(path.join(registryPath, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

function writeServiceModel(registryPath, serviceName, model) {
    const serviceDir = path.join(registryPath, serviceName);
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(path.join(serviceDir, 'service-2.json'), JSON.stringify(model), 'utf8');
}

function createSagemakerModelWithEnum() {
    return {
        metadata: { apiVersion: '2017-07-24' },
        operations: {
            CreateEndpointConfig: {
                input: { shape: 'CreateEndpointConfigInput' }
            }
        },
        shapes: {
            CreateEndpointConfigInput: {
                type: 'structure',
                required: ['EndpointConfigName', 'ProductionVariants'],
                members: {
                    EndpointConfigName: { shape: 'EndpointConfigName' },
                    ProductionVariants: { shape: 'ProductionVariantList' }
                }
            },
            EndpointConfigName: { type: 'string' },
            ProductionVariantList: {
                type: 'list',
                member: { shape: 'ProductionVariant' }
            },
            ProductionVariant: {
                type: 'structure',
                members: {
                    InstanceType: { shape: 'InstanceType' },
                    InferenceAmiVersion: { shape: 'InferenceAmiVersion' },
                    VariantName: { shape: 'VariantName' },
                    InitialInstanceCount: { shape: 'InitialInstanceCount' }
                }
            },
            InstanceType: { type: 'string' },
            InferenceAmiVersion: {
                type: 'string',
                enum: ['al2-ami-sagemaker-inference-gpu-2', 'al2-ami-sagemaker-inference-cpu-2']
            },
            VariantName: { type: 'string' },
            InitialInstanceCount: { type: 'integer', min: 1, max: 10 }
        }
    };
}

/**
 * Capture console output and intercept process.exit.
 */
async function captureRunOutput(fn) {
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalExit = process.exit;

    let exitCode = null;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));
    process.exit = (code) => { exitCode = code; };

    try {
        const result = await fn();
        return { result, logs, exitCode };
    } finally {
        console.log = originalLog;
        console.error = originalError;
        process.exit = originalExit;
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Validate Runner', () => {
    let tempRegistry;

    beforeEach(() => {
        tempRegistry = createTempRegistry();
    });

    afterEach(() => {
        cleanupTempRegistry(tempRegistry);
    });

    describe('parseDoConfig()', () => {
        it('parses export KEY="value" lines from config file', () => {
            const configDir = path.join(tempRegistry, 'do');
            mkdirSync(configDir, { recursive: true });
            const configPath = path.join(configDir, 'config');
            writeFileSync(configPath, [
                '#!/bin/bash',
                'export PROJECT_NAME="my-project"',
                'export INSTANCE_TYPE="ml.m5.xlarge"',
                'export DEPLOYMENT_TARGET="realtime-inference"',
                '# comment line',
                'export IC_GPU_COUNT=4'
            ].join('\n'), 'utf8');

            const config = parseDoConfig(configPath);
            assert.strictEqual(config.PROJECT_NAME, 'my-project');
            assert.strictEqual(config.INSTANCE_TYPE, 'ml.m5.xlarge');
            assert.strictEqual(config.DEPLOYMENT_TARGET, 'realtime-inference');
            assert.strictEqual(config.IC_GPU_COUNT, '4');
        });

        it('returns null when config file does not exist', () => {
            const result = parseDoConfig('/nonexistent/path/config');
            assert.strictEqual(result, null);
        });
    });

    describe('run() exit codes', () => {
        it('exits with code 1 when validation errors are found', async () => {
            writeManifest(tempRegistry);
            writeServiceModel(tempRegistry, 'sagemaker', createSagemakerModelWithEnum());

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge',
                INFERENCE_AMI_VERSION: 'invalid-ami-version',
                DEPLOYMENT_TARGET: 'realtime-inference'
            };

            const { exitCode } = await captureRunOutput(async () => {
                return run({
                    config,
                    format: 'text',
                    registryPath: tempRegistry
                });
            });

            assert.strictEqual(exitCode, 1, 'Should exit with code 1 on validation errors');
        });

        it('exits with code 0 when validation passes', async () => {
            writeManifest(tempRegistry);

            // Model with no constraints that would fail
            const model = {
                metadata: { apiVersion: '2017-07-24' },
                operations: {},
                shapes: {}
            };
            writeServiceModel(tempRegistry, 'sagemaker', model);

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge',
                DEPLOYMENT_TARGET: 'realtime-inference'
            };

            const { exitCode } = await captureRunOutput(async () => {
                return run({
                    config,
                    format: 'text',
                    registryPath: tempRegistry
                });
            });

            assert.strictEqual(exitCode, 0, 'Should exit with code 0 when validation passes');
        });

        it('exits with code 2 when registry is missing', async () => {
            const nonExistentPath = path.join(os.tmpdir(), `mlcc-nonexistent-${Date.now()}`);

            const { exitCode } = await captureRunOutput(async () => {
                return run({
                    config: { INSTANCE_TYPE: 'ml.m5.xlarge' },
                    format: 'text',
                    registryPath: nonExistentPath
                });
            });

            assert.strictEqual(exitCode, 2, 'Should exit with code 2 when registry missing');
        });
    });

    describe('report content', () => {
        it('includes operation name, field path, constraint, and remediation hint in errors', async () => {
            writeManifest(tempRegistry);
            writeServiceModel(tempRegistry, 'sagemaker', createSagemakerModelWithEnum());

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge',
                INFERENCE_AMI_VERSION: 'invalid-ami-version',
                DEPLOYMENT_TARGET: 'realtime-inference'
            };

            const { logs } = await captureRunOutput(async () => {
                return run({
                    config,
                    format: 'json',
                    registryPath: tempRegistry
                });
            });

            const output = logs.join('\n');
            const report = JSON.parse(output);

            // Check that schema errors contain required fields
            assert.ok(report.schemaErrors.length > 0, 'Should have schema errors');

            const error = report.schemaErrors[0];
            assert.ok(error.operation, 'Error should include operation name');
            assert.ok(error.fieldPath, 'Error should include field path');
            assert.ok(error.constraint || error.invalidValue, 'Error should include constraint or invalid value');
            assert.ok(error.remediationHint, 'Error should include remediation hint');
        });

        it('includes service model version date on success', async () => {
            writeManifest(tempRegistry);

            const model = {
                metadata: { apiVersion: '2017-07-24' },
                operations: {},
                shapes: {}
            };
            writeServiceModel(tempRegistry, 'sagemaker', model);

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge',
                DEPLOYMENT_TARGET: 'realtime-inference'
            };

            const { logs } = await captureRunOutput(async () => {
                return run({
                    config,
                    format: 'text',
                    registryPath: tempRegistry
                });
            });

            const output = logs.join('\n');
            assert.ok(
                output.includes('Service model version') || output.includes('Validation passed'),
                'Should include version info on success'
            );
        });
    });
});

describe('Dry-Run Validator', () => {
    let tempRegistry;

    beforeEach(() => {
        tempRegistry = createTempRegistry();
    });

    afterEach(() => {
        cleanupTempRegistry(tempRegistry);
    });

    describe('blocking behavior', () => {
        it('blocks deployment (passed=false) when schema errors are found', async () => {
            writeManifest(tempRegistry);
            writeServiceModel(tempRegistry, 'sagemaker', createSagemakerModelWithEnum());

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge',
                INFERENCE_AMI_VERSION: 'invalid-ami-version'
            };

            const result = await validateDryRun(config, 'realtime-inference', {
                registryPath: tempRegistry
            });

            assert.strictEqual(result.passed, false, 'Should block deployment on errors');
            assert.strictEqual(result.skipped, false);
            assert.ok(result.report, 'Should return a report');
        });

        it('allows deployment (passed=true) when no errors found', async () => {
            writeManifest(tempRegistry);

            const model = {
                metadata: { apiVersion: '2017-07-24' },
                operations: {},
                shapes: {}
            };
            writeServiceModel(tempRegistry, 'sagemaker', model);

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge'
            };

            const result = await validateDryRun(config, 'realtime-inference', {
                registryPath: tempRegistry
            });

            assert.strictEqual(result.passed, true, 'Should allow deployment when no errors');
            assert.strictEqual(result.skipped, false);
        });

        it('skips gracefully when registry is missing', async () => {
            const nonExistentPath = path.join(os.tmpdir(), `mlcc-nonexistent-${Date.now()}`);

            const result = await validateDryRun(
                { INSTANCE_TYPE: 'ml.m5.xlarge' },
                'realtime-inference',
                { registryPath: nonExistentPath }
            );

            assert.strictEqual(result.passed, true, 'Should pass when registry missing (graceful skip)');
            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.report, null);
        });

        it('report includes operation name, field path, and remediation hint', async () => {
            writeManifest(tempRegistry);
            writeServiceModel(tempRegistry, 'sagemaker', createSagemakerModelWithEnum());

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge',
                INFERENCE_AMI_VERSION: 'bad-value'
            };

            const result = await validateDryRun(config, 'realtime-inference', {
                registryPath: tempRegistry
            });

            assert.strictEqual(result.passed, false);
            const report = result.report;
            const allErrors = [...report.schemaErrors, ...report.crossCuttingErrors];
            assert.ok(allErrors.length > 0, 'Should have errors');

            const error = allErrors[0];
            assert.ok(error.operation, 'Finding should include operation name');
            assert.ok(error.fieldPath, 'Finding should include field path');
            assert.ok(error.remediationHint, 'Finding should include remediation hint');
        });
    });

    describe('--smart flag support', () => {
        it('passes smart option to engine without error', async () => {
            writeManifest(tempRegistry);

            const model = {
                metadata: { apiVersion: '2017-07-24' },
                operations: {},
                shapes: {}
            };
            writeServiceModel(tempRegistry, 'sagemaker', model);

            const config = { INSTANCE_TYPE: 'ml.m5.xlarge' };

            // Should not throw when smart=true and no smart validators configured
            const result = await validateDryRun(config, 'realtime-inference', {
                registryPath: tempRegistry,
                smart: true
            });

            assert.strictEqual(result.passed, true);
            assert.strictEqual(result.skipped, false);
        });
    });
});

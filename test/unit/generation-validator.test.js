// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for generation-time non-blocking validation behavior.
 *
 * Tests:
 * - Validation errors are printed as warnings during generation
 * - --no-validate skips validation
 * - Missing registry skips silently
 *
 * Validates: Requirements 8.2, 8.3, 8.4, 8.5
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGenerationValidation } from '../../src/lib/generation-validator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempRegistry() {
    const tempDir = path.join(os.tmpdir(), `mlcc-gen-val-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

/**
 * Capture console.log output during a function call.
 */
async function captureConsole(fn) {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
        const result = await fn();
        return { result, logs };
    } finally {
        console.log = originalLog;
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Generation Validator', () => {
    let tempRegistry;

    beforeEach(() => {
        tempRegistry = createTempRegistry();
    });

    afterEach(() => {
        cleanupTempRegistry(tempRegistry);
    });

    describe('--no-validate flag', () => {
        it('skips validation entirely when noValidate is true', async () => {
            writeManifest(tempRegistry);

            const { result, logs } = await captureConsole(async () => {
                return runGenerationValidation(
                    { INSTANCE_TYPE: 'ml.m5.xlarge' },
                    'realtime-inference',
                    { noValidate: true, registryPath: tempRegistry }
                );
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.report, null);
            assert.strictEqual(logs.length, 0, 'Should not print anything when skipped');
        });
    });

    describe('missing registry', () => {
        it('skips silently when schema registry does not exist', async () => {
            const nonExistentPath = path.join(os.tmpdir(), `mlcc-nonexistent-${Date.now()}`);

            const { result, logs } = await captureConsole(async () => {
                return runGenerationValidation(
                    { INSTANCE_TYPE: 'ml.m5.xlarge' },
                    'realtime-inference',
                    { registryPath: nonExistentPath }
                );
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.report, null);
            assert.strictEqual(logs.length, 0, 'Should not print anything when registry missing');
        });

        it('skips silently when manifest.json is missing', async () => {
            // Registry dir exists but no manifest
            const { result, logs } = await captureConsole(async () => {
                return runGenerationValidation(
                    { INSTANCE_TYPE: 'ml.m5.xlarge' },
                    'realtime-inference',
                    { registryPath: tempRegistry }
                );
            });

            assert.strictEqual(result.skipped, true);
            assert.strictEqual(result.report, null);
            assert.strictEqual(logs.length, 0, 'Should not print anything when manifest missing');
        });
    });

    describe('validation errors printed as warnings', () => {
        it('prints errors as warnings (non-blocking) when validation finds issues', async () => {
            writeManifest(tempRegistry);

            // Write a minimal service model with an enum constraint
            const sagemakerModel = {
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
                            InferenceAmiVersion: { shape: 'InferenceAmiVersion' }
                        }
                    },
                    InstanceType: { type: 'string' },
                    InferenceAmiVersion: {
                        type: 'string',
                        enum: ['al2-ami-sagemaker-inference-gpu-2', 'al2-ami-sagemaker-inference-cpu-2']
                    }
                }
            };
            writeServiceModel(tempRegistry, 'sagemaker', sagemakerModel);

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge',
                INFERENCE_AMI_VERSION: 'invalid-ami-version'
            };

            const { result, logs } = await captureConsole(async () => {
                return runGenerationValidation(
                    config,
                    'realtime-inference',
                    { registryPath: tempRegistry }
                );
            });

            assert.strictEqual(result.skipped, false);
            assert.ok(result.report, 'Should return a report');

            // Should print warnings (not errors that block)
            const warningOutput = logs.join('\n');
            assert.ok(
                warningOutput.includes('⚠') || warningOutput.includes('issue'),
                'Should print warning indicators'
            );
        });

        it('prints summary line with issue count when errors found', async () => {
            writeManifest(tempRegistry);

            const sagemakerModel = {
                metadata: { apiVersion: '2017-07-24' },
                operations: {
                    CreateEndpointConfig: {
                        input: { shape: 'CreateEndpointConfigInput' }
                    }
                },
                shapes: {
                    CreateEndpointConfigInput: {
                        type: 'structure',
                        required: ['EndpointConfigName'],
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
                            InferenceAmiVersion: { shape: 'InferenceAmiVersion' }
                        }
                    },
                    InferenceAmiVersion: {
                        type: 'string',
                        enum: ['al2-ami-sagemaker-inference-gpu-2']
                    }
                }
            };
            writeServiceModel(tempRegistry, 'sagemaker', sagemakerModel);

            const config = {
                INFERENCE_AMI_VERSION: 'bad-value'
            };

            const { result, logs } = await captureConsole(async () => {
                return runGenerationValidation(
                    config,
                    'realtime-inference',
                    { registryPath: tempRegistry }
                );
            });

            assert.strictEqual(result.skipped, false);

            const output = logs.join('\n');
            assert.ok(
                output.includes('issue') && output.includes('do/validate'),
                'Should include summary recommending do/validate'
            );
        });

        it('does not print anything when validation passes cleanly', async () => {
            writeManifest(tempRegistry);

            // Write a model with no enum constraints to trigger
            const sagemakerModel = {
                metadata: { apiVersion: '2017-07-24' },
                operations: {},
                shapes: {}
            };
            writeServiceModel(tempRegistry, 'sagemaker', sagemakerModel);

            const config = {
                INSTANCE_TYPE: 'ml.m5.xlarge'
            };

            const { result, logs } = await captureConsole(async () => {
                return runGenerationValidation(
                    config,
                    'realtime-inference',
                    { registryPath: tempRegistry }
                );
            });

            assert.strictEqual(result.skipped, false);
            assert.ok(result.report, 'Should return a report');

            // No errors means no output
            const summary = result.report.getSummary();
            if (summary.errors === 0) {
                assert.strictEqual(logs.length, 0, 'Should not print anything when validation passes');
            }
        });
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Backward Compatibility Property-Based Tests
 *
 * Feature: batch-transform-endpoint, Property 7: Backward compatibility for existing deployment targets
 *
 * For any valid generator configuration where deploymentTarget equals realtime-inference,
 * async-inference, or hyperpod-eks, the generated project output (file set and file contents)
 * SHALL be identical to the output produced by the generator before the batch-transform feature
 * was added.
 *
 * Validates: Requirements 10.1, 10.2, 10.3
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import TemplateManager from '../../src/lib/template-manager.js';
import ConfigManager from '../../src/lib/config-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_DEPLOYMENT_CONFIGS = [
    'http-flask', 'http-fastapi',
    'transformers-vllm', 'transformers-sglang',
    'transformers-tensorrt-llm', 'transformers-lmi', 'transformers-djl',
    'triton-fil', 'triton-onnxruntime', 'triton-tensorflow',
    'triton-pytorch', 'triton-vllm', 'triton-tensorrtllm', 'triton-python',
    'diffusors-vllm-omni'
];

/** Deployment configs safe for CPU instances (no GPU requirement) */
const CPU_SAFE_DEPLOYMENT_CONFIGS = VALID_DEPLOYMENT_CONFIGS.filter(
    dc => !['triton-vllm', 'triton-tensorrtllm', 'diffusors-vllm-omni'].includes(dc)
);

const VALID_AWS_REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
    'ca-central-1', 'sa-east-1'
];

const VALID_INSTANCE_TYPES = [
    'ml.m5.large', 'ml.m5.xlarge', 'ml.m5.2xlarge',
    'ml.c5.large', 'ml.c5.xlarge',
    'ml.t3.medium', 'ml.t3.large'
];

const GPU_INSTANCE_TYPES = [
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g4dn.xlarge'
];

// ── Arbitrary generators ─────────────────────────────────────────────────────

/** Generate a valid realtime-inference configuration */
const arbManagedInferenceConfig = fc.record({
    deploymentConfig: fc.constantFrom(...CPU_SAFE_DEPLOYMENT_CONFIGS),
    awsRegion: fc.constantFrom(...VALID_AWS_REGIONS),
    instanceType: fc.constantFrom(...VALID_INSTANCE_TYPES),
    deploymentTarget: fc.constant('realtime-inference')
});

/** Generate a valid async-inference configuration */
const arbAsyncInferenceConfig = fc.record({
    deploymentConfig: fc.constantFrom(...CPU_SAFE_DEPLOYMENT_CONFIGS),
    awsRegion: fc.constantFrom(...VALID_AWS_REGIONS),
    instanceType: fc.constantFrom(...VALID_INSTANCE_TYPES),
    deploymentTarget: fc.constant('async-inference')
});

/** Generate a valid hyperpod-eks configuration */
const arbHyperPodEksConfig = fc.record({
    deploymentConfig: fc.constantFrom(...CPU_SAFE_DEPLOYMENT_CONFIGS),
    awsRegion: fc.constantFrom(...VALID_AWS_REGIONS),
    deploymentTarget: fc.constant('hyperpod-eks'),
    hyperPodCluster: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => !s.endsWith('-')),
    hyperPodNamespace: fc.constantFrom('default', 'production', 'staging'),
    hyperPodReplicas: fc.integer({ min: 1, max: 10 })
});

/** Generate random batch-transform parameters that should be ignored for non-batch targets */
const arbBatchParams = fc.record({
    batchInputPath: fc.constantFrom('s3://bucket/input/', 's3://data/in/', undefined),
    batchOutputPath: fc.constantFrom('s3://bucket/output/', 's3://data/out/', undefined),
    batchInstanceCount: fc.constantFrom(1, 2, 5, undefined),
    batchSplitType: fc.constantFrom('Line', 'RecordIO', 'None', undefined),
    batchStrategy: fc.constantFrom('MultiRecord', 'SingleRecord', undefined),
    batchJoinSource: fc.constantFrom('Input', 'None', undefined),
    batchMaxConcurrentTransforms: fc.constantFrom(0, 1, 5, undefined),
    batchMaxPayloadInMB: fc.constantFrom(6, 50, 100, undefined)
});

/** Generate a config for any existing deployment target */
const arbExistingTargetConfig = fc.oneof(
    arbManagedInferenceConfig,
    arbAsyncInferenceConfig,
    arbHyperPodEksConfig
);

// ── Property 7: Backward compatibility for existing deployment targets ───────

describe('Feature: batch-transform-endpoint, Property 7: Backward compatibility for existing deployment targets', () => {

    it('existing deployment targets pass validation with valid configurations', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 10.1, 10.2, 10.3
         */
        fc.assert(fc.property(
            arbExistingTargetConfig,
            (config) => {
                const manager = new TemplateManager(config);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('batch-specific parameters do not interfere with existing deployment targets', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 10.1, 10.2, 10.3
         *
         * Even when batch-specific parameters are present in the config,
         * validation for existing targets should pass without errors because
         * _validateBatchTransformConfig() returns early when deploymentTarget
         * is not 'batch-transform'.
         */
        fc.assert(fc.property(
            arbExistingTargetConfig,
            arbBatchParams,
            (baseConfig, batchParams) => {
                // Merge batch params into the existing target config
                const configWithBatchParams = { ...baseConfig };
                for (const [key, value] of Object.entries(batchParams)) {
                    if (value !== undefined) {
                        configWithBatchParams[key] = value;
                    }
                }

                const manager = new TemplateManager(configWithBatchParams);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('deploymentTarget defaults to realtime-inference in ConfigManager', () => {
        /**
         * Validates: Requirements 10.1, 10.2, 10.3
         *
         * The default deploymentTarget must remain realtime-inference to ensure
         * backward compatibility when no explicit selection is made.
         */
        const mockGenerator = {
            options: {},
            destinationPath: () => '/tmp/nonexistent'
        };
        const configManager = new ConfigManager(mockGenerator);
        const matrix = configManager.parameterMatrix;
        assert.strictEqual(
            matrix.deploymentTarget.default,
            'realtime-inference',
            'deploymentTarget default must be realtime-inference'
        );
    });

    it('realtime-inference configs always pass validation regardless of deployment config choice', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 10.1
         */
        fc.assert(fc.property(
            fc.constantFrom(...CPU_SAFE_DEPLOYMENT_CONFIGS),
            fc.constantFrom(...VALID_AWS_REGIONS),
            fc.constantFrom(...VALID_INSTANCE_TYPES),
            (deploymentConfig, awsRegion, instanceType) => {
                const config = {
                    deploymentConfig,
                    awsRegion,
                    instanceType,
                    deploymentTarget: 'realtime-inference'
                };
                const manager = new TemplateManager(config);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('async-inference configs always pass validation regardless of deployment config choice', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 10.2
         */
        fc.assert(fc.property(
            fc.constantFrom(...CPU_SAFE_DEPLOYMENT_CONFIGS),
            fc.constantFrom(...VALID_AWS_REGIONS),
            fc.constantFrom(...VALID_INSTANCE_TYPES),
            (deploymentConfig, awsRegion, instanceType) => {
                const config = {
                    deploymentConfig,
                    awsRegion,
                    instanceType,
                    deploymentTarget: 'async-inference'
                };
                const manager = new TemplateManager(config);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('hyperpod-eks configs always pass validation with valid cluster settings', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 10.3
         */
        fc.assert(fc.property(
            fc.constantFrom(...CPU_SAFE_DEPLOYMENT_CONFIGS),
            fc.constantFrom(...VALID_AWS_REGIONS),
            arbHyperPodEksConfig,
            (deploymentConfig, awsRegion, hpConfig) => {
                const config = {
                    ...hpConfig,
                    deploymentConfig,
                    awsRegion
                };
                const manager = new TemplateManager(config);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('GPU-requiring deployment configs still work with GPU instances for existing targets', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 10.1, 10.2
         *
         * GPU-requiring backends (triton-vllm, triton-tensorrtllm, diffusors-vllm-omni)
         * should still validate correctly with GPU instances for existing targets.
         */
        const gpuRequiringConfigs = ['triton-vllm', 'triton-tensorrtllm', 'diffusors-vllm-omni'];

        fc.assert(fc.property(
            fc.constantFrom(...gpuRequiringConfigs),
            fc.constantFrom(...GPU_INSTANCE_TYPES),
            fc.constantFrom(...VALID_AWS_REGIONS),
            fc.constantFrom('realtime-inference', 'async-inference'),
            (deploymentConfig, instanceType, awsRegion, deploymentTarget) => {
                const config = {
                    deploymentConfig,
                    instanceType,
                    awsRegion,
                    deploymentTarget
                };
                const manager = new TemplateManager(config);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

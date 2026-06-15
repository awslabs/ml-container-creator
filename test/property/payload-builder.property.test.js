// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/* eslint-disable eqeqeq */

/**
 * Payload Builder Property-Based Tests
 *
 * Feature: schema-driven-validation, Property 9: Payload field presence mirrors config value presence
 * Feature: schema-driven-validation, Property 10: Validation context JSON round-trip
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import PayloadBuilder from '../../src/lib/payload-builder.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a nullable value — either a valid value or null/undefined.
 */
const arbNullable = (arb) => fc.oneof(
    arb,
    fc.constant(null),
    fc.constant(undefined)
);

/**
 * Generate a valid instance type string.
 */
const arbInstanceType = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge',
    'ml.g5.xlarge', 'ml.p3.2xlarge', 'ml.c5.xlarge'
);

/**
 * Generate a valid inference AMI version string.
 */
const arbInferenceAmiVersion = fc.constantFrom(
    'al2-ami-sagemaker-inference-gpu-2',
    'al2023-ami-sagemaker-inference-cpu-0',
    'al2023-ami-sagemaker-inference-gpu-1'
);

/**
 * Generate a valid variant name.
 */
const arbVariantName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,20}$/);

/**
 * Generate a positive integer for instance count / volume size.
 */
const arbPositiveInt = fc.integer({ min: 1, max: 100 });

/**
 * Generate a config object for CreateEndpointConfig with some nullable fields.
 */
const arbEndpointConfig = fc.record({
    INSTANCE_TYPE: arbNullable(arbInstanceType),
    INFERENCE_AMI_VERSION: arbNullable(arbInferenceAmiVersion),
    ENDPOINT_VARIANT_NAME: arbNullable(arbVariantName),
    ENDPOINT_INITIAL_INSTANCE_COUNT: arbNullable(arbPositiveInt),
    ENDPOINT_VOLUME_SIZE: arbNullable(arbPositiveInt)
});

/**
 * Generate a config object for CreateInferenceComponent with some nullable fields.
 */
const arbICConfig = fc.record({
    IC_CPU_COUNT: arbNullable(fc.integer({ min: 1, max: 96 })),
    IC_MEMORY_SIZE: arbNullable(fc.integer({ min: 512, max: 65536 })),
    IC_GPU_COUNT: arbNullable(fc.integer({ min: 1, max: 8 })),
    IC_COPY_COUNT: arbNullable(fc.integer({ min: 1, max: 10 }))
});

/**
 * Generate a config object for CreateModel with some nullable fields.
 */
const arbModelConfig = fc.record({
    CONTAINER_IMAGE: arbNullable(fc.stringMatching(/^[a-z0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+:[a-z0-9]+$/)),
    MODEL_DATA_URL: arbNullable(fc.stringMatching(/^s3:\/\/[a-z0-9-]+\/[a-z0-9/]+$/)),
    ROLE_ARN: arbNullable(fc.stringMatching(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9-]+$/))
});

/**
 * Generate a config object for CreateTransformJob with some nullable fields.
 */
const arbTransformConfig = fc.record({
    INSTANCE_TYPE: arbNullable(arbInstanceType),
    BATCH_INSTANCE_COUNT: arbNullable(arbPositiveInt),
    BATCH_SPLIT_TYPE: arbNullable(fc.constantFrom('Line', 'RecordIO', 'None')),
    BATCH_STRATEGY: arbNullable(fc.constantFrom('MultiRecord', 'SingleRecord'))
});

/**
 * Generate a full config object combining all sections with some nullable fields.
 */
const arbFullConfig = fc.tuple(
    arbEndpointConfig,
    arbICConfig,
    arbModelConfig,
    arbTransformConfig
).map(([endpoint, ic, model, transform]) => ({
    ...endpoint,
    ...ic,
    ...model,
    ...transform
}));

/**
 * Generate a deployment target.
 */
const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform'
);

// ── Property tests ───────────────────────────────────────────────────────────

describe('Payload Builder Property-Based Tests', () => {

    const builder = new PayloadBuilder();

    // Feature: schema-driven-validation, Property 9: Payload field presence mirrors config value presence
    describe('Property 9: Payload field presence mirrors config value presence', () => {

        /**
         * Validates: Requirements 3.5, 3.7
         */

        it('CreateEndpointConfig includes field iff config value is non-null/non-undefined', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbEndpointConfig,
                (config) => {
                    const payload = builder.buildCreateEndpointConfig(config);

                    // If all config values are null/undefined, payload should be empty
                    const allNull = [
                        config.INSTANCE_TYPE,
                        config.INFERENCE_AMI_VERSION,
                        config.ENDPOINT_VARIANT_NAME,
                        config.ENDPOINT_INITIAL_INSTANCE_COUNT,
                        config.ENDPOINT_VOLUME_SIZE
                    ].every(v => v == null);

                    if (allNull) {
                        assert.deepStrictEqual(payload, {},
                            'Payload should be empty when all config values are null/undefined');
                        return true;
                    }

                    const variant = payload.ProductionVariants[0];

                    // Check each mapping
                    const mappings = [
                        ['INSTANCE_TYPE', 'InstanceType'],
                        ['INFERENCE_AMI_VERSION', 'InferenceAmiVersion'],
                        ['ENDPOINT_VARIANT_NAME', 'VariantName'],
                        ['ENDPOINT_INITIAL_INSTANCE_COUNT', 'InitialInstanceCount'],
                        ['ENDPOINT_VOLUME_SIZE', 'VolumeSizeInGB']
                    ];

                    for (const [configKey, payloadKey] of mappings) {
                        if (config[configKey] != null) {
                            assert.ok(payloadKey in variant,
                                `Field "${payloadKey}" should be present when config "${configKey}" is non-null (value: ${config[configKey]})`);
                            assert.strictEqual(variant[payloadKey], config[configKey],
                                `Field "${payloadKey}" should equal config "${configKey}" value`);
                        } else {
                            assert.ok(!(payloadKey in variant),
                                `Field "${payloadKey}" should be absent when config "${configKey}" is null/undefined`);
                        }
                    }
                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('CreateInferenceComponent includes field iff config value is non-null/non-undefined', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbICConfig,
                (config) => {
                    const payload = builder.buildCreateInferenceComponent(config);

                    // Check compute resources
                    const computeMappings = [
                        ['IC_CPU_COUNT', 'NumberOfCpuCoresRequired'],
                        ['IC_MEMORY_SIZE', 'MinMemoryRequiredInMb'],
                        ['IC_GPU_COUNT', 'NumberOfAcceleratorDevicesRequired']
                    ];

                    const hasAnyCompute = computeMappings.some(([k]) => config[k] != null);

                    if (hasAnyCompute) {
                        assert.ok(payload.Specification,
                            'Specification should be present when any compute resource is set');
                        const resources = payload.Specification.ComputeResourceRequirements;

                        for (const [configKey, payloadKey] of computeMappings) {
                            if (config[configKey] != null) {
                                assert.ok(payloadKey in resources,
                                    `Field "${payloadKey}" should be present when config "${configKey}" is non-null`);
                                assert.strictEqual(resources[payloadKey], config[configKey],
                                    `Field "${payloadKey}" should equal config "${configKey}" value`);
                            } else {
                                assert.ok(!(payloadKey in resources),
                                    `Field "${payloadKey}" should be absent when config "${configKey}" is null/undefined`);
                            }
                        }
                    } else {
                        assert.ok(!payload.Specification,
                            'Specification should be absent when all compute resources are null/undefined');
                    }

                    // Check RuntimeConfig.CopyCount
                    if (config.IC_COPY_COUNT != null) {
                        assert.ok(payload.RuntimeConfig,
                            'RuntimeConfig should be present when IC_COPY_COUNT is non-null');
                        assert.strictEqual(payload.RuntimeConfig.CopyCount, config.IC_COPY_COUNT,
                            'CopyCount should equal IC_COPY_COUNT value');
                    } else {
                        assert.ok(!payload.RuntimeConfig,
                            'RuntimeConfig should be absent when IC_COPY_COUNT is null/undefined');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('CreateModel includes field iff config value is non-null/non-undefined', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbModelConfig,
                (config) => {
                    const payload = builder.buildCreateModel(config);

                    // Check CONTAINER_IMAGE → PrimaryContainer.Image
                    if (config.CONTAINER_IMAGE != null) {
                        assert.ok(payload.PrimaryContainer,
                            'PrimaryContainer should be present when CONTAINER_IMAGE is non-null');
                        assert.strictEqual(payload.PrimaryContainer.Image, config.CONTAINER_IMAGE,
                            'Image should equal CONTAINER_IMAGE value');

                        // Check MODEL_DATA_URL → PrimaryContainer.ModelDataUrl
                        if (config.MODEL_DATA_URL != null) {
                            assert.strictEqual(payload.PrimaryContainer.ModelDataUrl, config.MODEL_DATA_URL,
                                'ModelDataUrl should equal MODEL_DATA_URL value');
                        } else {
                            assert.ok(!('ModelDataUrl' in payload.PrimaryContainer),
                                'ModelDataUrl should be absent when MODEL_DATA_URL is null/undefined');
                        }
                    } else {
                        assert.ok(!payload.PrimaryContainer,
                            'PrimaryContainer should be absent when CONTAINER_IMAGE is null/undefined');
                    }

                    // Check ROLE_ARN → ExecutionRoleArn
                    if (config.ROLE_ARN != null) {
                        assert.strictEqual(payload.ExecutionRoleArn, config.ROLE_ARN,
                            'ExecutionRoleArn should equal ROLE_ARN value');
                    } else {
                        assert.ok(!('ExecutionRoleArn' in payload),
                            'ExecutionRoleArn should be absent when ROLE_ARN is null/undefined');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('CreateTransformJob includes field iff config value is non-null/non-undefined', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbTransformConfig,
                (config) => {
                    const payload = builder.buildCreateTransformJob(config);

                    // Check TransformResources
                    const hasInstanceType = config.INSTANCE_TYPE != null;
                    const hasBatchCount = config.BATCH_INSTANCE_COUNT != null;

                    if (hasInstanceType || hasBatchCount) {
                        assert.ok(payload.TransformResources,
                            'TransformResources should be present when instance type or count is set');

                        if (hasInstanceType) {
                            assert.strictEqual(payload.TransformResources.InstanceType, config.INSTANCE_TYPE,
                                'InstanceType should equal INSTANCE_TYPE value');
                        } else {
                            assert.ok(!('InstanceType' in payload.TransformResources),
                                'InstanceType should be absent when INSTANCE_TYPE is null/undefined');
                        }

                        if (hasBatchCount) {
                            assert.strictEqual(payload.TransformResources.InstanceCount, config.BATCH_INSTANCE_COUNT,
                                'InstanceCount should equal BATCH_INSTANCE_COUNT value');
                        } else {
                            assert.ok(!('InstanceCount' in payload.TransformResources),
                                'InstanceCount should be absent when BATCH_INSTANCE_COUNT is null/undefined');
                        }
                    } else {
                        assert.ok(!payload.TransformResources,
                            'TransformResources should be absent when both instance type and count are null/undefined');
                    }

                    // Check BATCH_SPLIT_TYPE → TransformInput.SplitType
                    if (config.BATCH_SPLIT_TYPE != null) {
                        assert.ok(payload.TransformInput,
                            'TransformInput should be present when BATCH_SPLIT_TYPE is non-null');
                        assert.strictEqual(payload.TransformInput.SplitType, config.BATCH_SPLIT_TYPE,
                            'SplitType should equal BATCH_SPLIT_TYPE value');
                    } else {
                        assert.ok(!payload.TransformInput,
                            'TransformInput should be absent when BATCH_SPLIT_TYPE is null/undefined');
                    }

                    // Check BATCH_STRATEGY → BatchStrategy
                    if (config.BATCH_STRATEGY != null) {
                        assert.strictEqual(payload.BatchStrategy, config.BATCH_STRATEGY,
                            'BatchStrategy should equal BATCH_STRATEGY value');
                    } else {
                        assert.ok(!('BatchStrategy' in payload),
                            'BatchStrategy should be absent when BATCH_STRATEGY is null/undefined');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('build() only includes operation payloads when they have content', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFullConfig, arbDeploymentTarget),
                ([config, deploymentTarget]) => {
                    const context = builder.build(config, deploymentTarget);

                    // Verify no payload entry has an empty object
                    for (const [key, payload] of Object.entries(context.payloads)) {
                        assert.ok(Object.keys(payload).length > 0,
                            `Payload for "${key}" should not be empty`);
                    }

                    // Verify CreateModel only present for async-inference
                    if (deploymentTarget !== 'async-inference') {
                        assert.ok(!('sagemaker:CreateModel' in context.payloads),
                            'CreateModel should not be present for non-async-inference targets');
                    }

                    // Verify CreateTransformJob only present for batch-transform
                    if (deploymentTarget !== 'batch-transform') {
                        assert.ok(!('sagemaker:CreateTransformJob' in context.payloads),
                            'CreateTransformJob should not be present for non-batch-transform targets');
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    // Feature: schema-driven-validation, Property 10: Validation context JSON round-trip
    describe('Property 10: Validation context JSON round-trip', () => {

        /**
         * Validates: Requirements 3.8
         */

        it('validation context survives JSON serialization round-trip', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFullConfig, arbDeploymentTarget),
                ([config, deploymentTarget]) => {
                    const context = builder.build(config, deploymentTarget);

                    // Round-trip through JSON
                    const serialized = JSON.stringify(context);
                    const deserialized = JSON.parse(serialized);

                    // Verify deep equality — context should be fully JSON-serializable
                    assert.deepStrictEqual(deserialized, context,
                        'Context should survive JSON round-trip without loss');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('validation context contains no undefined values after serialization', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFullConfig, arbDeploymentTarget),
                ([config, deploymentTarget]) => {
                    const context = builder.build(config, deploymentTarget);
                    const serialized = JSON.stringify(context);

                    // undefined values should not appear in JSON
                    assert.ok(!serialized.includes('undefined'),
                        'Serialized context should not contain "undefined" string');

                    // Verify it's valid JSON
                    const parsed = JSON.parse(serialized);
                    assert.ok(typeof parsed === 'object' && parsed !== null,
                        'Parsed context should be a non-null object');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('validation context metadata is well-formed', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFullConfig, arbDeploymentTarget),
                ([config, deploymentTarget]) => {
                    const context = builder.build(config, deploymentTarget);

                    // Verify metadata structure
                    assert.ok(context.metadata, 'Context should have metadata');
                    assert.ok(context.metadata.generatedAt, 'Metadata should have generatedAt');
                    assert.ok(context.metadata.generatorVersion, 'Metadata should have generatorVersion');
                    assert.ok(Array.isArray(context.metadata.services), 'Metadata services should be an array');

                    // Verify generatedAt is a valid ISO 8601 timestamp
                    const date = new Date(context.metadata.generatedAt);
                    assert.ok(!isNaN(date.getTime()),
                        'generatedAt should be a valid ISO 8601 timestamp');

                    // Verify services list matches payload keys
                    const expectedServices = [...new Set(
                        Object.keys(context.payloads).map(k => k.split(':')[0])
                    )];
                    assert.deepStrictEqual(
                        [...context.metadata.services].sort(),
                        expectedServices.sort(),
                        'Services list should match services in payloads'
                    );

                    // Verify deploymentTarget is preserved
                    assert.strictEqual(context.deploymentTarget, deploymentTarget,
                        'deploymentTarget should be preserved in context');

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });

        it('validation context config is a copy of input config', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.tuple(arbFullConfig, arbDeploymentTarget),
                ([config, deploymentTarget]) => {
                    const context = builder.build(config, deploymentTarget);

                    // The context.config should contain the same keys/values as input
                    // (excluding undefined values which are dropped by spread)
                    for (const [key, value] of Object.entries(config)) {
                        if (value !== undefined) {
                            assert.strictEqual(context.config[key], value,
                                `Config key "${key}" should be preserved in context`);
                        }
                    }

                    return true;
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

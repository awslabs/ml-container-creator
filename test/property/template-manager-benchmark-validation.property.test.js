// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager Benchmark Validation Property-Based Tests
 *
 * Feature: sagemaker-ai-benchmarking, Property 1: Architecture gating (only transformers/diffusors accepted)
 * Feature: sagemaker-ai-benchmarking, Property 2: Deployment target gating (hyperpod-eks rejected)
 * Feature: sagemaker-ai-benchmarking, Property 3: Numeric parameter validation (concurrency, tokens >= 1)
 * Feature: sagemaker-ai-benchmarking, Property 4: S3 path format validation
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import TemplateManager from '../../src/lib/template-manager.js';
import { NUM_RUNS } from '../helpers/property-config.js';

const PROPERTY_CONFIG = {
    numRuns: NUM_RUNS,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Deployment configs that support benchmarking (transformers + diffusors) */
const BENCHMARK_SUPPORTED_CONFIGS = [
    'transformers-vllm', 'transformers-sglang',
    'transformers-tensorrt-llm', 'transformers-lmi', 'transformers-djl',
    'diffusors-vllm-omni'
];

/** Deployment configs that do NOT support benchmarking (http + triton) */
const BENCHMARK_UNSUPPORTED_CONFIGS = [
    'http-flask', 'http-fastapi',
    'triton-fil', 'triton-onnxruntime', 'triton-tensorflow',
    'triton-pytorch', 'triton-vllm', 'triton-tensorrtllm', 'triton-python'
];

/** Deployment targets that support benchmarking */
const BENCHMARK_SUPPORTED_TARGETS = ['realtime-inference', 'async-inference', 'batch-transform'];

/** Base answers that produce a valid benchmark config */
const baseAnswers = {
    projectName: 'test-project',
    deploymentConfig: 'transformers-vllm',
    awsRegion: 'us-east-1',
    deploymentTarget: 'realtime-inference',
    instanceType: 'ml.g5.xlarge',
    includeBenchmark: true,
    benchmarkConcurrency: 10,
    benchmarkInputTokensMean: 550,
    benchmarkOutputTokensMean: 150,
    benchmarkStreaming: true
};

// ── Arbitrary generators ─────────────────────────────────────────────────────

/** Valid S3 paths starting with s3:// */
const arbValidS3Path = fc.stringMatching(/^s3:\/\/[a-z0-9][a-z0-9.-]{1,30}\/[a-z0-9/.-]{1,50}$/);

/** Non-empty strings that do NOT start with s3:// */
const arbInvalidS3Path = fc.string({ minLength: 1, maxLength: 60 })
    .filter(s => s.trim() !== '' && !s.startsWith('s3://'));

/** Valid integer >= 1 for numeric benchmark params */
const arbValidPositiveInt = fc.integer({ min: 1, max: 10000 });

/** Invalid values: integers < 1 or non-integers */
const arbInvalidPositiveInt = fc.oneof(
    fc.integer({ min: -1000, max: 0 }),
    fc.double({ min: 0.1, max: 99.9, noNaN: true }).filter(v => !Number.isInteger(v))
);

// ── Property 1: Architecture independence ────────────────────────────────────

describe('Feature: sagemaker-ai-benchmarking, Property 1: Architecture independence (all architectures accepted)', () => {

    it('includeBenchmark=true accepted for transformers/diffusors deploymentConfigs', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.1
         */
        fc.assert(fc.property(
            fc.constantFrom(...BENCHMARK_SUPPORTED_CONFIGS),
            (deploymentConfig) => {
                const answers = {
                    ...baseAnswers,
                    deploymentConfig,
                    includeBenchmark: true
                };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('includeBenchmark=true accepted for http/triton deploymentConfigs (AC-2.3 all architectures)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: AC-2.3 (benchmark enabled for ALL architectures)
         */
        fc.assert(fc.property(
            fc.constantFrom(...BENCHMARK_UNSUPPORTED_CONFIGS),
            (deploymentConfig) => {
                const answers = {
                    ...baseAnswers,
                    deploymentConfig,
                    includeBenchmark: true
                };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 2: Deployment target gating ─────────────────────────────────────

describe('Feature: sagemaker-ai-benchmarking, Property 2: Deployment target gating (hyperpod-eks rejected)', () => {

    it('includeBenchmark=true rejected when deploymentTarget=hyperpod-eks', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.6
         */
        fc.assert(fc.property(
            fc.constantFrom(...BENCHMARK_SUPPORTED_CONFIGS),
            (deploymentConfig) => {
                const answers = {
                    ...baseAnswers,
                    deploymentConfig,
                    deploymentTarget: 'hyperpod-eks',
                    includeBenchmark: true,
                    hyperPodCluster: 'my-cluster',
                    hyperPodNamespace: 'default',
                    hyperPodReplicas: 1
                };
                delete answers.instanceType;
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /Benchmarking is only supported with managed-inference, async-inference, and batch-transform deployment targets/,
                    'deploymentTarget "hyperpod-eks" with includeBenchmark=true should fail validation'
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('includeBenchmark=true accepted for non-hyperpod-eks deployment targets', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.6
         */
        fc.assert(fc.property(
            fc.constantFrom(...BENCHMARK_SUPPORTED_TARGETS),
            (deploymentTarget) => {
                const answers = {
                    ...baseAnswers,
                    deploymentTarget,
                    includeBenchmark: true
                };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 3: Numeric parameter validation ─────────────────────────────────

describe('Feature: sagemaker-ai-benchmarking, Property 3: Numeric parameter validation (concurrency, tokens >= 1)', () => {

    it('benchmarkConcurrency integers >= 1 are accepted', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.2
         */
        fc.assert(fc.property(
            arbValidPositiveInt,
            (concurrency) => {
                const answers = { ...baseAnswers, benchmarkConcurrency: concurrency };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('benchmarkConcurrency < 1 or non-integer rejected', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.2
         */
        fc.assert(fc.property(
            arbInvalidPositiveInt,
            (concurrency) => {
                const answers = { ...baseAnswers, benchmarkConcurrency: concurrency };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /benchmarkConcurrency must be an integer >= 1/,
                    `benchmarkConcurrency "${concurrency}" should fail validation`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('benchmarkInputTokensMean integers >= 1 are accepted', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.3
         */
        fc.assert(fc.property(
            arbValidPositiveInt,
            (tokens) => {
                const answers = { ...baseAnswers, benchmarkInputTokensMean: tokens };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('benchmarkInputTokensMean < 1 or non-integer rejected', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.3
         */
        fc.assert(fc.property(
            arbInvalidPositiveInt,
            (tokens) => {
                const answers = { ...baseAnswers, benchmarkInputTokensMean: tokens };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /benchmarkInputTokensMean must be an integer >= 1/,
                    `benchmarkInputTokensMean "${tokens}" should fail validation`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('benchmarkOutputTokensMean integers >= 1 are accepted', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.4
         */
        fc.assert(fc.property(
            arbValidPositiveInt,
            (tokens) => {
                const answers = { ...baseAnswers, benchmarkOutputTokensMean: tokens };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('benchmarkOutputTokensMean < 1 or non-integer rejected', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.4
         */
        fc.assert(fc.property(
            arbInvalidPositiveInt,
            (tokens) => {
                const answers = { ...baseAnswers, benchmarkOutputTokensMean: tokens };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /benchmarkOutputTokensMean must be an integer >= 1/,
                    `benchmarkOutputTokensMean "${tokens}" should fail validation`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 4: S3 path format validation ────────────────────────────────────

describe('Feature: sagemaker-ai-benchmarking, Property 4: S3 path format validation', () => {

    it('benchmarkS3OutputPath starting with s3:// is accepted', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.5
         */
        fc.assert(fc.property(
            arbValidS3Path,
            (s3Path) => {
                const answers = { ...baseAnswers, benchmarkS3OutputPath: s3Path };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('non-empty benchmarkS3OutputPath NOT starting with s3:// is rejected', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.5
         */
        fc.assert(fc.property(
            arbInvalidS3Path,
            (s3Path) => {
                const answers = { ...baseAnswers, benchmarkS3OutputPath: s3Path };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /benchmarkS3OutputPath must start with "s3:\/\/"/,
                    `benchmarkS3OutputPath "${s3Path}" should fail validation`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('empty or null benchmarkS3OutputPath is accepted (uses default)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 9.5
         */
        fc.assert(fc.property(
            fc.constantFrom(null, undefined, '', '   '),
            (s3Path) => {
                const answers = { ...baseAnswers };
                if (s3Path !== undefined) {
                    answers.benchmarkS3OutputPath = s3Path;
                }
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

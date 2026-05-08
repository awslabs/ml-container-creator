// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager Batch Transform Validation Property-Based Tests
 *
 * Feature: batch-transform-endpoint, Property 1: Deployment target validation accepts exactly the supported set
 * Feature: batch-transform-endpoint, Property 2: S3 path validation
 * Feature: batch-transform-endpoint, Property 3: Batch instance count validation
 * Feature: batch-transform-endpoint, Property 4: Bounded enum parameter validation
 * Feature: batch-transform-endpoint, Property 5: Max concurrent transforms validation
 * Feature: batch-transform-endpoint, Property 6: Max payload in MB validation
 *
 * Validates: Requirements 1.2, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import TemplateManager from '../src/lib/template-manager.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: 100,
    timeout: 30000,
    verbose: false
};

// ── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_DEPLOYMENT_TARGETS = ['realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks'];

const VALID_SPLIT_TYPES = ['Line', 'RecordIO', 'None'];
const VALID_BATCH_STRATEGIES = ['MultiRecord', 'SingleRecord'];
const VALID_JOIN_SOURCES = ['Input', 'None'];

/** Base answers that produce a valid batch-transform config */
const baseAnswers = {
    projectName: 'test-project',
    deploymentConfig: 'http-flask',
    awsRegion: 'us-east-1',
    deploymentTarget: 'batch-transform',
    instanceType: 'ml.m5.large'
};

// ── Arbitrary generators ─────────────────────────────────────────────────────

/** Valid S3 paths starting with s3:// */
const arbValidS3Path = fc.stringMatching(/^s3:\/\/[a-z0-9][a-z0-9.-]{1,30}\/[a-z0-9/.-]{1,50}$/);

/** Non-empty strings that do NOT start with s3:// */
const arbInvalidS3Path = fc.string({ minLength: 1, maxLength: 60 })
    .filter(s => s.trim() !== '' && !s.startsWith('s3://'));

/** Valid instance count (integer >= 1) */
const arbValidInstanceCount = fc.integer({ min: 1, max: 10000 });

/** Invalid instance count (integer < 1 or non-integer) */
const arbInvalidInstanceCount = fc.oneof(
    fc.integer({ min: -1000, max: 0 }),
    fc.double({ min: 0.1, max: 99.9, noNaN: true }).filter(v => !Number.isInteger(v))
);

/** Valid max concurrent transforms (integer >= 0) */
const arbValidMaxConcurrent = fc.integer({ min: 0, max: 10000 });

/** Invalid max concurrent transforms (integer < 0 or non-integer) */
const arbInvalidMaxConcurrent = fc.oneof(
    fc.integer({ min: -1000, max: -1 }),
    fc.double({ min: 0.1, max: 99.9, noNaN: true }).filter(v => !Number.isInteger(v))
);

/** Valid max payload in MB (integer 0-100) */
const arbValidMaxPayload = fc.integer({ min: 0, max: 100 });

/** Invalid max payload in MB (outside 0-100 or non-integer) */
const arbInvalidMaxPayload = fc.oneof(
    fc.integer({ min: -1000, max: -1 }),
    fc.integer({ min: 101, max: 10000 }),
    fc.double({ min: 0.1, max: 99.9, noNaN: true }).filter(v => !Number.isInteger(v))
);

// ── Property 1: Deployment target validation ─────────────────────────────────

describe('Feature: batch-transform-endpoint, Property 1: Deployment target validation accepts exactly the supported set', () => {

    it('valid deployment targets always pass validation', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 1.2
         */
        fc.assert(fc.property(
            fc.constantFrom(...SUPPORTED_DEPLOYMENT_TARGETS),
            (deploymentTarget) => {
                const answers = {
                    deploymentConfig: 'http-flask',
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.m5.large',
                    deploymentTarget
                };

                // Add required fields per target
                if (deploymentTarget === 'hyperpod-eks') {
                    answers.hyperPodCluster = 'my-cluster';
                    answers.hyperPodNamespace = 'default';
                    answers.hyperPodReplicas = 1;
                    delete answers.instanceType;
                }

                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('invalid deployment targets always fail validation', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 1.2
         */
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 40 })
                .filter(s => !SUPPORTED_DEPLOYMENT_TARGETS.includes(s)),
            (deploymentTarget) => {
                const answers = {
                    deploymentConfig: 'http-flask',
                    awsRegion: 'us-east-1',
                    instanceType: 'ml.m5.large',
                    deploymentTarget
                };

                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /not implemented yet for deploymentTarget/,
                    `deploymentTarget "${deploymentTarget}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

// ── Property 2: S3 path validation ───────────────────────────────────────────

describe('Feature: batch-transform-endpoint, Property 2: S3 path validation', () => {

    it('S3 input paths starting with s3:// are accepted', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.1
         */
        fc.assert(fc.property(
            arbValidS3Path,
            (s3Path) => {
                const answers = { ...baseAnswers, batchInputPath: s3Path };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('S3 output paths starting with s3:// are accepted', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.2
         */
        fc.assert(fc.property(
            arbValidS3Path,
            (s3Path) => {
                const answers = { ...baseAnswers, batchOutputPath: s3Path };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('non-empty S3 input paths NOT starting with s3:// are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.1
         */
        fc.assert(fc.property(
            arbInvalidS3Path,
            (s3Path) => {
                const answers = { ...baseAnswers, batchInputPath: s3Path };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /batchInputPath must start with "s3:\/\/"/,
                    `batchInputPath "${s3Path}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('non-empty S3 output paths NOT starting with s3:// are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.2
         */
        fc.assert(fc.property(
            arbInvalidS3Path,
            (s3Path) => {
                const answers = { ...baseAnswers, batchOutputPath: s3Path };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /batchOutputPath must start with "s3:\/\/"/,
                    `batchOutputPath "${s3Path}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('empty or null S3 paths are accepted (validation skipped)', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.1, 8.2
         */
        fc.assert(fc.property(
            fc.constantFrom(null, undefined, '', '   '),
            fc.constantFrom(null, undefined, '', '   '),
            (inputPath, outputPath) => {
                const answers = { ...baseAnswers };
                if (inputPath !== undefined) {
                    answers.batchInputPath = inputPath;
                }
                if (outputPath !== undefined) {
                    answers.batchOutputPath = outputPath;
                }
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

// ── Property 3: Batch instance count validation ──────────────────────────────

describe('Feature: batch-transform-endpoint, Property 3: Batch instance count validation', () => {

    it('integers >= 1 are accepted', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.3
         */
        fc.assert(fc.property(
            arbValidInstanceCount,
            (instanceCount) => {
                const answers = { ...baseAnswers, batchInstanceCount: instanceCount };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('integers < 1 and non-integers are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.3
         */
        fc.assert(fc.property(
            arbInvalidInstanceCount,
            (instanceCount) => {
                const answers = { ...baseAnswers, batchInstanceCount: instanceCount };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /batchInstanceCount must be an integer >= 1/,
                    `batchInstanceCount "${instanceCount}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('undefined batchInstanceCount is accepted (uses default)', () => {
        /**
         * Validates: Requirements 8.3
         */
        const answers = { ...baseAnswers };
        const manager = new TemplateManager(answers);
        manager.validate();
    });
});

// ── Property 4: Bounded enum parameter validation ────────────────────────────

describe('Feature: batch-transform-endpoint, Property 4: Bounded enum parameter validation', () => {

    // ── batchSplitType ───────────────────────────────────────────────────────

    it('valid batchSplitType values are accepted', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.4
         */
        fc.assert(fc.property(
            fc.constantFrom(...VALID_SPLIT_TYPES),
            (splitType) => {
                const answers = { ...baseAnswers, batchSplitType: splitType };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('invalid batchSplitType values are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.4
         */
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 40 })
                .filter(s => !VALID_SPLIT_TYPES.includes(s)),
            (splitType) => {
                const answers = { ...baseAnswers, batchSplitType: splitType };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /batchSplitType must be one of/,
                    `batchSplitType "${splitType}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    // ── batchStrategy ────────────────────────────────────────────────────────

    it('valid batchStrategy values are accepted', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.5
         */
        fc.assert(fc.property(
            fc.constantFrom(...VALID_BATCH_STRATEGIES),
            (strategy) => {
                const answers = { ...baseAnswers, batchStrategy: strategy };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('invalid batchStrategy values are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.5
         */
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 40 })
                .filter(s => !VALID_BATCH_STRATEGIES.includes(s)),
            (strategy) => {
                const answers = { ...baseAnswers, batchStrategy: strategy };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /batchStrategy must be one of/,
                    `batchStrategy "${strategy}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    // ── batchJoinSource ──────────────────────────────────────────────────────

    it('valid batchJoinSource values are accepted', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.6
         */
        fc.assert(fc.property(
            fc.constantFrom(...VALID_JOIN_SOURCES),
            (joinSource) => {
                const answers = { ...baseAnswers, batchJoinSource: joinSource };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('invalid batchJoinSource values are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.6
         */
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 40 })
                .filter(s => !VALID_JOIN_SOURCES.includes(s)),
            (joinSource) => {
                const answers = { ...baseAnswers, batchJoinSource: joinSource };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /batchJoinSource must be one of/,
                    `batchJoinSource "${joinSource}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });
});

// ── Property 5: Max concurrent transforms validation ─────────────────────────

describe('Feature: batch-transform-endpoint, Property 5: Max concurrent transforms validation', () => {

    it('integers >= 0 are accepted', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.7
         */
        fc.assert(fc.property(
            arbValidMaxConcurrent,
            (maxConcurrent) => {
                const answers = { ...baseAnswers, batchMaxConcurrentTransforms: maxConcurrent };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('integers < 0 and non-integers are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.7
         */
        fc.assert(fc.property(
            arbInvalidMaxConcurrent,
            (maxConcurrent) => {
                const answers = { ...baseAnswers, batchMaxConcurrentTransforms: maxConcurrent };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /batchMaxConcurrentTransforms must be an integer >= 0/,
                    `batchMaxConcurrentTransforms "${maxConcurrent}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('undefined batchMaxConcurrentTransforms is accepted (uses default)', () => {
        /**
         * Validates: Requirements 8.7
         */
        const answers = { ...baseAnswers };
        const manager = new TemplateManager(answers);
        manager.validate();
    });
});

// ── Property 6: Max payload in MB validation ─────────────────────────────────

describe('Feature: batch-transform-endpoint, Property 6: Max payload in MB validation', () => {

    it('integers between 0 and 100 inclusive are accepted', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.8
         */
        fc.assert(fc.property(
            arbValidMaxPayload,
            (maxPayload) => {
                const answers = { ...baseAnswers, batchMaxPayloadInMB: maxPayload };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('integers outside 0-100 and non-integers are rejected', function () {
        this.timeout(FAST_PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.8
         */
        fc.assert(fc.property(
            arbInvalidMaxPayload,
            (maxPayload) => {
                const answers = { ...baseAnswers, batchMaxPayloadInMB: maxPayload };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /batchMaxPayloadInMB must be an integer between 0 and 100/,
                    `batchMaxPayloadInMB "${maxPayload}" should fail validation`
                );
                return true;
            }
        ), { numRuns: FAST_PROPERTY_CONFIG.numRuns, verbose: FAST_PROPERTY_CONFIG.verbose });
    });

    it('undefined batchMaxPayloadInMB is accepted (uses default)', () => {
        /**
         * Validates: Requirements 8.8
         */
        const answers = { ...baseAnswers };
        const manager = new TemplateManager(answers);
        manager.validate();
    });
});

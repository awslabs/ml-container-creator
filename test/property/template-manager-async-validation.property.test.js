// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager Async Inference Validation Property-Based Tests
 *
 * Feature: async-inference-endpoint, Property 1: Deployment target validation accepts exactly the supported set
 * Feature: async-inference-endpoint, Property 2: S3 output path validation
 * Feature: async-inference-endpoint, Property 3: SNS topic ARN validation
 * Feature: async-inference-endpoint, Property 4: Max concurrent invocations validation
 *
 * Validates: Requirements 1.2, 8.1, 8.2, 8.3, 8.4, 8.5
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import TemplateManager from '../../src/lib/template-manager.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_DEPLOYMENT_TARGETS = ['realtime-inference', 'async-inference', 'hyperpod-eks'];

/** Base answers that produce a valid async-inference config */
const baseAsyncAnswers = {
    deploymentConfig: 'http-flask',
    awsRegion: 'us-east-1',
    deploymentTarget: 'async-inference'
};

/** Base answers for realtime-inference (used in Property 1) */
const baseManagedAnswers = {
    deploymentConfig: 'http-flask',
    awsRegion: 'us-east-1',
    instanceType: 'ml.m5.large'
};

// ── Arbitrary generators ─────────────────────────────────────────────────────

/** Valid S3 paths starting with s3:// */
const arbValidS3Path = fc.stringMatching(/^s3:\/\/[a-z0-9][a-z0-9.-]{1,30}\/[a-z0-9/.-]{1,50}$/);

/** Non-empty strings that do NOT start with s3:// */
const arbInvalidS3Path = fc.string({ minLength: 1, maxLength: 60 })
    .filter(s => s.trim() !== '' && !s.startsWith('s3://'));

/** Valid SNS ARN: arn:aws:sns:<region>:<12-digit-account>:<topic-name> */
const arbValidSnsArn = fc.tuple(
    fc.stringMatching(/^[a-z]{2}-[a-z]+-[0-9]$/),
    fc.stringMatching(/^[0-9]{12}$/),
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,30}$/)
).map(([region, account, topic]) => `arn:aws:sns:${region}:${account}:${topic}`);

/** Non-empty strings that do NOT match the SNS ARN pattern */
const arbInvalidSnsArn = fc.oneof(
    // Missing arn: prefix
    fc.constant('not-an-arn'),
    // Wrong service
    fc.constant('arn:aws:sqs:us-east-1:123456789012:my-topic'),
    // Missing account id
    fc.constant('arn:aws:sns:us-east-1::my-topic'),
    // Short account id
    fc.constant('arn:aws:sns:us-east-1:12345:my-topic'),
    // No topic name
    fc.constant('arn:aws:sns:us-east-1:123456789012:'),
    // Random non-empty strings
    fc.string({ minLength: 1, maxLength: 40 })
        .filter(s => s.trim() !== '' && !/^arn:aws:sns:[a-z0-9-]+:\d{12}:.+$/.test(s))
);

/** Valid max concurrent invocations (integer >= 1) */
const arbValidMaxConcurrent = fc.integer({ min: 1, max: 10000 });

/** Invalid max concurrent invocations */
const arbInvalidMaxConcurrent = fc.oneof(
    fc.integer({ min: -1000, max: 0 }),
    fc.double({ min: 0.1, max: 99.9, noNaN: true }).filter(v => !Number.isInteger(v))
);

// ── Property 1: Deployment target validation ─────────────────────────────────

describe('Feature: async-inference-endpoint, Property 1: Deployment target validation accepts exactly the supported set', () => {

    it('valid deployment targets always pass validation', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 1.2
         */
        fc.assert(fc.property(
            fc.constantFrom(...SUPPORTED_DEPLOYMENT_TARGETS),
            (deploymentTarget) => {
                const answers = { ...baseManagedAnswers, deploymentTarget };

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
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('invalid deployment targets always fail validation', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 1.2
         */
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 40 })
                .filter(s => !SUPPORTED_DEPLOYMENT_TARGETS.includes(s)),
            (deploymentTarget) => {
                const answers = { ...baseManagedAnswers, deploymentTarget };

                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /not implemented yet for deploymentTarget/,
                    `deploymentTarget "${deploymentTarget}" should fail validation`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 2: S3 output path validation ────────────────────────────────────

describe('Feature: async-inference-endpoint, Property 2: S3 output path validation', () => {

    it('S3 paths starting with s3:// are accepted', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.1
         */
        fc.assert(fc.property(
            arbValidS3Path,
            (s3Path) => {
                const answers = { ...baseAsyncAnswers, asyncS3OutputPath: s3Path };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('non-empty S3 paths NOT starting with s3:// are rejected', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.1
         */
        fc.assert(fc.property(
            arbInvalidS3Path,
            (s3Path) => {
                const answers = { ...baseAsyncAnswers, asyncS3OutputPath: s3Path };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /asyncS3OutputPath must start with "s3:\/\/"/,
                    `S3 path "${s3Path}" should fail validation`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('empty or null asyncS3OutputPath is accepted', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.2
         */
        fc.assert(fc.property(
            fc.constantFrom(null, undefined, '', '   '),
            (s3Path) => {
                const answers = { ...baseAsyncAnswers };
                if (s3Path !== undefined) {
                    answers.asyncS3OutputPath = s3Path;
                }
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 3: SNS topic ARN validation ─────────────────────────────────────

describe('Feature: async-inference-endpoint, Property 3: SNS topic ARN validation', () => {

    it('valid SNS ARNs are accepted for success topic', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.3
         */
        fc.assert(fc.property(
            arbValidSnsArn,
            (arn) => {
                const answers = { ...baseAsyncAnswers, asyncSnsSuccessTopic: arn };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('valid SNS ARNs are accepted for error topic', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.4
         */
        fc.assert(fc.property(
            arbValidSnsArn,
            (arn) => {
                const answers = { ...baseAsyncAnswers, asyncSnsErrorTopic: arn };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('invalid SNS ARNs are rejected for success topic', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.3
         */
        fc.assert(fc.property(
            arbInvalidSnsArn,
            (arn) => {
                const answers = { ...baseAsyncAnswers, asyncSnsSuccessTopic: arn };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /asyncSnsSuccessTopic must be a valid SNS ARN/,
                    `SNS ARN "${arn}" should fail validation for success topic`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('invalid SNS ARNs are rejected for error topic', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.4
         */
        fc.assert(fc.property(
            arbInvalidSnsArn,
            (arn) => {
                const answers = { ...baseAsyncAnswers, asyncSnsErrorTopic: arn };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /asyncSnsErrorTopic must be a valid SNS ARN/,
                    `SNS ARN "${arn}" should fail validation for error topic`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('empty or null SNS topic ARNs are accepted', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.3, 8.4
         */
        fc.assert(fc.property(
            fc.constantFrom(null, undefined, '', '   '),
            fc.constantFrom(null, undefined, '', '   '),
            (successTopic, errorTopic) => {
                const answers = { ...baseAsyncAnswers };
                if (successTopic !== undefined) {
                    answers.asyncSnsSuccessTopic = successTopic;
                }
                if (errorTopic !== undefined) {
                    answers.asyncSnsErrorTopic = errorTopic;
                }
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

// ── Property 4: Max concurrent invocations validation ────────────────────────

describe('Feature: async-inference-endpoint, Property 4: Max concurrent invocations validation', () => {

    it('integers >= 1 are accepted', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.5
         */
        fc.assert(fc.property(
            arbValidMaxConcurrent,
            (maxConcurrent) => {
                const answers = { ...baseAsyncAnswers, asyncMaxConcurrentInvocations: maxConcurrent };
                const manager = new TemplateManager(answers);
                manager.validate();
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('integers < 1 and non-integers are rejected', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.5
         */
        fc.assert(fc.property(
            arbInvalidMaxConcurrent,
            (maxConcurrent) => {
                const answers = { ...baseAsyncAnswers, asyncMaxConcurrentInvocations: maxConcurrent };
                const manager = new TemplateManager(answers);
                assert.throws(
                    () => manager.validate(),
                    /asyncMaxConcurrentInvocations must be an integer >= 1/,
                    `maxConcurrentInvocations "${maxConcurrent}" should fail validation`
                );
                return true;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('undefined asyncMaxConcurrentInvocations is accepted (uses default)', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        /**
         * Validates: Requirements 8.5
         */
        const answers = { ...baseAsyncAnswers };
        // asyncMaxConcurrentInvocations not set
        const manager = new TemplateManager(answers);
        manager.validate();
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Feedback Loop Property-Based Tests
 *
 * Property 10: Feedback loop output matches artifact type
 *
 * For any completed job with an output path and output type, the feedback function
 * SHALL: (a) include the S3 artifacts path in its output, (b) if output_type is
 * "adapter", suggest `do/adapter add` with the artifact path, (c) if output_type is
 * "full-model", suggest `do/add-ic` or `do/deploy --force-ic` with the artifact path,
 * and (d) if a model package ARN is provided, include it in the output.
 *
 * Feature: fine-tuning-training, Property 10: Feedback loop output matches artifact type
 * Validates: Requirements 6.1–6.5
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';

import { generateCompletionFeedback } from '../../src/lib/train-feedback.js';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, verbose: false };

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid S3 output path.
 */
const s3BucketArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,20}$/);
const s3KeyArb = fc.stringMatching(/^[a-z0-9][a-z0-9/_-]{2,30}$/);

const outputPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/output/${key}/`);

/**
 * Generate a valid output type.
 */
const outputTypeArb = fc.constantFrom('adapter', 'full-model');

/**
 * Generate a valid job name.
 */
const jobNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{5,30}-train-[0-9]{10,14}$/);

/**
 * Generate an optional model package ARN (sometimes present, sometimes empty).
 */
const accountIdArb = fc.stringMatching(/^[0-9]{12}$/);
const regionArb = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);
const packageNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);

const modelPackageArnArb = fc.oneof(
    // Empty string (no ARN)
    fc.constant(''),
    // Valid model package ARN
    fc.tuple(accountIdArb, regionArb, packageNameArb)
        .map(([account, region, name]) =>
            `arn:aws:sagemaker:${region}:${account}:model-package/${name}`
        )
);

// ── Property 10: Feedback loop output matches artifact type ──────────────────

describe('Feature: fine-tuning-training, Property 10: Feedback loop output matches artifact type', () => {

    it('(a) output always includes the S3 artifacts path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            outputPathArb,
            outputTypeArb,
            jobNameArb,
            modelPackageArnArb,
            (outputPath, outputType, jobName, modelPackageArn) => {
                const output = generateCompletionFeedback({
                    outputPath,
                    outputType,
                    jobName,
                    modelPackageArn
                });

                assert.ok(
                    output.includes(outputPath),
                    `Output must include the S3 artifacts path "${outputPath}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('(b) when type is "adapter", output suggests do/adapter add with the path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            outputPathArb,
            jobNameArb,
            modelPackageArnArb,
            (outputPath, jobName, modelPackageArn) => {
                const output = generateCompletionFeedback({
                    outputPath,
                    outputType: 'adapter',
                    jobName,
                    modelPackageArn
                });

                assert.ok(
                    output.includes('do/adapter add'),
                    'Output must suggest "do/adapter add" for adapter type'
                );
                assert.ok(
                    output.includes(`--weights ${outputPath}`),
                    `Output must include "--weights ${outputPath}" for adapter type`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('(c) when type is "full-model", output suggests do/add-ic or do/deploy --force-ic with the path', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            outputPathArb,
            jobNameArb,
            modelPackageArnArb,
            (outputPath, jobName, modelPackageArn) => {
                const output = generateCompletionFeedback({
                    outputPath,
                    outputType: 'full-model',
                    jobName,
                    modelPackageArn
                });

                assert.ok(
                    output.includes('do/add-ic'),
                    'Output must suggest "do/add-ic" for full-model type'
                );
                assert.ok(
                    output.includes('do/deploy --force-ic'),
                    'Output must suggest "do/deploy --force-ic" for full-model type'
                );
                assert.ok(
                    output.includes(`--model-data ${outputPath}`),
                    `Output must include "--model-data ${outputPath}" for full-model type`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('(d) when model package ARN is provided, output includes it', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        // Only generate non-empty ARNs for this test
        const nonEmptyArnArb = fc.tuple(accountIdArb, regionArb, packageNameArb)
            .map(([account, region, name]) =>
                `arn:aws:sagemaker:${region}:${account}:model-package/${name}`
            );

        fc.assert(fc.property(
            outputPathArb,
            outputTypeArb,
            jobNameArb,
            nonEmptyArnArb,
            (outputPath, outputType, jobName, modelPackageArn) => {
                const output = generateCompletionFeedback({
                    outputPath,
                    outputType,
                    jobName,
                    modelPackageArn
                });

                assert.ok(
                    output.includes(modelPackageArn),
                    `Output must include the model package ARN "${modelPackageArn}"`
                );
                assert.ok(
                    output.includes('Model Package'),
                    'Output must include "Model Package" label when ARN is provided'
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('(d) when model package ARN is empty, output does NOT include "Model Package" text', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            outputPathArb,
            outputTypeArb,
            jobNameArb,
            (outputPath, outputType, jobName) => {
                const output = generateCompletionFeedback({
                    outputPath,
                    outputType,
                    jobName,
                    modelPackageArn: ''
                });

                assert.ok(
                    !output.includes('Model Package'),
                    'Output must NOT include "Model Package" text when ARN is empty'
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('adapter type does NOT suggest full-model commands', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            outputPathArb,
            jobNameArb,
            modelPackageArnArb,
            (outputPath, jobName, modelPackageArn) => {
                const output = generateCompletionFeedback({
                    outputPath,
                    outputType: 'adapter',
                    jobName,
                    modelPackageArn
                });

                assert.ok(
                    !output.includes('do/add-ic'),
                    'Adapter output must NOT suggest "do/add-ic"'
                );
                assert.ok(
                    !output.includes('do/deploy --force-ic'),
                    'Adapter output must NOT suggest "do/deploy --force-ic"'
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('full-model type does NOT suggest adapter commands', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            outputPathArb,
            jobNameArb,
            modelPackageArnArb,
            (outputPath, jobName, modelPackageArn) => {
                const output = generateCompletionFeedback({
                    outputPath,
                    outputType: 'full-model',
                    jobName,
                    modelPackageArn
                });

                assert.ok(
                    !output.includes('do/adapter add'),
                    'Full-model output must NOT suggest "do/adapter add"'
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('output always includes the job name', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            outputPathArb,
            outputTypeArb,
            jobNameArb,
            modelPackageArnArb,
            (outputPath, outputType, jobName, modelPackageArn) => {
                const output = generateCompletionFeedback({
                    outputPath,
                    outputType,
                    jobName,
                    modelPackageArn
                });

                assert.ok(
                    output.includes(jobName),
                    `Output must include the job name "${jobName}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

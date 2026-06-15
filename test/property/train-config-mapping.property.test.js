// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Config-to-API Mapping Property-Based Tests
 *
 * Property 7: Training config maps correctly to CreateTrainingJob request
 *
 * For any valid config.yaml containing image, script, instance_type, instance_count,
 * dataset, output_path, and hyperparameters, the constructed CreateTrainingJob JSON
 * SHALL map: image → AlgorithmSpecification.TrainingImage, instance_type →
 * ResourceConfig.InstanceType, instance_count → ResourceConfig.InstanceCount,
 * dataset → InputDataConfig[0].DataSource.S3DataSource.S3Uri, output_path →
 * OutputDataConfig.S3OutputPath, and each hyperparameter key-value → HyperParameters.
 *
 * Feature: fine-tuning-training, Property 7: Training config maps correctly to CreateTrainingJob request
 * Validates: Requirements 3.2, 3.5, 3.7
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'node:assert';

import { buildTrainingJobRequest } from '../../src/lib/train-request-builder.js';
import { PROPERTY_CONFIG } from '../helpers/property-config.js';

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid ECR image URI.
 */
const accountIdArb = fc.stringMatching(/^[0-9]{12}$/);
const regionArb = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);
const repoNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);
const tagArb = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,10}$/);

const imageUriArb = fc.tuple(accountIdArb, regionArb, repoNameArb, tagArb)
    .map(([account, region, repo, tag]) =>
        `${account}.dkr.ecr.${region}.amazonaws.com/${repo}:${tag}`
    );

/**
 * Generate a valid S3 path.
 */
const s3BucketArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,20}$/);
const s3KeyArb = fc.stringMatching(/^[a-z0-9][a-z0-9/_-]{2,30}$/);

const scriptPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/${key}/train.py`);

const datasetPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/${key}/`);

const outputPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/output/${key}/`);

const checkpointPathArb = fc.tuple(s3BucketArb, s3KeyArb)
    .map(([bucket, key]) => `s3://${bucket}/checkpoints/${key}/`);

/**
 * Generate a valid SageMaker instance type.
 */
const instanceTypeArb = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.m5.4xlarge',
    'ml.g4dn.xlarge', 'ml.g4dn.2xlarge',
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.4xlarge',
    'ml.p3.2xlarge', 'ml.p4d.24xlarge'
);

/**
 * Generate a valid instance count (1-8).
 */
const instanceCountArb = fc.integer({ min: 1, max: 8 });

/**
 * Generate valid hyperparameters (string key-value map).
 */
const hyperparamKeyArb = fc.stringMatching(/^[a-z][a-z0-9_]{1,15}$/);
const hyperparamValueArb = fc.oneof(
    fc.integer({ min: 1, max: 10000 }).map(String),
    fc.float({ min: Math.fround(0.0001), max: Math.fround(1.0), noNaN: true }).map(v => v.toFixed(4)),
    fc.constantFrom('adam', 'sgd', 'cosine', 'linear')
);

const hyperparametersArb = fc.array(
    fc.tuple(hyperparamKeyArb, hyperparamValueArb),
    { minLength: 0, maxLength: 5 }
).map(pairs => {
    const obj = {};
    for (const [k, v] of pairs) {
        obj[k] = v;
    }
    return obj;
});

/**
 * Generate max_runtime_seconds (1 hour to 5 days).
 */
const maxRuntimeArb = fc.integer({ min: 3600, max: 432000 });

/**
 * Generate volume_size_gb (10-500).
 */
const volumeSizeArb = fc.integer({ min: 10, max: 500 });

/**
 * Generate max_wait_seconds (must be >= max_runtime_seconds).
 */
const maxWaitArb = fc.integer({ min: 7200, max: 864000 });

/**
 * Generate a valid job name.
 */
const jobNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{5,30}-train-[0-9]{10,14}$/);

/**
 * Generate a valid IAM role ARN.
 */
const roleArnArb = fc.tuple(accountIdArb, fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]{2,20}$/))
    .map(([account, roleName]) => `arn:aws:iam::${account}:role/${roleName}`);

/**
 * Generate a parsed config object (as returned by parseTrainingConfig).
 * All scalar values are strings (matching the parser's output).
 */
const parsedConfigArb = fc.record({
    image: imageUriArb,
    script: scriptPathArb,
    instance_type: instanceTypeArb,
    instance_count: instanceCountArb.map(String),
    dataset: datasetPathArb,
    output_path: outputPathArb,
    hyperparameters: hyperparametersArb,
    max_runtime_seconds: maxRuntimeArb.map(String),
    volume_size_gb: volumeSizeArb.map(String),
    enable_spot: fc.constantFrom('true', 'false'),
    max_wait_seconds: maxWaitArb.map(String),
    checkpoint_path: fc.oneof(
        checkpointPathArb,
        fc.constant('')
    ),
    metric_definitions: fc.constant([]),
    environment: fc.constant({}),
    tags: fc.constant({})
});

/**
 * Generate a parsed config with spot training enabled and a checkpoint path.
 */
const spotConfigArb = fc.record({
    image: imageUriArb,
    script: scriptPathArb,
    instance_type: instanceTypeArb,
    instance_count: instanceCountArb.map(String),
    dataset: datasetPathArb,
    output_path: outputPathArb,
    hyperparameters: hyperparametersArb,
    max_runtime_seconds: maxRuntimeArb.map(String),
    volume_size_gb: volumeSizeArb.map(String),
    enable_spot: fc.constant('true'),
    max_wait_seconds: maxWaitArb.map(String),
    checkpoint_path: checkpointPathArb,
    metric_definitions: fc.constant([]),
    environment: fc.constant({}),
    tags: fc.constant({})
});

// ── Property 7: Training config maps correctly to CreateTrainingJob request ──

describe('Feature: fine-tuning-training, Property 7: Training config maps correctly to CreateTrainingJob request', () => {

    it('maps image to AlgorithmSpecification.TrainingImage', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            parsedConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.AlgorithmSpecification.TrainingImage,
                    config.image,
                    `TrainingImage must be "${config.image}", got "${request.AlgorithmSpecification.TrainingImage}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('maps instance_type to ResourceConfig.InstanceType', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            parsedConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.ResourceConfig.InstanceType,
                    config.instance_type,
                    `InstanceType must be "${config.instance_type}", got "${request.ResourceConfig.InstanceType}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('maps instance_count to ResourceConfig.InstanceCount as integer', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            parsedConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.ResourceConfig.InstanceCount,
                    parseInt(config.instance_count, 10),
                    `InstanceCount must be ${config.instance_count}, got ${request.ResourceConfig.InstanceCount}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('maps dataset to InputDataConfig[0].DataSource.S3DataSource.S3Uri', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            parsedConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.InputDataConfig[0].DataSource.S3DataSource.S3Uri,
                    config.dataset,
                    `S3Uri must be "${config.dataset}", got "${request.InputDataConfig[0].DataSource.S3DataSource.S3Uri}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('maps output_path to OutputDataConfig.S3OutputPath', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            parsedConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.OutputDataConfig.S3OutputPath,
                    config.output_path,
                    `S3OutputPath must be "${config.output_path}", got "${request.OutputDataConfig.S3OutputPath}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('maps each hyperparameter key-value to HyperParameters', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            parsedConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                const inputHyperparams = config.hyperparameters || {};
                const outputHyperparams = request.HyperParameters || {};

                // Every input hyperparameter must appear in the output
                for (const [key, value] of Object.entries(inputHyperparams)) {
                    assert.strictEqual(
                        outputHyperparams[key],
                        String(value),
                        `HyperParameters["${key}"] must be "${value}", got "${outputHyperparams[key]}"`
                    );
                }

                // Output should not have extra hyperparameters
                assert.strictEqual(
                    Object.keys(outputHyperparams).length,
                    Object.keys(inputHyperparams).length,
                    `HyperParameters count mismatch: expected ${Object.keys(inputHyperparams).length}, got ${Object.keys(outputHyperparams).length}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('maps max_runtime_seconds to StoppingCondition.MaxRuntimeInSeconds as integer', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            parsedConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.StoppingCondition.MaxRuntimeInSeconds,
                    parseInt(config.max_runtime_seconds, 10),
                    `MaxRuntimeInSeconds must be ${config.max_runtime_seconds}, got ${request.StoppingCondition.MaxRuntimeInSeconds}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('sets EnableManagedSpotTraining=true when enable_spot is "true"', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            spotConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.EnableManagedSpotTraining,
                    true,
                    'EnableManagedSpotTraining must be true when enable_spot is "true"'
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('sets StoppingCondition.MaxWaitTimeInSeconds when enable_spot is "true"', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            spotConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.StoppingCondition.MaxWaitTimeInSeconds,
                    parseInt(config.max_wait_seconds, 10),
                    `MaxWaitTimeInSeconds must be ${config.max_wait_seconds}, got ${request.StoppingCondition.MaxWaitTimeInSeconds}`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('sets CheckpointConfig.S3Uri when checkpoint_path is non-empty', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            spotConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.ok(
                    request.CheckpointConfig,
                    'CheckpointConfig must be present when checkpoint_path is non-empty'
                );
                assert.strictEqual(
                    request.CheckpointConfig.S3Uri,
                    config.checkpoint_path,
                    `CheckpointConfig.S3Uri must be "${config.checkpoint_path}", got "${request.CheckpointConfig.S3Uri}"`
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('does NOT set EnableManagedSpotTraining when enable_spot is "false"', function () {
        this.timeout(PROPERTY_CONFIG.timeout);

        const nonSpotConfigArb = fc.record({
            image: imageUriArb,
            script: scriptPathArb,
            instance_type: instanceTypeArb,
            instance_count: instanceCountArb.map(String),
            dataset: datasetPathArb,
            output_path: outputPathArb,
            hyperparameters: hyperparametersArb,
            max_runtime_seconds: maxRuntimeArb.map(String),
            volume_size_gb: volumeSizeArb.map(String),
            enable_spot: fc.constant('false'),
            max_wait_seconds: maxWaitArb.map(String),
            checkpoint_path: fc.constant(''),
            metric_definitions: fc.constant([]),
            environment: fc.constant({}),
            tags: fc.constant({})
        });

        fc.assert(fc.property(
            nonSpotConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                assert.strictEqual(
                    request.EnableManagedSpotTraining,
                    undefined,
                    'EnableManagedSpotTraining must not be set when enable_spot is "false"'
                );
                assert.strictEqual(
                    request.StoppingCondition.MaxWaitTimeInSeconds,
                    undefined,
                    'MaxWaitTimeInSeconds must not be set when enable_spot is "false"'
                );
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });

    it('maps all fields simultaneously in a single request', function () {
        this.timeout(PROPERTY_CONFIG.timeout);
        fc.assert(fc.property(
            spotConfigArb,
            jobNameArb,
            roleArnArb,
            (config, jobName, roleArn) => {
                const request = buildTrainingJobRequest({ jobName, roleArn, config });

                // Verify all core mappings in one pass
                assert.strictEqual(request.TrainingJobName, jobName);
                assert.strictEqual(request.RoleArn, roleArn);
                assert.strictEqual(request.AlgorithmSpecification.TrainingImage, config.image);
                assert.strictEqual(request.AlgorithmSpecification.TrainingInputMode, 'File');
                assert.strictEqual(request.ResourceConfig.InstanceType, config.instance_type);
                assert.strictEqual(request.ResourceConfig.InstanceCount, parseInt(config.instance_count, 10));
                assert.strictEqual(request.ResourceConfig.VolumeSizeInGB, parseInt(config.volume_size_gb, 10));
                assert.strictEqual(request.InputDataConfig[0].DataSource.S3DataSource.S3Uri, config.dataset);
                assert.strictEqual(request.InputDataConfig[0].DataSource.S3DataSource.S3DataType, 'S3Prefix');
                assert.strictEqual(request.InputDataConfig[0].DataSource.S3DataSource.S3DataDistributionType, 'FullyReplicated');
                assert.strictEqual(request.InputDataConfig[0].ChannelName, 'training');
                assert.strictEqual(request.OutputDataConfig.S3OutputPath, config.output_path);
                assert.strictEqual(request.StoppingCondition.MaxRuntimeInSeconds, parseInt(config.max_runtime_seconds, 10));
                assert.strictEqual(request.EnableManagedSpotTraining, true);
                assert.strictEqual(request.StoppingCondition.MaxWaitTimeInSeconds, parseInt(config.max_wait_seconds, 10));
                assert.strictEqual(request.CheckpointConfig.S3Uri, config.checkpoint_path);
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose });
    });
});

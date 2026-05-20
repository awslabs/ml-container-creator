// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Deploy Template Content Property-Based Tests
 *
 * Property 4: Deploy template uses ModelPackageName
 *
 * For any valid marketplace configuration, the generated do/deploy script
 * SHALL contain a CreateModel call using ModelPackageName (referencing the
 * model package ARN) and SHALL NOT contain an Image parameter pointing to
 * an ECR repository.
 *
 * Feature: marketplace-model-packages, Property 4: Deploy template uses ModelPackageName
 * Validates: Requirements 3.1, 8.2
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, seed: 42, verbose: false };

// ── Load the marketplace deploy template ─────────────────────────────────────

const TEMPLATE_PATH = resolve(__dirname, '../../templates/marketplace/deploy');
const DEPLOY_TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf-8');

// ── Arbitrary generators ─────────────────────────────────────────────────────

const AWS_REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-west-2', 'eu-central-1',
    'ap-southeast-1', 'ap-northeast-1'
];

const INSTANCE_TYPES = [
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.m5.4xlarge',
    'ml.g4dn.xlarge', 'ml.g4dn.2xlarge',
    'ml.g5.xlarge', 'ml.g5.2xlarge',
    'ml.p3.2xlarge', 'ml.c5.xlarge'
];

const DEPLOYMENT_TARGETS = ['realtime-inference', 'async-inference', 'batch-transform'];

/** Generate a valid model package ARN */
const arbModelPackageArn = fc.tuple(
    fc.constantFrom(...AWS_REGIONS),
    fc.stringMatching(/^[0-9]{12}$/).filter(s => s.length === 12),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => s.length >= 3),
    fc.integer({ min: 1, max: 99 })
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

/** Generate a valid project name */
const arbProjectName = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/).filter(s => s.length >= 3);

/** Generate a valid role ARN */
const arbRoleArn = fc.stringMatching(/^[0-9]{12}$/).filter(s => s.length === 12)
    .map(account => `arn:aws:iam::${account}:role/SageMakerExecutionRole`);

/** Generate a valid S3 path */
const arbS3Path = fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/).filter(s => s.length >= 3)
    .map(bucket => `s3://${bucket}/output/`);

/** Generate a valid SNS topic ARN */
const arbSnsTopicArn = fc.tuple(
    fc.constantFrom(...AWS_REGIONS),
    fc.stringMatching(/^[0-9]{12}$/).filter(s => s.length === 12),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/).filter(s => s.length >= 3)
).map(([region, account, name]) =>
    `arn:aws:sns:${region}:${account}:${name}`
);

/** Generate a complete valid marketplace answers object for realtime */
const arbRealtimeAnswers = fc.record({
    projectName: arbProjectName,
    deploymentTarget: fc.constant('realtime-inference'),
    modelPackageArn: arbModelPackageArn,
    awsRegion: fc.constantFrom(...AWS_REGIONS),
    instanceType: fc.constantFrom(...INSTANCE_TYPES),
    roleArn: arbRoleArn,
    includeBenchmark: fc.boolean()
});

/** Generate a complete valid marketplace answers object for async */
const arbAsyncAnswers = fc.record({
    projectName: arbProjectName,
    deploymentTarget: fc.constant('async-inference'),
    modelPackageArn: arbModelPackageArn,
    awsRegion: fc.constantFrom(...AWS_REGIONS),
    instanceType: fc.constantFrom(...INSTANCE_TYPES),
    roleArn: arbRoleArn,
    includeBenchmark: fc.boolean(),
    asyncS3OutputPath: fc.oneof(fc.constant(''), arbS3Path),
    asyncSnsSuccessTopic: fc.oneof(fc.constant(''), arbSnsTopicArn),
    asyncSnsErrorTopic: fc.oneof(fc.constant(''), arbSnsTopicArn),
    asyncMaxConcurrentInvocations: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 10 }))
});

/** Generate a complete valid marketplace answers object for batch */
const arbBatchAnswers = fc.record({
    projectName: arbProjectName,
    deploymentTarget: fc.constant('batch-transform'),
    modelPackageArn: arbModelPackageArn,
    awsRegion: fc.constantFrom(...AWS_REGIONS),
    instanceType: fc.constantFrom(...INSTANCE_TYPES),
    roleArn: arbRoleArn,
    includeBenchmark: fc.boolean(),
    batchInputPath: fc.oneof(fc.constant(''), arbS3Path),
    batchOutputPath: fc.oneof(fc.constant(''), arbS3Path),
    batchInstanceCount: fc.integer({ min: 1, max: 5 }),
    batchSplitType: fc.constantFrom('Line', 'None'),
    batchStrategy: fc.constantFrom('MultiRecord', 'SingleRecord')
});

/** Generate any valid marketplace answers (all deployment targets) */
const arbAnyMarketplaceAnswers = fc.oneof(
    arbRealtimeAnswers,
    arbAsyncAnswers,
    arbBatchAnswers
);

// ── Helper functions ─────────────────────────────────────────────────────────

function renderDeployTemplate(answers) {
    return ejs.render(DEPLOY_TEMPLATE, answers);
}

// ECR image URL pattern: <account>.dkr.ecr.<region>.amazonaws.com/<repo>
const ECR_IMAGE_PATTERN = /\d+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/;

// Pattern for --primary-container with "Image" key (BYOC style)
const IMAGE_CONTAINER_PATTERN = /--primary-container.*"Image"/;

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 4: Deploy template uses ModelPackageName', () => {

    describe('deploy template contains CreateModel with ModelPackageName', () => {

        it('for any valid marketplace config, the rendered deploy script contains ModelPackageName', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbAnyMarketplaceAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    // Must contain ModelPackageName in the create-model call
                    assert.ok(
                        rendered.includes('ModelPackageName'),
                        'Deploy script must contain "ModelPackageName" for marketplace deployments'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the rendered deploy script references the model package ARN via ModelPackageName', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbAnyMarketplaceAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    // The template uses escaped quotes inside bash: {"ModelPackageName":"${MODEL_PACKAGE_ARN}"}
                    // In the rendered output this appears as: {\"ModelPackageName\":\"${MODEL_PACKAGE_ARN}\"}
                    assert.ok(
                        rendered.includes('\\\"ModelPackageName\\\":\\\"${MODEL_PACKAGE_ARN}\\\"'),
                        'Deploy script must reference MODEL_PACKAGE_ARN in the ModelPackageName field'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the rendered deploy script contains a create-model AWS CLI call', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbAnyMarketplaceAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    // Must contain the aws sagemaker create-model command
                    assert.ok(
                        rendered.includes('aws sagemaker create-model'),
                        'Deploy script must contain "aws sagemaker create-model" command'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('deploy template does NOT contain ECR Image references', () => {

        it('for any valid marketplace config, the rendered deploy script does NOT contain an ECR image URL', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbAnyMarketplaceAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    // Must NOT contain ECR image URL pattern
                    assert.ok(
                        !ECR_IMAGE_PATTERN.test(rendered),
                        'Deploy script must NOT contain ECR image URL (dkr.ecr.*.amazonaws.com) for marketplace deployments'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the rendered deploy script does NOT use --primary-container with Image key', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbAnyMarketplaceAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    // Must NOT contain --primary-container with "Image" key
                    assert.ok(
                        !IMAGE_CONTAINER_PATTERN.test(rendered),
                        'Deploy script must NOT use --primary-container with "Image" key for marketplace deployments'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the rendered deploy script does NOT reference docker push or ECR login', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbAnyMarketplaceAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    // Must NOT contain docker push or ECR login commands
                    assert.ok(
                        !rendered.includes('docker push'),
                        'Deploy script must NOT contain "docker push" for marketplace deployments'
                    );
                    assert.ok(
                        !rendered.includes('ecr get-login'),
                        'Deploy script must NOT contain "ecr get-login" for marketplace deployments'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('deploy template uses ModelPackageName consistently across all deployment targets', () => {

        it('for realtime deployment target, CreateModel uses ModelPackageName', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbRealtimeAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    assert.ok(
                        rendered.includes('ModelPackageName'),
                        'Realtime deploy must use ModelPackageName'
                    );
                    assert.ok(
                        !IMAGE_CONTAINER_PATTERN.test(rendered),
                        'Realtime deploy must NOT use Image in primary container'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for async deployment target, CreateModel uses ModelPackageName', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbAsyncAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    assert.ok(
                        rendered.includes('ModelPackageName'),
                        'Async deploy must use ModelPackageName'
                    );
                    assert.ok(
                        !IMAGE_CONTAINER_PATTERN.test(rendered),
                        'Async deploy must NOT use Image in primary container'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for batch deployment target, CreateModel uses ModelPackageName', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbBatchAnswers,
                (answers) => {
                    const rendered = renderDeployTemplate(answers);

                    assert.ok(
                        rendered.includes('ModelPackageName'),
                        'Batch deploy must use ModelPackageName'
                    );
                    assert.ok(
                        !IMAGE_CONTAINER_PATTERN.test(rendered),
                        'Batch deploy must NOT use Image in primary container'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

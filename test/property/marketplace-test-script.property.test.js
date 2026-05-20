// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Test Script Property-Based Tests
 *
 * Property 6: Marketplace test script excludes local mode
 *
 * For any valid marketplace configuration, the generated `do/test` script
 * SHALL contain endpoint invocation logic and SHALL NOT contain local-mode
 * testing (no `localhost:8080`, no `docker run` references).
 *
 * Feature: marketplace-model-packages, Property 6: Marketplace test script excludes local mode
 *
 * **Validates: Requirements 4.1, 4.3**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, seed: 42, verbose: false };

// ── Load the marketplace test template ───────────────────────────────────────

const TEMPLATE_PATH = path.resolve(__dirname, '../../templates/marketplace/test');
const TEST_TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Valid project names
const arbProjectName = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/)
    .filter(s => s.length >= 3 && !s.endsWith('-'));

// Valid model package ARNs
const arbModelPackageArn = fc.tuple(
    fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'),
    fc.constantFrom('aws', '123456789012', '987654321098'),
    fc.stringMatching(/^[a-z][a-z0-9-]{3,20}$/).filter(s => s.length >= 4),
    fc.integer({ min: 1, max: 10 })
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// Valid AWS regions
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'
);

// Valid instance types
const arbInstanceType = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge',
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p3.2xlarge'
);

// Valid deployment targets
const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform'
);

// Valid content types
const arbSupportedContentTypes = fc.oneof(
    fc.constant(['application/json']),
    fc.constant(['text/csv']),
    fc.constant(['application/json', 'text/csv']),
    fc.constant(undefined)
);

// Valid role ARN
const arbRoleArn = fc.constantFrom(
    'arn:aws:iam::123456789012:role/SageMakerRole',
    'arn:aws:iam::987654321098:role/MLRole',
    ''
);

// Optional benchmark flag
const arbIncludeBenchmark = fc.boolean();

// Async-specific fields
const arbAsyncS3OutputPath = fc.constantFrom(
    's3://my-bucket/async-output/',
    's3://ml-output-bucket/results/'
);

// Batch-specific fields
const arbBatchInputPath = fc.constantFrom(
    's3://my-bucket/batch-input/',
    's3://ml-data-bucket/input/'
);
const arbBatchOutputPath = fc.constantFrom(
    's3://my-bucket/batch-output/',
    's3://ml-data-bucket/output/'
);

/**
 * Generate a valid marketplace answers object for the test template.
 */
const arbMarketplaceTestConfig = fc.record({
    projectName: arbProjectName,
    modelPackageArn: arbModelPackageArn,
    awsRegion: arbAwsRegion,
    instanceType: arbInstanceType,
    deploymentTarget: arbDeploymentTarget,
    supportedContentTypes: arbSupportedContentTypes,
    roleArn: arbRoleArn,
    includeBenchmark: arbIncludeBenchmark,
    asyncS3OutputPath: arbAsyncS3OutputPath,
    batchInputPath: arbBatchInputPath,
    batchOutputPath: arbBatchOutputPath
});

// ── Helper functions ─────────────────────────────────────────────────────────

function renderTestTemplate(config) {
    return ejs.render(TEST_TEMPLATE, config);
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 6: Marketplace test script excludes local mode', () => {

    describe('test script contains endpoint invocation logic', () => {

        it('for any valid marketplace config, the test script contains invoke-endpoint or invoke-endpoint-async', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceTestConfig,
                (config) => {
                    const rendered = renderTestTemplate(config);

                    // For realtime and async, should contain invoke-endpoint
                    // For batch, should contain describe-transform-job (checking job status)
                    if (config.deploymentTarget === 'batch-transform') {
                        assert.ok(
                            rendered.includes('describe-transform-job'),
                            `Batch transform test script must contain "describe-transform-job" for deployment target "${config.deploymentTarget}"`
                        );
                    } else if (config.deploymentTarget === 'async-inference') {
                        assert.ok(
                            rendered.includes('invoke-endpoint-async'),
                            `Async test script must contain "invoke-endpoint-async" for deployment target "${config.deploymentTarget}"`
                        );
                    } else {
                        assert.ok(
                            rendered.includes('invoke-endpoint'),
                            `Realtime test script must contain "invoke-endpoint" for deployment target "${config.deploymentTarget}"`
                        );
                    }
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the test script contains sagemaker or sagemaker-runtime AWS CLI calls', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceTestConfig,
                (config) => {
                    const rendered = renderTestTemplate(config);

                    const hasSagemakerCli = rendered.includes('aws sagemaker') ||
                                           rendered.includes('aws sagemaker-runtime');

                    assert.ok(hasSagemakerCli,
                        'Test script must contain AWS SageMaker CLI calls for endpoint invocation');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('test script does NOT contain local-mode testing', () => {

        it('for any valid marketplace config, the test script does NOT contain localhost:8080', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceTestConfig,
                (config) => {
                    const rendered = renderTestTemplate(config);

                    assert.ok(
                        !rendered.includes('localhost:8080'),
                        'Marketplace test script must NOT contain "localhost:8080" (no local container to test)'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the test script does NOT contain docker run', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceTestConfig,
                (config) => {
                    const rendered = renderTestTemplate(config);

                    assert.ok(
                        !rendered.includes('docker run'),
                        'Marketplace test script must NOT contain "docker run" (no local container to test)'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the test script does NOT contain docker exec', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceTestConfig,
                (config) => {
                    const rendered = renderTestTemplate(config);

                    assert.ok(
                        !rendered.includes('docker exec'),
                        'Marketplace test script must NOT contain "docker exec" (no local container to test)'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });

        it('for any valid marketplace config, the test script does NOT contain curl localhost', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceTestConfig,
                (config) => {
                    const rendered = renderTestTemplate(config);

                    assert.ok(
                        !rendered.includes('curl localhost') && !rendered.includes('curl http://localhost'),
                        'Marketplace test script must NOT contain "curl localhost" (no local container to test)'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });

    describe('test script explicitly rejects local mode', () => {

        it('for any valid marketplace config, the test script contains a --local rejection message', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceTestConfig,
                (config) => {
                    const rendered = renderTestTemplate(config);

                    // The template should handle --local flag with a rejection message
                    assert.ok(
                        rendered.includes('--local') || rendered.includes('-l'),
                        'Marketplace test script must handle the --local flag (to reject it with a message)'
                    );

                    assert.ok(
                        rendered.toLowerCase().includes('local mode is not available') ||
                        rendered.toLowerCase().includes('local mode is unavailable') ||
                        rendered.toLowerCase().includes('not available for marketplace'),
                        'Marketplace test script must contain a message indicating local mode is not available'
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
        });
    });
});

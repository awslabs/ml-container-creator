// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Config Content Property-Based Tests
 *
 * Property 5: Config emits MODEL_PACKAGE_ARN without MODEL_NAME or MODEL_SOURCE
 *
 * For any valid marketplace configuration, the generated do/config script
 * SHALL export MODEL_PACKAGE_ARN and SHALL NOT export MODEL_NAME or MODEL_SOURCE.
 *
 * Feature: marketplace-model-packages, Property 5: Config emits MODEL_PACKAGE_ARN without MODEL_NAME or MODEL_SOURCE
 *
 * **Validates: Requirements 5.5**
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

const PROPERTY_CONFIG = { numRuns: 100, timeout: 30000, verbose: false, seed: 42 };

// ── Load the actual marketplace config template ──────────────────────────────

const TEMPLATE_PATH = path.resolve(__dirname, '../../templates/marketplace/config');
const TEMPLATE_CONTENT = fs.readFileSync(TEMPLATE_PATH, 'utf8');

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Valid AWS regions
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);

// Valid model package ARNs
const arbModelPackageArn = fc.tuple(
    arbAwsRegion,
    fc.stringMatching(/^[0-9]{12}$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    fc.integer({ min: 1, max: 99 })
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// Valid project names
const arbProjectName = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/)
    .filter(s => !s.endsWith('-'));

// Valid instance types
const arbInstanceType = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge', 'ml.g5.xlarge',
    'ml.g5.2xlarge', 'ml.p3.2xlarge', 'ml.c5.xlarge', 'ml.c5.2xlarge'
);

// Valid deployment targets
const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform'
);

// Valid role ARNs
const arbRoleArn = fc.stringMatching(/^[0-9]{12}$/).map(account =>
    `arn:aws:iam::${account}:role/SageMakerExecutionRole`
);

// ── Build a complete valid marketplace answers object ─────────────────────────

const arbMarketplaceAnswers = fc.record({
    projectName: arbProjectName,
    modelPackageArn: arbModelPackageArn,
    awsRegion: arbAwsRegion,
    instanceType: arbInstanceType,
    deploymentTarget: arbDeploymentTarget,
    roleArn: arbRoleArn,
    // Async-specific (optional)
    asyncS3OutputPath: fc.constant(''),
    asyncSnsSuccessTopic: fc.constant(''),
    asyncSnsErrorTopic: fc.constant(''),
    asyncMaxConcurrentInvocations: fc.constant(null),
    // Batch-specific (optional)
    batchInputPath: fc.constant(''),
    batchOutputPath: fc.constant(''),
    batchInstanceCount: fc.constant(1),
    batchSplitType: fc.constant('Line'),
    batchStrategy: fc.constant('MultiRecord'),
    batchJoinSource: fc.constant('None'),
    batchMaxConcurrentTransforms: fc.constant(null),
    batchMaxPayloadInMB: fc.constant(null),
    // Benchmark (optional)
    includeBenchmark: fc.constant(false),
    benchmarkConcurrency: fc.constant(1),
    benchmarkInputTokensMean: fc.constant(256),
    benchmarkOutputTokensMean: fc.constant(128),
    benchmarkStreaming: fc.constant(false),
    benchmarkRequestCount: fc.constant(null),
    benchmarkS3OutputPath: fc.constant('')
});

// ── Helper functions ─────────────────────────────────────────────────────────

function renderMarketplaceConfig(answers) {
    return ejs.render(TEMPLATE_CONTENT, answers);
}

function getExportLines(rendered) {
    return rendered.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('export '));
}

function hasExportForVariable(exportLines, varName) {
    return exportLines.some(line =>
        line.match(new RegExp(`^export\\s+${varName}[=\\s]`))
    );
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 5: Config emits MODEL_PACKAGE_ARN without MODEL_NAME or MODEL_SOURCE', () => {

    describe('MODEL_PACKAGE_ARN is always exported', () => {

        it('for any valid marketplace config, the rendered output contains export MODEL_PACKAGE_ARN', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceAnswers,
                (answers) => {
                    const rendered = renderMarketplaceConfig(answers);
                    const exportLines = getExportLines(rendered);

                    const hasModelPackageArn = hasExportForVariable(exportLines, 'MODEL_PACKAGE_ARN');
                    assert.strictEqual(hasModelPackageArn, true,
                        'Marketplace config must export MODEL_PACKAGE_ARN, but it was not found in output');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });

        it('for any valid marketplace config, MODEL_PACKAGE_ARN contains the provided ARN value', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceAnswers,
                (answers) => {
                    const rendered = renderMarketplaceConfig(answers);

                    assert.ok(rendered.includes(answers.modelPackageArn),
                        `Rendered config must contain the model package ARN "${answers.modelPackageArn}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });
    });

    describe('MODEL_NAME is never exported', () => {

        it('for any valid marketplace config, the rendered output does NOT contain export MODEL_NAME', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceAnswers,
                (answers) => {
                    const rendered = renderMarketplaceConfig(answers);
                    const exportLines = getExportLines(rendered);

                    const hasModelName = hasExportForVariable(exportLines, 'MODEL_NAME');
                    assert.strictEqual(hasModelName, false,
                        'Marketplace config must NOT export MODEL_NAME, but it was found in output');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });
    });

    describe('MODEL_SOURCE is never exported', () => {

        it('for any valid marketplace config, the rendered output does NOT contain export MODEL_SOURCE', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceAnswers,
                (answers) => {
                    const rendered = renderMarketplaceConfig(answers);
                    const exportLines = getExportLines(rendered);

                    const hasModelSource = hasExportForVariable(exportLines, 'MODEL_SOURCE');
                    assert.strictEqual(hasModelSource, false,
                        'Marketplace config must NOT export MODEL_SOURCE, but it was found in output');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });
    });

    describe('combined property: MODEL_PACKAGE_ARN present AND MODEL_NAME/MODEL_SOURCE absent', () => {

        it('for any valid marketplace config, the invariant holds across all deployment targets', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                arbMarketplaceAnswers,
                (answers) => {
                    const rendered = renderMarketplaceConfig(answers);
                    const exportLines = getExportLines(rendered);

                    // MODEL_PACKAGE_ARN must be present
                    const hasModelPackageArn = hasExportForVariable(exportLines, 'MODEL_PACKAGE_ARN');
                    assert.strictEqual(hasModelPackageArn, true,
                        `MODEL_PACKAGE_ARN must be exported for deployment target "${answers.deploymentTarget}"`);

                    // MODEL_NAME must be absent
                    const hasModelName = hasExportForVariable(exportLines, 'MODEL_NAME');
                    assert.strictEqual(hasModelName, false,
                        `MODEL_NAME must NOT be exported for deployment target "${answers.deploymentTarget}"`);

                    // MODEL_SOURCE must be absent
                    const hasModelSource = hasExportForVariable(exportLines, 'MODEL_SOURCE');
                    assert.strictEqual(hasModelSource, false,
                        `MODEL_SOURCE must NOT be exported for deployment target "${answers.deploymentTarget}"`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });

        it('for any valid marketplace config with benchmark enabled, the invariant still holds', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            const arbWithBenchmark = arbMarketplaceAnswers.map(answers => ({
                ...answers,
                includeBenchmark: true,
                benchmarkConcurrency: 4,
                benchmarkInputTokensMean: 512,
                benchmarkOutputTokensMean: 256,
                benchmarkStreaming: true
            }));

            fc.assert(fc.property(
                arbWithBenchmark,
                (answers) => {
                    const rendered = renderMarketplaceConfig(answers);
                    const exportLines = getExportLines(rendered);

                    const hasModelPackageArn = hasExportForVariable(exportLines, 'MODEL_PACKAGE_ARN');
                    assert.strictEqual(hasModelPackageArn, true,
                        'MODEL_PACKAGE_ARN must be exported even with benchmark enabled');

                    const hasModelName = hasExportForVariable(exportLines, 'MODEL_NAME');
                    assert.strictEqual(hasModelName, false,
                        'MODEL_NAME must NOT be exported even with benchmark enabled');

                    const hasModelSource = hasExportForVariable(exportLines, 'MODEL_SOURCE');
                    assert.strictEqual(hasModelSource, false,
                        'MODEL_SOURCE must NOT be exported even with benchmark enabled');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });
    });
});

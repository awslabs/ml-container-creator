// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace File Exclusion Property-Based Tests
 *
 * Property 2: Marketplace file exclusion invariant
 *
 * For any valid marketplace configuration (any combination of valid model
 * package ARN, instance type, deployment target, and region), the generated
 * project SHALL NOT contain a Dockerfile, a code/ directory, do/build,
 * do/push, do/submit, do/adapter, or do/tune.
 *
 * Feature: marketplace-model-packages, Property 2: Marketplace file exclusion invariant
 *
 * **Validates: Requirements 3.3, 5.1, 8.9**
 */

import fc from 'fast-check';
import { describe, it, afterEach } from 'mocha';
import { runGenerator } from '../helpers/run-generator.js';

const PROPERTY_CONFIG = { numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10), timeout: 30000, seed: 42, verbose: false };

// Mocha timeout must be longer than fast-check's interruptAfterTimeLimit
// to allow fast-check to complete gracefully
const MOCHA_TIMEOUT = PROPERTY_CONFIG.timeout + 5000;

// ── Arbitrary generators ─────────────────────────────────────────────────────

// Valid AWS regions
const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);

// Valid model package ARNs
const arbModelPackageArn = fc.tuple(
    arbAwsRegion,
    fc.constantFrom('123456789012', '987654321098', '111222333444'),
    fc.constantFrom('ai21-j2-ultra', 'cohere-command', 'meta-llama', 'stability-sdxl', 'anthropic-claude'),
    fc.integer({ min: 1, max: 10 })
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

// Valid project names
const arbProjectName = fc.constantFrom(
    'test-mkt', 'my-marketplace', 'mkt-deploy', 'vendor-model', 'ai-pkg'
);

// Valid instance types
const arbInstanceType = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge', 'ml.g5.xlarge',
    'ml.g5.2xlarge', 'ml.p3.2xlarge', 'ml.c5.xlarge'
);

// Valid deployment targets
const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform'
);

/**
 * Generate a complete set of CLI options for running the marketplace generator.
 */
const arbMarketplaceCliOptions = fc.record({
    projectName: arbProjectName,
    modelPackageArn: arbModelPackageArn,
    awsRegion: arbAwsRegion,
    instanceType: arbInstanceType,
    deploymentTarget: arbDeploymentTarget
}).map(({ projectName, modelPackageArn, awsRegion, instanceType, deploymentTarget }) => ({
    projectName,
    cliOptions: {
        'deployment-config': 'marketplace',
        'model-name': `marketplace://${modelPackageArn}`,
        'instance-type': instanceType,
        'region': awsRegion,
        'deployment-target': deploymentTarget,
        'project-name': projectName
    }
}));

// ── Files that MUST NOT exist in marketplace projects ────────────────────────

const EXCLUDED_FILES = [
    'Dockerfile',
    'code/model_handler.py',
    'code/serve.py',
    'code/serve',
    'do/build',
    'do/push',
    'do/submit',
    'do/adapter',
    'do/tune'
];

// ── Track results for cleanup ────────────────────────────────────────────────

let lastResult = null;

afterEach(() => {
    if (lastResult) {
        lastResult.cleanup();
        lastResult = null;
    }
});

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 2: Marketplace file exclusion invariant', () => {

    it('for any valid marketplace config, the generated project does NOT contain Dockerfile, code/, do/build, do/push, do/submit, do/adapter, or do/tune', function () {
        this.timeout(MOCHA_TIMEOUT);

        fc.assert(fc.property(
            arbMarketplaceCliOptions,
            (input) => {
                const result = runGenerator(input.cliOptions);
                lastResult = result;

                // Verify ALL excluded files are absent in a single pass
                for (const file of EXCLUDED_FILES) {
                    result.assertNoFile(file);
                }

                result.cleanup();
                lastResult = null;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose, interruptAfterTimeLimit: PROPERTY_CONFIG.timeout });
    });

    it('for realtime-inference marketplace config, all excluded files are absent', function () {
        this.timeout(MOCHA_TIMEOUT);

        const arbRealtimeOptions = arbMarketplaceCliOptions.map(input => ({
            ...input,
            cliOptions: { ...input.cliOptions, 'deployment-target': 'realtime-inference' }
        }));

        fc.assert(fc.property(
            arbRealtimeOptions,
            (input) => {
                const result = runGenerator(input.cliOptions);
                lastResult = result;

                for (const file of EXCLUDED_FILES) {
                    result.assertNoFile(file);
                }

                result.cleanup();
                lastResult = null;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose, interruptAfterTimeLimit: PROPERTY_CONFIG.timeout });
    });

    it('for async-inference marketplace config, all excluded files are absent', function () {
        this.timeout(MOCHA_TIMEOUT);

        const arbAsyncOptions = arbMarketplaceCliOptions.map(input => ({
            ...input,
            cliOptions: { ...input.cliOptions, 'deployment-target': 'async-inference' }
        }));

        fc.assert(fc.property(
            arbAsyncOptions,
            (input) => {
                const result = runGenerator(input.cliOptions);
                lastResult = result;

                for (const file of EXCLUDED_FILES) {
                    result.assertNoFile(file);
                }

                result.cleanup();
                lastResult = null;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose, interruptAfterTimeLimit: PROPERTY_CONFIG.timeout });
    });

    it('for batch-transform marketplace config, all excluded files are absent', function () {
        this.timeout(MOCHA_TIMEOUT);

        const arbBatchOptions = arbMarketplaceCliOptions.map(input => ({
            ...input,
            cliOptions: { ...input.cliOptions, 'deployment-target': 'batch-transform' }
        }));

        fc.assert(fc.property(
            arbBatchOptions,
            (input) => {
                const result = runGenerator(input.cliOptions);
                lastResult = result;

                for (const file of EXCLUDED_FILES) {
                    result.assertNoFile(file);
                }

                result.cleanup();
                lastResult = null;
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose, interruptAfterTimeLimit: PROPERTY_CONFIG.timeout });
    });
});

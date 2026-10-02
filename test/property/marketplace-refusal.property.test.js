// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Refusal Property-Based Tests
 *
 * Property: for ANY combination of otherwise-valid marketplace CLI options
 * (model-package ARN, instance type, deployment target, region), the generator
 * hard-refuses with a non-zero exit and the deprecation message — it never
 * produces a project.
 *
 * This replaces the former marketplace generation-shape property suites
 * (file-inclusion / file-exclusion / async-batch / deployment-target), whose
 * premise — that a valid marketplace config yields a generated project — no
 * longer holds now that marketplace is deprecated. Marketplace deploys a
 * pre-built vendor model package and never builds a container, which violates
 * the tool's core promise (bring your own container).
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { runGenerator } from '../helpers/run-generator.js';
import { GEN_NUM_RUNS } from '../helpers/property-config.js';

const PROPERTY_CONFIG = { numRuns: GEN_NUM_RUNS, timeout: 120000, seed: 42, verbose: false };
const MOCHA_TIMEOUT = PROPERTY_CONFIG.timeout + 5000;

// ── Arbitrary generators ─────────────────────────────────────────────────────

const arbAwsRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);

const arbModelPackageArn = fc.tuple(
    arbAwsRegion,
    fc.constantFrom('123456789012', '987654321098', '111222333444'),
    fc.constantFrom('ai21-j2-ultra', 'cohere-command', 'meta-llama', 'stability-sdxl', 'anthropic-claude'),
    fc.integer({ min: 1, max: 10 })
).map(([region, account, name, version]) =>
    `arn:aws:sagemaker:${region}:${account}:model-package/${name}/${version}`
);

const arbProjectName = fc.constantFrom(
    'test-mkt', 'my-marketplace', 'mkt-deploy', 'vendor-model', 'ai-pkg'
);

const arbInstanceType = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge', 'ml.g5.xlarge',
    'ml.g5.2xlarge', 'ml.p3.2xlarge', 'ml.c5.xlarge'
);

// Drive refusal through the marketplace:// model-name prefix. The
// --deployment-config=marketplace flag is separately rejected by Commander (it
// is no longer an allowed enum choice); the model-name prefix is a free string
// that reaches the generator's own deprecation guard, so it exercises the custom
// refusal message this suite asserts.
const arbMarketplaceCliOptions = fc.record({
    projectName: arbProjectName,
    modelPackageArn: arbModelPackageArn,
    awsRegion: arbAwsRegion,
    instanceType: arbInstanceType
}).map(({ projectName, modelPackageArn, awsRegion, instanceType }) => ({
    'model-name': `marketplace://${modelPackageArn}`,
    'instance-type': instanceType,
    'region': awsRegion,
    'project-name': projectName
}));

// ── Property tests ───────────────────────────────────────────────────────────

describe('Marketplace refusal (property)', () => {

    it('for any valid marketplace config, the generator refuses with exit 1 and the deprecation message', function () {
        this.timeout(MOCHA_TIMEOUT);

        fc.assert(fc.property(
            arbMarketplaceCliOptions,
            (cliOptions) => {
                let refused = false;
                let result;
                try {
                    result = runGenerator(cliOptions);
                } catch (error) {
                    refused = true;
                    assert.equal(error.exitCode, 1, 'generator should exit non-zero for marketplace');
                    assert.match(error.stderr, /Marketplace deployments are no longer supported/);
                }
                if (!refused) {
                    // Generation must never succeed for marketplace.
                    result.cleanup();
                    assert.fail('Expected marketplace generation to be refused, but it succeeded');
                }
            }
        ), { numRuns: PROPERTY_CONFIG.numRuns, seed: PROPERTY_CONFIG.seed, verbose: PROPERTY_CONFIG.verbose });
    });
});

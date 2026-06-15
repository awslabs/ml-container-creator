// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace LoRA Mutual Exclusion Property-Based Tests
 *
 * Property 7: LoRA and marketplace are mutually exclusive
 *
 * For any marketplace configuration where enableLora is set to true,
 * the generator SHALL reject the configuration with an error message
 * indicating LoRA is not supported for marketplace packages.
 *
 * Feature: marketplace-model-packages, Property 7: LoRA and marketplace are mutually exclusive
 *
 * **Validates: Requirements 7.5, 8.6**
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import CrossCuttingChecker from '../../src/lib/cross-cutting-checker.js';
import { NUM_RUNS } from '../helpers/property-config.js';

const PROPERTY_CONFIG = { numRuns: NUM_RUNS, timeout: 30000, verbose: false, seed: 42 };

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

// Valid instance types
const arbInstanceType = fc.constantFrom(
    'ml.m5.xlarge', 'ml.m5.2xlarge', 'ml.g4dn.xlarge', 'ml.g5.xlarge',
    'ml.g5.2xlarge', 'ml.p3.2xlarge', 'ml.c5.xlarge'
);

// Valid deployment targets
const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform'
);

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * Build a validation context for the cross-cutting checker.
 */
function buildContext(config, deploymentTarget = 'realtime-inference') {
    return {
        payloads: {},
        config: config || {},
        deploymentTarget,
        metadata: {
            generatedAt: new Date().toISOString(),
            generatorVersion: '0.2.5',
            services: ['sagemaker']
        }
    };
}

// ── Property tests ───────────────────────────────────────────────────────────

describe('Feature: marketplace-model-packages, Property 7: LoRA and marketplace are mutually exclusive', () => {

    const checker = new CrossCuttingChecker();

    describe('enableLora=true with marketplace always produces LoRA rejection error', () => {

        it('for any marketplace config with enableLora=true (boolean), a LoRA rejection finding is produced', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.record({
                    modelPackageArn: arbModelPackageArn,
                    instanceType: arbInstanceType,
                    deploymentTarget: arbDeploymentTarget,
                    awsRegion: arbAwsRegion
                }),
                ({ modelPackageArn, instanceType, deploymentTarget, awsRegion }) => {
                    const context = buildContext({
                        architecture: 'marketplace',
                        modelPackageArn,
                        instanceType,
                        awsRegion,
                        enableLora: true
                    }, deploymentTarget);

                    const findings = checker.checkMarketplaceCompatibility(context);

                    // Filter to LoRA-specific findings
                    const loraFindings = findings.filter(f =>
                        f.constraint && f.constraint.type === 'marketplace-lora-incompatible'
                    );

                    assert.strictEqual(loraFindings.length, 1,
                        'Marketplace config with enableLora=true must produce exactly one LoRA rejection finding');
                    assert.strictEqual(loraFindings[0].severity, 'error');
                    assert.strictEqual(loraFindings[0].confidence, 'high');
                    assert.strictEqual(loraFindings[0].source, 'cross-cutting');
                    assert.strictEqual(loraFindings[0].fieldPath, 'enableLora');
                    assert.ok(
                        loraFindings[0].remediationHint.includes('LoRA adapters are not supported for Marketplace model packages'),
                        `Remediation hint must mention LoRA incompatibility, got: "${loraFindings[0].remediationHint}"`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });

        it('for any marketplace config with enableLora="true" (string), a LoRA rejection finding is produced', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.record({
                    modelPackageArn: arbModelPackageArn,
                    instanceType: arbInstanceType,
                    deploymentTarget: arbDeploymentTarget,
                    awsRegion: arbAwsRegion
                }),
                ({ modelPackageArn, instanceType, deploymentTarget, awsRegion }) => {
                    const context = buildContext({
                        architecture: 'marketplace',
                        modelPackageArn,
                        instanceType,
                        awsRegion,
                        enableLora: 'true'
                    }, deploymentTarget);

                    const findings = checker.checkMarketplaceCompatibility(context);

                    const loraFindings = findings.filter(f =>
                        f.constraint && f.constraint.type === 'marketplace-lora-incompatible'
                    );

                    assert.strictEqual(loraFindings.length, 1,
                        'Marketplace config with enableLora="true" (string) must produce exactly one LoRA rejection finding');
                    assert.strictEqual(loraFindings[0].severity, 'error');
                    assert.ok(
                        loraFindings[0].remediationHint.includes('LoRA adapters are not supported for Marketplace model packages'),
                        `Remediation hint must mention LoRA incompatibility, got: "${loraFindings[0].remediationHint}"`
                    );
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });

        it('for any marketplace config with ENABLE_LORA=true (alternate key), a LoRA rejection finding is produced', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.record({
                    modelPackageArn: arbModelPackageArn,
                    instanceType: arbInstanceType,
                    deploymentTarget: arbDeploymentTarget,
                    awsRegion: arbAwsRegion
                }),
                ({ modelPackageArn, instanceType, deploymentTarget, awsRegion }) => {
                    const context = buildContext({
                        architecture: 'marketplace',
                        modelPackageArn,
                        instanceType,
                        awsRegion,
                        ENABLE_LORA: true
                    }, deploymentTarget);

                    const findings = checker.checkMarketplaceCompatibility(context);

                    const loraFindings = findings.filter(f =>
                        f.constraint && f.constraint.type === 'marketplace-lora-incompatible'
                    );

                    assert.strictEqual(loraFindings.length, 1,
                        'Marketplace config with ENABLE_LORA=true must produce exactly one LoRA rejection finding');
                    assert.strictEqual(loraFindings[0].severity, 'error');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });
    });

    describe('enableLora=false with marketplace produces no LoRA rejection', () => {

        it('for any marketplace config with enableLora=false, no LoRA rejection finding is produced', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.record({
                    modelPackageArn: arbModelPackageArn,
                    instanceType: arbInstanceType,
                    deploymentTarget: arbDeploymentTarget,
                    awsRegion: arbAwsRegion
                }),
                ({ modelPackageArn, instanceType, deploymentTarget, awsRegion }) => {
                    const context = buildContext({
                        architecture: 'marketplace',
                        modelPackageArn,
                        instanceType,
                        awsRegion,
                        enableLora: false
                    }, deploymentTarget);

                    const findings = checker.checkMarketplaceCompatibility(context);

                    const loraFindings = findings.filter(f =>
                        f.constraint && f.constraint.type === 'marketplace-lora-incompatible'
                    );

                    assert.strictEqual(loraFindings.length, 0,
                        'Marketplace config with enableLora=false must NOT produce a LoRA rejection finding');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });

        it('for any marketplace config without enableLora set, no LoRA rejection finding is produced', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.record({
                    modelPackageArn: arbModelPackageArn,
                    instanceType: arbInstanceType,
                    deploymentTarget: arbDeploymentTarget,
                    awsRegion: arbAwsRegion
                }),
                ({ modelPackageArn, instanceType, deploymentTarget, awsRegion }) => {
                    const context = buildContext({
                        architecture: 'marketplace',
                        modelPackageArn,
                        instanceType,
                        awsRegion
                        // enableLora intentionally omitted
                    }, deploymentTarget);

                    const findings = checker.checkMarketplaceCompatibility(context);

                    const loraFindings = findings.filter(f =>
                        f.constraint && f.constraint.type === 'marketplace-lora-incompatible'
                    );

                    assert.strictEqual(loraFindings.length, 0,
                        'Marketplace config without enableLora must NOT produce a LoRA rejection finding');
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });
    });

    describe('non-marketplace architecture with enableLora=true produces no marketplace LoRA rejection', () => {

        it('for any non-marketplace architecture with enableLora=true, no marketplace LoRA finding is produced', function () {
            this.timeout(PROPERTY_CONFIG.timeout);

            fc.assert(fc.property(
                fc.record({
                    architecture: fc.constantFrom('transformers-vllm', 'transformers-sglang', 'sklearn-flask', 'xgboost-fastapi'),
                    instanceType: arbInstanceType,
                    deploymentTarget: arbDeploymentTarget,
                    awsRegion: arbAwsRegion
                }),
                ({ architecture, instanceType, deploymentTarget, awsRegion }) => {
                    const context = buildContext({
                        architecture,
                        instanceType,
                        awsRegion,
                        enableLora: true
                    }, deploymentTarget);

                    const findings = checker.checkMarketplaceCompatibility(context);

                    // Non-marketplace architectures should return early with no findings
                    assert.strictEqual(findings.length, 0,
                        `Non-marketplace architecture "${architecture}" with enableLora=true must NOT produce marketplace findings`);
                }
            ), { numRuns: PROPERTY_CONFIG.numRuns, verbose: PROPERTY_CONFIG.verbose, seed: PROPERTY_CONFIG.seed });
        });
    });
});

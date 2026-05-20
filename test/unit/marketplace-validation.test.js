// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Validation Unit Tests
 *
 * Tests the checkMarketplaceCompatibility method in CrossCuttingChecker:
 * - ARN format validation with valid and invalid ARNs
 * - Instance type compatibility check
 * - Deployment target support check
 * - Subscription status verification
 * - LoRA and adapter operation rejection
 *
 * Feature: marketplace-model-packages
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import CrossCuttingChecker from '../../src/lib/cross-cutting-checker.js';

describe('Marketplace Validation (checkMarketplaceCompatibility)', () => {

    const checker = new CrossCuttingChecker();

    // ── Helper to build a marketplace context ────────────────────────────

    function makeContext(overrides = {}) {
        const config = {
            architecture: 'marketplace',
            modelPackageArn: 'arn:aws:sagemaker:us-west-2:123456789012:model-package/my-model/1',
            instanceType: 'ml.g5.xlarge',
            deploymentTarget: 'realtime-inference',
            ...overrides
        };
        return { config, deploymentTarget: config.deploymentTarget };
    }

    // ── ARN Format Validation ────────────────────────────────────────────

    describe('ARN format validation', () => {

        it('valid ARN format produces no findings', () => {
            const context = makeContext({
                modelPackageArn: 'arn:aws:sagemaker:us-west-2:123456789012:model-package/my-model/1'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const arnFindings = findings.filter(f => f.constraint.type === 'arn-format');
            assert.strictEqual(arnFindings.length, 0);
        });

        it('valid ARN with different region and version passes', () => {
            const context = makeContext({
                modelPackageArn: 'arn:aws:sagemaker:eu-west-1:987654321098:model-package/vendor-llm-v2/42'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const arnFindings = findings.filter(f => f.constraint.type === 'arn-format');
            assert.strictEqual(arnFindings.length, 0);
        });

        it('invalid ARN missing region produces error', () => {
            const context = makeContext({
                modelPackageArn: 'arn:aws:sagemaker::123456789012:model-package/my-model/1'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const arnFindings = findings.filter(f => f.constraint.type === 'arn-format');
            assert.strictEqual(arnFindings.length, 1);
            assert.strictEqual(arnFindings[0].severity, 'error');
            assert.ok(arnFindings[0].remediationHint.includes('Invalid model package ARN format'));
        });

        it('invalid ARN with non-numeric account ID produces error', () => {
            const context = makeContext({
                modelPackageArn: 'arn:aws:sagemaker:us-west-2:not-a-number:model-package/my-model/1'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const arnFindings = findings.filter(f => f.constraint.type === 'arn-format');
            assert.strictEqual(arnFindings.length, 1);
            assert.strictEqual(arnFindings[0].severity, 'error');
        });

        it('invalid ARN missing version number produces error', () => {
            const context = makeContext({
                modelPackageArn: 'arn:aws:sagemaker:us-west-2:123456789012:model-package/my-model'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const arnFindings = findings.filter(f => f.constraint.type === 'arn-format');
            assert.strictEqual(arnFindings.length, 1);
        });

        it('completely invalid ARN string produces error', () => {
            const context = makeContext({
                modelPackageArn: 'not-an-arn-at-all'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const arnFindings = findings.filter(f => f.constraint.type === 'arn-format');
            assert.strictEqual(arnFindings.length, 1);
            assert.strictEqual(arnFindings[0].invalidValue, 'not-an-arn-at-all');
        });

        it('empty ARN produces no findings (optional field)', () => {
            const context = makeContext({ modelPackageArn: '' });
            const findings = checker.checkMarketplaceCompatibility(context);
            const arnFindings = findings.filter(f => f.constraint.type === 'arn-format');
            assert.strictEqual(arnFindings.length, 0);
        });
    });

    // ── Instance Type Compatibility ──────────────────────────────────────

    describe('Instance type compatibility check', () => {

        it('instance type in supported list produces no findings', () => {
            const context = makeContext({
                instanceType: 'ml.g5.xlarge',
                _supportedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p3.2xlarge']
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const instanceFindings = findings.filter(f => f.constraint.type === 'marketplace-instance-type');
            assert.strictEqual(instanceFindings.length, 0);
        });

        it('instance type NOT in supported list produces error', () => {
            const context = makeContext({
                instanceType: 'ml.m5.xlarge',
                _supportedInstanceTypes: ['ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.p3.2xlarge']
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const instanceFindings = findings.filter(f => f.constraint.type === 'marketplace-instance-type');
            assert.strictEqual(instanceFindings.length, 1);
            assert.strictEqual(instanceFindings[0].severity, 'error');
            assert.strictEqual(instanceFindings[0].invalidValue, 'ml.m5.xlarge');
            assert.ok(instanceFindings[0].remediationHint.includes('ml.m5.xlarge'));
            assert.ok(instanceFindings[0].remediationHint.includes('ml.g5.xlarge'));
        });

        it('no supported instance types list skips validation (no findings)', () => {
            const context = makeContext({
                instanceType: 'ml.m5.xlarge',
                _supportedInstanceTypes: []
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const instanceFindings = findings.filter(f => f.constraint.type === 'marketplace-instance-type');
            assert.strictEqual(instanceFindings.length, 0);
        });

        it('no instance type specified skips validation (no findings)', () => {
            const context = makeContext({
                instanceType: '',
                _supportedInstanceTypes: ['ml.g5.xlarge']
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const instanceFindings = findings.filter(f => f.constraint.type === 'marketplace-instance-type');
            assert.strictEqual(instanceFindings.length, 0);
        });
    });

    // ── Deployment Target Support ────────────────────────────────────────

    describe('Deployment target support check', () => {

        it('deployment target in supported list produces no findings', () => {
            const context = makeContext({
                deploymentTarget: 'realtime-inference',
                _supportedDeploymentTargets: ['realtime-inference', 'async-inference']
            });
            context.config.deploymentTarget = 'realtime-inference';
            const findings = checker.checkMarketplaceCompatibility(context);
            const targetFindings = findings.filter(f => f.constraint.type === 'marketplace-deployment-target');
            assert.strictEqual(targetFindings.length, 0);
        });

        it('deployment target NOT in supported list produces error', () => {
            const context = makeContext({
                deploymentTarget: 'batch-transform',
                _supportedDeploymentTargets: ['realtime-inference', 'async-inference']
            });
            context.deploymentTarget = 'batch-transform';
            const findings = checker.checkMarketplaceCompatibility(context);
            const targetFindings = findings.filter(f => f.constraint.type === 'marketplace-deployment-target');
            assert.strictEqual(targetFindings.length, 1);
            assert.strictEqual(targetFindings[0].severity, 'error');
            assert.strictEqual(targetFindings[0].invalidValue, 'batch-transform');
            assert.ok(targetFindings[0].remediationHint.includes('batch-transform'));
        });

        it('no supported deployment targets list skips validation (no findings)', () => {
            const context = makeContext({
                deploymentTarget: 'batch-transform',
                _supportedDeploymentTargets: []
            });
            context.deploymentTarget = 'batch-transform';
            const findings = checker.checkMarketplaceCompatibility(context);
            const targetFindings = findings.filter(f => f.constraint.type === 'marketplace-deployment-target');
            assert.strictEqual(targetFindings.length, 0);
        });

        it('no deployment target specified skips validation (no findings)', () => {
            const context = makeContext({
                deploymentTarget: '',
                _supportedDeploymentTargets: ['realtime-inference']
            });
            context.deploymentTarget = '';
            const findings = checker.checkMarketplaceCompatibility(context);
            const targetFindings = findings.filter(f => f.constraint.type === 'marketplace-deployment-target');
            assert.strictEqual(targetFindings.length, 0);
        });
    });

    // ── Subscription Status Verification ─────────────────────────────────

    describe('Subscription status verification', () => {

        it('Active subscription status produces no findings', () => {
            const context = makeContext({
                _marketplacePackageStatus: 'Active'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const statusFindings = findings.filter(f => f.constraint.type === 'subscription-status');
            assert.strictEqual(statusFindings.length, 0);
        });

        it('Completed subscription status produces no findings', () => {
            const context = makeContext({
                _marketplacePackageStatus: 'Completed'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const statusFindings = findings.filter(f => f.constraint.type === 'subscription-status');
            assert.strictEqual(statusFindings.length, 0);
        });

        it('Expired subscription status produces error', () => {
            const context = makeContext({
                _marketplacePackageStatus: 'Expired'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const statusFindings = findings.filter(f => f.constraint.type === 'subscription-status');
            assert.strictEqual(statusFindings.length, 1);
            assert.strictEqual(statusFindings[0].severity, 'error');
            assert.ok(statusFindings[0].remediationHint.includes('Expired'));
            assert.ok(statusFindings[0].remediationHint.includes('not active'));
        });

        it('Cancelled subscription status produces error', () => {
            const context = makeContext({
                _marketplacePackageStatus: 'Cancelled'
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const statusFindings = findings.filter(f => f.constraint.type === 'subscription-status');
            assert.strictEqual(statusFindings.length, 1);
            assert.strictEqual(statusFindings[0].severity, 'error');
            assert.ok(statusFindings[0].remediationHint.includes('Cancelled'));
        });

        it('no status provided skips validation (no findings)', () => {
            const context = makeContext({
                _marketplacePackageStatus: ''
            });
            const findings = checker.checkMarketplaceCompatibility(context);
            const statusFindings = findings.filter(f => f.constraint.type === 'subscription-status');
            assert.strictEqual(statusFindings.length, 0);
        });
    });

    // ── LoRA with Marketplace Rejection ──────────────────────────────────

    describe('LoRA enabled with marketplace produces error', () => {

        it('enableLora=true produces error finding', () => {
            const context = makeContext({ enableLora: true });
            const findings = checker.checkMarketplaceCompatibility(context);
            const loraFindings = findings.filter(f => f.constraint.type === 'marketplace-lora-incompatible');
            assert.strictEqual(loraFindings.length, 1);
            assert.strictEqual(loraFindings[0].severity, 'error');
            assert.ok(loraFindings[0].remediationHint.includes('LoRA adapters are not supported'));
        });

        it('enableLora="true" (string) produces error finding', () => {
            const context = makeContext({ enableLora: 'true' });
            const findings = checker.checkMarketplaceCompatibility(context);
            const loraFindings = findings.filter(f => f.constraint.type === 'marketplace-lora-incompatible');
            assert.strictEqual(loraFindings.length, 1);
        });

        it('enableLora=false produces no findings', () => {
            const context = makeContext({ enableLora: false });
            const findings = checker.checkMarketplaceCompatibility(context);
            const loraFindings = findings.filter(f => f.constraint.type === 'marketplace-lora-incompatible');
            assert.strictEqual(loraFindings.length, 0);
        });
    });

    // ── Adapter Operation on Marketplace Rejection ───────────────────────

    describe('Adapter operation on marketplace produces error', () => {

        it('operation="adapter" produces error finding', () => {
            const context = makeContext({ _operation: 'adapter' });
            const findings = checker.checkMarketplaceCompatibility(context);
            const adapterFindings = findings.filter(f => f.constraint.type === 'marketplace-adapter-incompatible');
            assert.strictEqual(adapterFindings.length, 1);
            assert.strictEqual(adapterFindings[0].severity, 'error');
            assert.ok(adapterFindings[0].remediationHint.includes('Adapter operations are not available'));
        });

        it('operation="do/adapter" produces error finding', () => {
            const context = makeContext({ _operation: 'do/adapter' });
            const findings = checker.checkMarketplaceCompatibility(context);
            const adapterFindings = findings.filter(f => f.constraint.type === 'marketplace-adapter-incompatible');
            assert.strictEqual(adapterFindings.length, 1);
        });

        it('no operation specified produces no findings', () => {
            const context = makeContext({ _operation: '' });
            const findings = checker.checkMarketplaceCompatibility(context);
            const adapterFindings = findings.filter(f => f.constraint.type === 'marketplace-adapter-incompatible');
            assert.strictEqual(adapterFindings.length, 0);
        });
    });

    // ── Non-marketplace architecture skips all checks ────────────────────

    describe('Non-marketplace architecture', () => {

        it('returns empty findings for non-marketplace architecture', () => {
            const context = {
                config: {
                    architecture: 'transformers-vllm',
                    modelPackageArn: 'invalid-arn',
                    enableLora: true
                }
            };
            const findings = checker.checkMarketplaceCompatibility(context);
            assert.strictEqual(findings.length, 0);
        });
    });
});

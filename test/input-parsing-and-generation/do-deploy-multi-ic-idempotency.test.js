// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Multi-IC iteration with per-IC idempotency (Task 2.3)
 *
 * Validates that the deploy template contains the per-IC idempotency logic:
 * - Checks IC_DEPLOYED_NAME before creating each IC
 * - InService → skip
 * - Creating → wait
 * - Failed → recreate
 * - Not set → create new
 * - Fail-fast on IC failure
 * - Summary at end
 *
 * Validates: Requirements 2.2, 2.4, 2.5
 *
 * Feature: multi-ic-endpoints
 */

import fc from 'fast-check';
import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/deploy');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/deploy template with realtime-inference target.
 */
function renderRealtimeDeploy(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        ...overrides
    };
    return ejs.render(templateContent, vars, { filename: templatePath });
}

/** Arbitrary for base config */
const baseConfigArb = fc.record({
    projectName: fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/),
    deploymentConfig: fc.constantFrom('transformers-vllm', 'sklearn-flask', 'xgboost-fastapi'),
    framework: fc.constantFrom('transformers', 'sklearn', 'xgboost', 'tensorflow'),
    modelServer: fc.constantFrom('vllm', 'flask', 'fastapi', 'sglang'),
    awsRegion: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    buildTarget: fc.constant('codebuild')
});

describe('Multi-IC Iteration with Per-IC Idempotency (Task 2.3)', () => {
    before(() => {
        console.log('\n🚀 Starting Multi-IC Per-IC Idempotency Tests');
        console.log('📋 Testing: Requirements 2.2, 2.4, 2.5');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should define _deploy_single_ic function with idempotency logic (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: _deploy_single_ic function with idempotency');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge', 'ml.g6e.48xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must define _deploy_single_ic function
                assert.ok(
                    output.includes('_deploy_single_ic()'),
                    'realtime deploy must define _deploy_single_ic function'
                );

                // Must check IC_DEPLOYED_NAME in the config file
                assert.ok(
                    output.includes('IC_DEPLOYED_NAME='),
                    'realtime deploy must check IC_DEPLOYED_NAME in IC config'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ _deploy_single_ic function defined with idempotency logic');
    });

    it('should skip InService ICs (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: InService ICs are skipped');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must handle InService case — skip
                assert.ok(
                    output.includes('InService)'),
                    'realtime deploy must handle InService case in per-IC idempotency'
                );
                assert.ok(
                    output.includes('already InService') && output.includes('skipping'),
                    'realtime deploy must print skip message for InService ICs'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ InService ICs are skipped');
    });

    it('should wait for Creating ICs (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: Creating ICs are waited on');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must handle Creating case — wait
                assert.ok(
                    output.includes('Creating)'),
                    'realtime deploy must handle Creating case in per-IC idempotency'
                );
                assert.ok(
                    output.includes('still Creating') && output.includes('waiting'),
                    'realtime deploy must print waiting message for Creating ICs'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Creating ICs are waited on');
    });

    it('should recreate Failed ICs (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: Failed ICs are recreated');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must handle Failed case — recreate
                assert.ok(
                    output.includes('Failed)'),
                    'realtime deploy must handle Failed case in per-IC idempotency'
                );
                assert.ok(
                    output.includes('previously Failed') && output.includes('recreating'),
                    'realtime deploy must print recreating message for Failed ICs'
                );
                // Must call create_inference_component for Failed ICs
                assert.ok(
                    output.includes('create_inference_component "${ic_conf}"'),
                    'realtime deploy must call create_inference_component for Failed ICs'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Failed ICs are recreated');
    });

    it('should create new ICs when IC_DEPLOYED_NAME is not set (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: New ICs created when IC_DEPLOYED_NAME not set');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must handle case where IC_DEPLOYED_NAME is not set
                assert.ok(
                    output.includes('No previous deployment') && output.includes('create new IC'),
                    'realtime deploy must create new IC when IC_DEPLOYED_NAME is not set'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ New ICs created when IC_DEPLOYED_NAME not set');
    });

    it('should use _get_ic_status to check IC state (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: Uses _get_ic_status for status check');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must call _get_ic_status to check current state
                assert.ok(
                    output.includes('_get_ic_status'),
                    'realtime deploy must call _get_ic_status to check IC state'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Uses _get_ic_status for status check');
    });

    it('should fail-fast when an IC fails (Req 2.5)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.5: Fail-fast on IC failure');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must have fail-fast logic
                assert.ok(
                    output.includes('IC_DEPLOY_FAILED'),
                    'realtime deploy must track IC deployment failure'
                );
                assert.ok(
                    output.includes('failed to deploy') && output.includes('Stopping'),
                    'realtime deploy must stop on IC failure'
                );
                assert.ok(
                    output.includes('break'),
                    'realtime deploy must break out of loop on IC failure'
                );
                // Must exit with error code on failure
                assert.ok(
                    output.includes('Deployment stopped due to IC failure'),
                    'realtime deploy must report failure and exit'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Fail-fast on IC failure');
    });

    it('should print summary at end of multi-IC deployment (Req 2.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.2: Summary at end of multi-IC deployment');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must print summary
                assert.ok(
                    output.includes('IC Deployment Summary'),
                    'realtime deploy must print IC deployment summary'
                );
                assert.ok(
                    output.includes('IC_SUMMARY'),
                    'realtime deploy must build IC_SUMMARY string'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Summary printed at end of multi-IC deployment');
    });

    it('should iterate ICs in alphabetical order via glob (Req 2.2)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.2: ICs iterated in alphabetical order');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Glob expansion gives alphabetical order
                assert.ok(
                    output.includes('for conf in "${SCRIPT_DIR}"/ic/*.conf'),
                    'realtime deploy must use glob to iterate IC configs (alphabetical order)'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ ICs iterated in alphabetical order via glob');
    });

    it('should apply idempotency to single IC target as well (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: Single IC target also uses idempotency');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Single IC target must also use _deploy_single_ic
                assert.ok(
                    output.includes('_deploy_single_ic "${SCRIPT_DIR}/ic/${IC_TARGET}.conf"'),
                    'single IC target must use _deploy_single_ic for idempotency'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Single IC target also uses idempotency');
    });

    it('should call wait_ic after creating or recreating an IC (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: wait_ic called after IC creation');

        fc.assert(fc.property(
            baseConfigArb,
            fc.constantFrom('ml.m5.xlarge', 'ml.g5.xlarge'),
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // _deploy_single_ic must call wait_ic
                assert.ok(
                    output.includes('wait_ic "${IC_DEPLOYED_NAME}"'),
                    'realtime deploy must call wait_ic after IC creation'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ wait_ic called after IC creation');
    });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for GPU capacity guardrail (Task 2.6)
 *
 * Validates that the deploy template contains the _check_gpu_capacity function:
 * - Sums IC_GPU_COUNT across all do/ic/*.conf files
 * - Compares against known GPU count for INSTANCE_TYPE from hardcoded map
 * - Warns (not errors) if total exceeds instance capacity
 * - Skips check if instance type not in map
 * - Only runs when do/ic/ directory exists (multi-IC mode)
 *
 * Validates: Requirements 2.4, 2.5
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
    return ejs.render(templateContent, vars);
}

/**
 * Render the do/deploy template with async-inference target.
 */
function renderAsyncDeploy(overrides = {}) {
    const vars = {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'async-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        asyncS3OutputPath: '',
        asyncSnsSuccessTopic: '',
        asyncSnsErrorTopic: '',
        asyncMaxConcurrentInvocations: undefined,
        ...overrides
    };
    return ejs.render(templateContent, vars);
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

/** Known GPU instance types from the hardcoded map */
const gpuInstanceTypes = fc.constantFrom(
    'ml.g4dn.xlarge', 'ml.g4dn.12xlarge',
    'ml.g5.xlarge', 'ml.g5.12xlarge', 'ml.g5.48xlarge',
    'ml.g6.xlarge', 'ml.g6.12xlarge', 'ml.g6.48xlarge',
    'ml.g6e.xlarge', 'ml.g6e.12xlarge', 'ml.g6e.48xlarge',
    'ml.p3.2xlarge', 'ml.p3.8xlarge', 'ml.p3.16xlarge',
    'ml.p4d.24xlarge', 'ml.p4de.24xlarge', 'ml.p5.48xlarge'
);

describe('GPU Capacity Guardrail (Task 2.6)', () => {
    before(() => {
        console.log('\n🚀 Starting GPU Capacity Guardrail Tests');
        console.log('📋 Testing: Requirements 2.4, 2.5');
        console.log('🔧 Configuration: EJS template rendering with fast-check\n');
    });

    it('should define _check_gpu_capacity function in realtime deploy (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: _check_gpu_capacity function defined');

        fc.assert(fc.property(
            baseConfigArb,
            gpuInstanceTypes,
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must define _check_gpu_capacity function
                assert.ok(
                    output.includes('_check_gpu_capacity()'),
                    'realtime deploy must define _check_gpu_capacity function'
                );
            }
        ), { numRuns: 30 });

        console.log('    ✅ _check_gpu_capacity function defined');
    });

    it('should call _check_gpu_capacity before IC deployment loop (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: _check_gpu_capacity called before IC deployment');

        fc.assert(fc.property(
            baseConfigArb,
            gpuInstanceTypes,
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // _check_gpu_capacity must be called
                const callIndex = output.indexOf('_check_gpu_capacity\n');
                assert.ok(
                    callIndex !== -1 || output.includes('_check_gpu_capacity\n') || output.match(/_check_gpu_capacity\s*\n/),
                    'realtime deploy must call _check_gpu_capacity'
                );

                // Must be called before _deploy_single_ic
                const guardrailCallMatch = output.match(/# Run capacity guardrail before deploying ICs/);
                const deployIcMatch = output.match(/_deploy_single_ic/);
                assert.ok(
                    guardrailCallMatch && deployIcMatch,
                    'capacity guardrail must be called before IC deployment'
                );
                assert.ok(
                    guardrailCallMatch.index < deployIcMatch.index,
                    '_check_gpu_capacity must appear before _deploy_single_ic'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ _check_gpu_capacity called before IC deployment loop');
    });

    it('should contain hardcoded GPU map with common instance types (Req 2.5)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.5: Hardcoded GPU map with common instance types');

        const output = renderRealtimeDeploy();

        // Check that the GPU map contains expected entries (case statement format)
        const expectedEntries = [
            ['ml.g4dn.xlarge', '1'],
            ['ml.g4dn.12xlarge', '4'],
            ['ml.g5.xlarge', '1'],
            ['ml.g5.12xlarge', '4'],
            ['ml.g5.48xlarge', '8'],
            ['ml.g6.xlarge', '1'],
            ['ml.g6.12xlarge', '4'],
            ['ml.g6.48xlarge', '8'],
            ['ml.g6e.xlarge', '1'],
            ['ml.g6e.12xlarge', '4'],
            ['ml.g6e.48xlarge', '8'],
            ['ml.p3.2xlarge', '1'],
            ['ml.p3.8xlarge', '4'],
            ['ml.p3.16xlarge', '8'],
            ['ml.p4d.24xlarge', '8'],
            ['ml.p4de.24xlarge', '8'],
            ['ml.p5.48xlarge', '8']
        ];

        for (const [instanceType, gpuCount] of expectedEntries) {
            // Case statement format: ml.g4dn.xlarge)     instance_gpus=1 ;;
            const pattern = `${instanceType})`;
            const gpuPattern = `instance_gpus=${gpuCount}`;
            assert.ok(
                output.includes(pattern) && output.includes(gpuPattern),
                `GPU map must contain ${instanceType}=${gpuCount}`
            );
        }

        console.log('    ✅ Hardcoded GPU map contains all expected instance types');
    });

    it('should sum IC_GPU_COUNT from all conf files (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: Sums IC_GPU_COUNT from all conf files');

        fc.assert(fc.property(
            baseConfigArb,
            gpuInstanceTypes,
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must iterate IC config files to sum GPU counts
                assert.ok(
                    output.includes('IC_GPU_COUNT='),
                    'capacity guardrail must read IC_GPU_COUNT from config files'
                );
                assert.ok(
                    output.includes('total_gpu_requested'),
                    'capacity guardrail must track total GPU requested'
                );
                // Must iterate over conf files
                assert.ok(
                    output.includes('for conf in "${SCRIPT_DIR}"/ic/*.conf'),
                    'capacity guardrail must iterate over IC conf files'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Sums IC_GPU_COUNT from all conf files');
    });

    it('should warn (not error/exit) when GPU total exceeds capacity (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: Warns but does not exit on over-subscription');

        fc.assert(fc.property(
            baseConfigArb,
            gpuInstanceTypes,
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must contain warning message (not exit)
                assert.ok(
                    output.includes('GPU capacity warning'),
                    'capacity guardrail must print GPU capacity warning'
                );
                // Must NOT contain exit in the guardrail function
                const funcStart = output.indexOf('_check_gpu_capacity()');
                const funcEnd = output.indexOf('# Run capacity guardrail before deploying ICs');
                const funcBody = output.substring(funcStart, funcEnd);
                assert.ok(
                    !funcBody.includes('exit'),
                    'capacity guardrail must NOT exit — only warn'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Warns but does not exit on over-subscription');
    });

    it('should skip check when instance type is not in the GPU map (Req 2.5)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.5: Skips check for unknown instance types');

        fc.assert(fc.property(
            baseConfigArb,
            gpuInstanceTypes,
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // Must check if instance type is in map and return early if not
                assert.ok(
                    output.includes('if [ -z "${instance_gpus}" ]'),
                    'capacity guardrail must check if instance type is in GPU map'
                );
                assert.ok(
                    output.includes('return 0'),
                    'capacity guardrail must return 0 (skip) for unknown instance types'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Skips check for unknown instance types');
    });

    it('should only run in multi-IC mode (inside do/ic/ check) (Req 2.5)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.5: Only runs when do/ic/ directory exists');

        fc.assert(fc.property(
            baseConfigArb,
            gpuInstanceTypes,
            (base, instanceType) => {
                const output = renderRealtimeDeploy({
                    ...base,
                    instanceType
                });

                // _check_gpu_capacity must be inside the if [ -d "${SCRIPT_DIR}/ic" ] block
                const icDirCheck = output.indexOf('if [ -d "${SCRIPT_DIR}/ic" ]; then');
                const guardrailDef = output.indexOf('_check_gpu_capacity()');
                assert.ok(
                    icDirCheck !== -1 && guardrailDef !== -1,
                    'both ic dir check and guardrail must exist'
                );
                assert.ok(
                    guardrailDef > icDirCheck,
                    '_check_gpu_capacity must be inside the do/ic/ directory check block'
                );
            }
        ), { numRuns: 20 });

        console.log('    ✅ Only runs when do/ic/ directory exists');
    });

    it('should NOT contain capacity guardrail in async deploy (Req 2.5)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.5: Capacity guardrail not in async deploy');

        fc.assert(fc.property(
            baseConfigArb,
            gpuInstanceTypes,
            (base, instanceType) => {
                const output = renderAsyncDeploy({
                    ...base,
                    instanceType
                });

                // Async deploy must NOT contain the capacity guardrail
                assert.ok(
                    !output.includes('_check_gpu_capacity'),
                    'async deploy must NOT contain _check_gpu_capacity'
                );
            }
        ), { numRuns: 10 });

        console.log('    ✅ Capacity guardrail not in async deploy');
    });

    it('should use case statement for GPU lookup (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: Uses case statement for GPU lookup');

        const output = renderRealtimeDeploy();

        assert.ok(
            output.includes('case "${INSTANCE_TYPE}" in'),
            'capacity guardrail must use case statement for GPU lookup'
        );

        console.log('    ✅ Uses case statement for GPU lookup');
    });

    it('should include helpful warning message with instance type and GPU counts (Req 2.4)', function () {
        this.timeout(30000);

        console.log('  🧪 Req 2.4: Warning message includes useful details');

        const output = renderRealtimeDeploy();

        // Warning should mention the total requested and instance capacity
        assert.ok(
            output.includes('${total_gpu_requested}') && output.includes('${INSTANCE_TYPE}'),
            'warning message must include total GPU requested and instance type'
        );
        assert.ok(
            output.includes('${instance_gpus}'),
            'warning message must include instance GPU capacity'
        );

        console.log('    ✅ Warning message includes useful details');
    });
});

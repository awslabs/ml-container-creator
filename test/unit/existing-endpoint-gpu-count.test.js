// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verification test for task 18.4:
 * Generating with `--existing-endpoint <multi-gpu-endpoint>` sets IC_GPU_COUNT=4 (not 1).
 *
 * Tests the end-to-end resolution chain:
 * 1. Endpoint metadata resolves to instanceType 'ml.g5.24xlarge'
 * 2. gpuCount is derived as 4 from the instance catalog
 * 3. template-variable-resolver sets icGpuCount = 4
 * 4. IC_GPU_COUNT in generated output would be 4
 *
 * Validates: Requirements US-1 (GPU count from existing endpoint)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _ensureTemplateVariables } from '../../src/lib/template-variable-resolver.js';
import McpQueryRunner from '../../src/lib/mcp-query-runner.js';

describe('Existing endpoint GPU count → IC_GPU_COUNT derivation (Task 18.4)', () => {

    describe('template-variable-resolver: icGpuCount from gpuCount (existing endpoint path)', () => {

        it('sets icGpuCount=4 when gpuCount=4 is provided (endpoint resolved)', async () => {
            // Simulates the state after prompt-runner.js resolves existing endpoint:
            // existingEndpointAnswers.instanceType = 'ml.g5.24xlarge'
            // existingEndpointAnswers.gpuCount = 4
            const answers = {
                instanceType: 'ml.g5.24xlarge',
                gpuCount: 4,
                backend: 'vllm'
            };

            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 4,
                'icGpuCount should be 4 for ml.g5.24xlarge (4 GPUs), not 1');
        });

        it('sets icGpuCount=8 when gpuCount=8 is provided (e.g., ml.g5.48xlarge)', async () => {
            const answers = {
                instanceType: 'ml.g5.48xlarge',
                gpuCount: 8,
                backend: 'vllm'
            };

            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 8,
                'icGpuCount should be 8 for ml.g5.48xlarge (8 GPUs)');
        });

        it('sets icGpuCount=1 for single-GPU endpoint (ml.g5.xlarge)', async () => {
            const answers = {
                instanceType: 'ml.g5.xlarge',
                gpuCount: 1,
                backend: 'vllm'
            };

            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 1,
                'icGpuCount should be 1 for ml.g5.xlarge (1 GPU)');
        });
    });

    describe('template-variable-resolver: icGpuCount from instance catalog lookup', () => {

        it('derives icGpuCount=4 from instances.json when gpuCount not pre-set', async () => {
            // When gpuCount is NOT passed (e.g., older path or fallback), the resolver
            // looks up the instance catalog directly.
            const answers = {
                instanceType: 'ml.g5.24xlarge',
                backend: 'vllm'
            };

            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 4,
                'icGpuCount should be derived as 4 from instances.json catalog for ml.g5.24xlarge');
        });

        it('derives icGpuCount=8 from catalog for ml.g5.48xlarge', async () => {
            const answers = {
                instanceType: 'ml.g5.48xlarge',
                backend: 'vllm'
            };

            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 8,
                'icGpuCount should be derived as 8 from instances.json catalog for ml.g5.48xlarge');
        });

        it('does NOT override icGpuCount when already explicitly set', async () => {
            // User may intentionally use fewer GPUs (sharing endpoint across multiple ICs)
            const answers = {
                instanceType: 'ml.g5.24xlarge',
                icGpuCount: 2,
                backend: 'vllm'
            };

            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 2,
                'icGpuCount should NOT be overwritten when already explicitly set');
        });
    });

    describe('prompt-runner: endpoint metadata → instanceType + gpuCount resolution', () => {

        it('resolves instanceType and gpuCount from endpoint-picker metadata', async () => {
            // Simulate the prompt-runner.js flow for existing endpoints (task 18.2):
            // 1. _endpointPickerMetadata stores endpoint info from MCP
            // 2. _resolveEndpointInstanceType extracts instanceType
            // 3. prompt-runner looks up gpuCount from instance catalog

            const runner = {
                _endpointPickerMetadata: {
                    'my-multi-gpu-endpoint': {
                        instanceType: 'ml.g5.24xlarge',
                        instanceCount: 1,
                        icCount: 2,
                        availableGpus: 4
                    }
                },
                configManager: { config: {} },
                options: {},
                _runPrompts: async () => ({})
            };
            const queryRunner = new McpQueryRunner(runner);

            // Step 1: Resolve instance type from endpoint metadata
            const resolvedInstanceType = await queryRunner._resolveEndpointInstanceType(
                'my-multi-gpu-endpoint', 'us-east-1'
            );
            assert.equal(resolvedInstanceType, 'ml.g5.24xlarge',
                'Should resolve instance type from endpoint metadata');

            // Step 2: Simulate what prompt-runner does — derive gpuCount from catalog
            // This mirrors the logic in prompt-runner.js lines ~430-440
            const answers = {
                instanceType: resolvedInstanceType,
                gpuCount: 4, // Set by prompt-runner from instanceCatalogRaw[resolvedInstanceType].gpus
                backend: 'vllm'
            };

            // Step 3: template-variable-resolver derives icGpuCount
            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 4,
                'IC_GPU_COUNT should be 4 for existing endpoint with ml.g5.24xlarge (4 GPUs)');
            assert.equal(answers.tensorParallelSize, 4,
                'tensorParallelSize should also be 4 for multi-GPU endpoint');
        });

        it('full chain: endpoint with ml.p5.48xlarge → IC_GPU_COUNT=8', async () => {
            const runner = {
                _endpointPickerMetadata: {
                    'large-gpu-endpoint': {
                        instanceType: 'ml.p5.48xlarge',
                        instanceCount: 1,
                        icCount: 0,
                        availableGpus: 8
                    }
                },
                configManager: { config: {} },
                options: {},
                _runPrompts: async () => ({})
            };
            const queryRunner = new McpQueryRunner(runner);

            const resolvedInstanceType = await queryRunner._resolveEndpointInstanceType(
                'large-gpu-endpoint', 'us-west-2'
            );
            assert.equal(resolvedInstanceType, 'ml.p5.48xlarge');

            const answers = {
                instanceType: resolvedInstanceType,
                gpuCount: 8,
                backend: 'sglang'
            };

            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 8,
                'IC_GPU_COUNT should be 8 for existing endpoint with ml.p5.48xlarge');
        });

        it('endpoint resolution failure → icGpuCount defaults via catalog if instanceType known', async () => {
            // Even if endpoint metadata is absent, if instanceType was somehow set
            // (e.g., from CLI), icGpuCount should still be derived from the catalog.
            const answers = {
                instanceType: 'ml.g5.24xlarge',
                backend: 'vllm'
                // gpuCount NOT set — simulates fallback path
            };

            await _ensureTemplateVariables(answers, null);

            assert.equal(answers.icGpuCount, 4,
                'Should fall back to instance catalog lookup when gpuCount not explicitly provided');
        });
    });
});

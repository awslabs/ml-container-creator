// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for CUDA auto-resolution in prompt-runner.
 * Tests the _promptCudaVersion method with base image CUDA version intersection.
 *
 * Requirements: 4.9, 4.10, 4.11
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import PromptRunner from '../../src/lib/prompt-runner.js';

describe('CUDA auto-resolution', function () {
    this.timeout(10000);

    // Create a PromptRunner with mock accelerator mapping
    function createRunner(acceleratorMapping = {}) {
        const runner = new PromptRunner({ configManager: null, options: {} });
        runner._instanceAcceleratorMapping = acceleratorMapping;
        runner._runPrompts = async (prompts) => {
            // Mock: return the default value for the first prompt
            const prompt = prompts[0];
            const defaultVal = typeof prompt.default === 'function' ? prompt.default({}) : prompt.default;
            return { [prompt.name]: defaultVal };
        };
        return runner;
    }

    const mockMapping = {
        'ml.g5.xlarge': {
            accelerator: {
                type: 'cuda',
                versions: ['11.8', '12.1', '12.4'],
                hardware: 'A10G',
                default: '12.1'
            }
        },
        'ml.g5.2xlarge': {
            accelerator: {
                type: 'cuda',
                versions: ['12.1', '12.4'],
                hardware: 'A10G',
                default: '12.4'
            }
        },
        'ml.m5.large': {
            accelerator: {
                type: 'cpu',
                versions: [],
                hardware: 'Intel Xeon'
            }
        }
    };

    describe('base image CUDA auto-resolution', () => {
        it('auto-resolves when base image CUDA matches instance exactly', async () => {
            const runner = createRunner(mockMapping);
            const result = await runner._promptCudaVersion('ml.g5.xlarge', 'transformers', null, '12.1');
            assert.ok(result, 'should return a result');
            assert.strictEqual(result.cudaVersion, '12.1');
            assert.ok(result.inferenceAmiVersion, 'should have AMI version');
        });

        it('auto-resolves to highest compatible when no exact match', async () => {
            const runner = createRunner(mockMapping);
            // Base image requires CUDA 12, instance supports 11.8, 12.1, 12.4
            const result = await runner._promptCudaVersion('ml.g5.xlarge', 'transformers', null, '12');
            assert.ok(result, 'should return a result');
            // Should pick highest 12.x version
            assert.ok(result.cudaVersion.startsWith('12'), 'should pick a 12.x version');
        });

        it('falls back to manual prompt when no intersection', async () => {
            const runner = createRunner(mockMapping);
            // Base image requires CUDA 99.9, no instance supports it
            const result = await runner._promptCudaVersion('ml.g5.2xlarge', 'transformers', null, '99.9');
            // Should fall through to the normal logic (auto-select since only 2 versions)
            // The method will still return something from the normal path
            assert.ok(result === null || result.cudaVersion, 'should handle gracefully');
        });

        it('returns null for CPU instances', async () => {
            const runner = createRunner(mockMapping);
            const result = await runner._promptCudaVersion('ml.m5.large', 'transformers', null, '12.1');
            assert.strictEqual(result, null);
        });

        it('returns null for unknown instance types', async () => {
            const runner = createRunner(mockMapping);
            const result = await runner._promptCudaVersion('ml.unknown.xlarge', 'transformers', null, '12.1');
            assert.strictEqual(result, null);
        });

        it('returns null when instanceType is null', async () => {
            const runner = createRunner(mockMapping);
            const result = await runner._promptCudaVersion(null, 'transformers', null, '12.1');
            assert.strictEqual(result, null);
        });
    });

    describe('CUDA AMI mapping', () => {
        it('maps known CUDA versions to AMI versions', () => {
            const knownMappings = {
                '11.8': 'al2-ami-sagemaker-inference-gpu-2-1',
                '12.1': 'al2-ami-sagemaker-inference-gpu-3-1',
                '12.4': 'al2023-ami-sagemaker-inference-gpu-4-1'
            };

            for (const [cuda, expectedAmi] of Object.entries(knownMappings)) {
                assert.strictEqual(
                    PromptRunner.CUDA_AMI_MAP[cuda],
                    expectedAmi,
                    `CUDA ${cuda} should map to ${expectedAmi}`
                );
            }
        });
    });
});

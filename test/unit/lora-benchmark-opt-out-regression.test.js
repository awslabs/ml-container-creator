// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test: explicit --enable-lora=false --include-benchmark=false
 * reproduces pre-v1 output (AC-2.7).
 *
 * With v1 defaults, LoRA and benchmark are enabled by default for transformers.
 * Users can explicitly opt out via CLI flags to reproduce the pre-v1 behavior.
 *
 * Feature: lora-benchmark-simplification
 * Validates: Requirements 2.4, 2.7
 */

import { describe, it, afterEach } from 'mocha';
import { runGenerator } from '../helpers/run-generator.js';

describe('AC-2.7: Explicit opt-out reproduces pre-v1 behavior', function () {
    this.timeout(60000);

    let result;

    afterEach(() => {
        if (result) {
            result.cleanup();
            result = null;
        }
    });

    describe('--enable-lora=false --include-benchmark=false on transformers-vllm', () => {
        beforeEach(() => {
            result = runGenerator({
                'project-name': 'test-opt-out',
                'deployment-config': 'transformers-vllm',
                'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1',
                'enable-lora': false,
                'include-benchmark': false
            });
        });

        it('does NOT generate do/adapter script', () => {
            result.assertNoFile('do/adapter');
        });

        it('does NOT generate do/adapters/ directory', () => {
            result.assertNoFile('do/adapters/.gitkeep');
        });

        it('does NOT generate do/benchmark script', () => {
            result.assertNoFile('do/benchmark');
        });

        it('does NOT generate do/optimize script', () => {
            result.assertNoFile('do/optimize');
        });
    });

    describe('default behavior (no explicit flags) on transformers-vllm produces LoRA and benchmark', () => {
        beforeEach(() => {
            result = runGenerator({
                'project-name': 'test-defaults',
                'deployment-config': 'transformers-vllm',
                'model-name': 'meta-llama/Llama-3.1-8B-Instruct',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1'
            });
        });

        it('generates do/adapter script (LoRA enabled by default)', () => {
            result.assertFile('do/adapter');
        });

        it('generates do/adapters/ directory (LoRA enabled by default)', () => {
            result.assertFile('do/adapters/.gitkeep');
        });

        it('generates do/benchmark script (benchmark enabled by default)', () => {
            result.assertFile('do/benchmark');
        });
    });
});

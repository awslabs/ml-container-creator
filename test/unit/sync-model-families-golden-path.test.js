// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for loadBenchmarkEligibility() in sync-model-families.js
 * Tests the golden-path eligibility cross-reference logic (Task 14).
 *
 * Requirements: 10.13, 10.14
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadBenchmarkEligibility } from '../../scripts/sync-model-families.js';

describe('loadBenchmarkEligibility', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = path.join(os.tmpdir(), `mcc-test-benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(tmpDir)) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('returns empty Set when schema registry path does not exist', () => {
        const result = loadBenchmarkEligibility('/nonexistent/path/schemas');
        assert.ok(result instanceof Set);
        assert.strictEqual(result.size, 0);
    });

    it('returns empty Set when sagemaker service model is missing', () => {
        // Create registry dir but no sagemaker subdirectory
        mkdirSync(path.join(tmpDir, 'iam'), { recursive: true });
        writeFileSync(path.join(tmpDir, 'iam', 'service-2.json'), '{}', 'utf8');

        const result = loadBenchmarkEligibility(tmpDir);
        assert.ok(result instanceof Set);
        assert.strictEqual(result.size, 0);
    });

    it('returns empty Set when service model does not have CreateAIBenchmarkJob', () => {
        // Create a sagemaker service model without benchmark operations
        const sagemakerDir = path.join(tmpDir, 'sagemaker');
        mkdirSync(sagemakerDir, { recursive: true });
        writeFileSync(path.join(sagemakerDir, 'service-2.json'), JSON.stringify({
            operations: {
                CreateEndpoint: { input: { shape: 'CreateEndpointInput' } }
            },
            shapes: {
                CreateEndpointInput: { type: 'structure', members: {} }
            }
        }), 'utf8');

        const result = loadBenchmarkEligibility(tmpDir);
        assert.ok(result instanceof Set);
        assert.strictEqual(result.size, 0);
    });

    it('returns golden-path models when benchmark shape is available', () => {
        // Create a sagemaker service model WITH benchmark operations
        const sagemakerDir = path.join(tmpDir, 'sagemaker');
        mkdirSync(sagemakerDir, { recursive: true });
        writeFileSync(path.join(sagemakerDir, 'service-2.json'), JSON.stringify({
            operations: {
                CreateAIBenchmarkJob: { input: { shape: 'CreateAIBenchmarkJobRequest' } }
            },
            shapes: {
                CreateAIBenchmarkJobRequest: { type: 'structure', members: {} }
            }
        }), 'utf8');

        const result = loadBenchmarkEligibility(tmpDir);
        assert.ok(result instanceof Set);
        // Should return a non-empty set since the real e2e-catalog.json exists
        assert.ok(result.size > 0, 'Should find golden-path models from e2e-catalog.json');
    });

    it('returns Set containing known tuneIds from e2e-catalog', () => {
        // Create a sagemaker service model WITH benchmark operations
        const sagemakerDir = path.join(tmpDir, 'sagemaker');
        mkdirSync(sagemakerDir, { recursive: true });
        writeFileSync(path.join(sagemakerDir, 'service-2.json'), JSON.stringify({
            operations: {
                CreateAIBenchmarkJob: { input: { shape: 'CreateAIBenchmarkJobRequest' } }
            },
            shapes: {
                CreateAIBenchmarkJobRequest: { type: 'structure', members: {} }
            }
        }), 'utf8');

        const result = loadBenchmarkEligibility(tmpDir);
        assert.ok(result instanceof Set);

        // Verify known golden-path models from e2e-catalog.json are present
        assert.ok(result.has('huggingface-reasoning-qwen3-06b'), 'Should include Qwen3 0.6B');
        assert.ok(result.has('meta-textgeneration-llama-3-2-1b-instruct'), 'Should include Llama 3.2 1B');
        assert.ok(result.has('deepseek-llm-r1-distill-qwen-1-5b'), 'Should include DeepSeek R1 Qwen 1.5B');
    });

    it('detects benchmark support via CreateAIBenchmarkJobRequest shape (without operation)', () => {
        // Some service models may have the shape but not the operation listed
        const sagemakerDir = path.join(tmpDir, 'sagemaker');
        mkdirSync(sagemakerDir, { recursive: true });
        writeFileSync(path.join(sagemakerDir, 'service-2.json'), JSON.stringify({
            operations: {},
            shapes: {
                CreateAIBenchmarkJobRequest: { type: 'structure', members: {} }
            }
        }), 'utf8');

        const result = loadBenchmarkEligibility(tmpDir);
        assert.ok(result instanceof Set);
        assert.ok(result.size > 0, 'Should detect benchmark support via shape name');
    });

    it('returns empty Set when service model JSON is malformed', () => {
        const sagemakerDir = path.join(tmpDir, 'sagemaker');
        mkdirSync(sagemakerDir, { recursive: true });
        writeFileSync(path.join(sagemakerDir, 'service-2.json'), 'not valid json{{{', 'utf8');

        const result = loadBenchmarkEligibility(tmpDir);
        assert.ok(result instanceof Set);
        assert.strictEqual(result.size, 0);
    });
});

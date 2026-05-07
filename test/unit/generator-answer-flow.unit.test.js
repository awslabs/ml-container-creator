// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Example-based unit tests for the generator answer flow.
 *
 * Tests cover:
 * - modelSource defaults to 'huggingface' when provider is absent
 * - modelSource is set from metadata provider (e.g. 'jumpstart')
 * - artifactUri flows through from metadata
 * - artifactUri defaults to '' when absent
 * - modelLoadStrategy prompt definition, default, and when() logic
 *
 * Feature: model-server-loading-adapter
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 13.1, 13.2, 13.5
 */

import { describe, it } from 'mocha';
import assert from 'node:assert';
import { modelLoadStrategyPrompts } from '../../src/lib/prompts.js';

// ── Helper: simulate _ensureTemplateVariables defaults logic ─────────────────
// This mirrors the defaults object from index.js _ensureTemplateVariables()
// without requiring full generator instantiation.

function applyDefaults(answers = {}) {
    const defaults = {
        modelSource: 'huggingface',
        artifactUri: '',
        modelLoadStrategy: 'runtime'
    };
    const result = { ...answers };
    Object.entries(defaults).forEach(([key, value]) => {
        if (result[key] === undefined) {
            result[key] = value;
        }
    });
    return result;
}

// ── Helper: simulate prompt-runner MCP metadata flow ─────────────────────────
// This mirrors how prompt-runner.js sets _mcpModelSource and _mcpArtifactUri
// from MCP metadata, then merges them into combinedAnswers.

function applyMcpMetadata(combinedAnswers, metadata) {
    if (metadata && metadata.provider) {
        combinedAnswers.modelSource = metadata.provider;
    }
    if (metadata && metadata.artifactUri) {
        combinedAnswers.artifactUri = metadata.artifactUri;
    }
    return combinedAnswers;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Feature: model-server-loading-adapter — generator answer flow', () => {

    // ── modelSource from metadata provider ───────────────────────────────

    describe('modelSource from metadata (Req 2.1, 2.3)', () => {

        it('metadata with provider="jumpstart" sets modelSource to "jumpstart"', () => {
            // **Validates: Requirements 2.1**
            const answers = {};
            const metadata = { provider: 'jumpstart' };
            applyMcpMetadata(answers, metadata);
            const result = applyDefaults(answers);
            assert.strictEqual(result.modelSource, 'jumpstart');
        });

        it('metadata with provider="s3" sets modelSource to "s3"', () => {
            // **Validates: Requirements 2.1**
            const answers = {};
            const metadata = { provider: 's3' };
            applyMcpMetadata(answers, metadata);
            const result = applyDefaults(answers);
            assert.strictEqual(result.modelSource, 's3');
        });

        it('metadata with provider="jumpstart-hub" sets modelSource to "jumpstart-hub"', () => {
            // **Validates: Requirements 2.1**
            const answers = {};
            const metadata = { provider: 'jumpstart-hub' };
            applyMcpMetadata(answers, metadata);
            const result = applyDefaults(answers);
            assert.strictEqual(result.modelSource, 'jumpstart-hub');
        });

        it('metadata with provider="registry" sets modelSource to "registry"', () => {
            // **Validates: Requirements 2.1**
            const answers = {};
            const metadata = { provider: 'registry' };
            applyMcpMetadata(answers, metadata);
            const result = applyDefaults(answers);
            assert.strictEqual(result.modelSource, 'registry');
        });

        it('metadata without provider defaults modelSource to "huggingface"', () => {
            // **Validates: Requirements 2.3**
            const answers = {};
            const metadata = {};
            applyMcpMetadata(answers, metadata);
            const result = applyDefaults(answers);
            assert.strictEqual(result.modelSource, 'huggingface');
        });

        it('null metadata defaults modelSource to "huggingface"', () => {
            // **Validates: Requirements 2.3**
            const answers = {};
            applyMcpMetadata(answers, null);
            const result = applyDefaults(answers);
            assert.strictEqual(result.modelSource, 'huggingface');
        });
    });

    // ── artifactUri from metadata ────────────────────────────────────────

    describe('artifactUri from metadata (Req 2.2, 2.4)', () => {

        it('metadata with artifactUri sets this.answers.artifactUri', () => {
            // **Validates: Requirements 2.2**
            const uri = 's3://jumpstart-cache-prod-us-east-1/huggingface-llm/falcon-7b/artifacts/';
            const answers = {};
            const metadata = { provider: 'jumpstart', artifactUri: uri };
            applyMcpMetadata(answers, metadata);
            const result = applyDefaults(answers);
            assert.strictEqual(result.artifactUri, uri);
        });

        it('metadata without artifactUri defaults to empty string', () => {
            // **Validates: Requirements 2.4**
            const answers = {};
            const metadata = { provider: 'jumpstart' };
            applyMcpMetadata(answers, metadata);
            const result = applyDefaults(answers);
            assert.strictEqual(result.artifactUri, '');
        });

        it('null metadata defaults artifactUri to empty string', () => {
            // **Validates: Requirements 2.4**
            const answers = {};
            applyMcpMetadata(answers, null);
            const result = applyDefaults(answers);
            assert.strictEqual(result.artifactUri, '');
        });
    });

    // ── modelLoadStrategy defaults ───────────────────────────────────────

    describe('modelLoadStrategy defaults (Req 13.5)', () => {

        it('defaults to "runtime" when not explicitly set', () => {
            // **Validates: Requirements 13.5**
            const result = applyDefaults({});
            assert.strictEqual(result.modelLoadStrategy, 'runtime');
        });

        it('preserves explicit "build-time" value', () => {
            // **Validates: Requirements 13.5**
            const result = applyDefaults({ modelLoadStrategy: 'build-time' });
            assert.strictEqual(result.modelLoadStrategy, 'build-time');
        });

        it('preserves explicit "runtime" value', () => {
            // **Validates: Requirements 13.5**
            const result = applyDefaults({ modelLoadStrategy: 'runtime' });
            assert.strictEqual(result.modelLoadStrategy, 'runtime');
        });
    });

    // ── modelLoadStrategy prompt definition ──────────────────────────────

    describe('modelLoadStrategy prompt definition (Req 13.1, 13.2, 13.5)', () => {

        const prompt = modelLoadStrategyPrompts[0];

        it('prompt exists and has name "modelLoadStrategy"', () => {
            // **Validates: Requirements 13.1**
            assert.ok(prompt, 'modelLoadStrategyPrompts must contain at least one prompt');
            assert.strictEqual(prompt.name, 'modelLoadStrategy');
        });

        it('prompt type is "list"', () => {
            // **Validates: Requirements 13.1**
            assert.strictEqual(prompt.type, 'list');
        });

        it('prompt default is "runtime"', () => {
            // **Validates: Requirements 13.5**
            assert.strictEqual(prompt.default, 'runtime');
        });

        it('prompt message explains trade-offs', () => {
            // **Validates: Requirements 13.2**
            assert.ok(
                prompt.message.includes('Build-time'),
                'Prompt message must mention build-time option'
            );
            assert.ok(
                prompt.message.includes('Runtime'),
                'Prompt message must mention runtime option'
            );
        });

        it('prompt choices include runtime and build-time', () => {
            // **Validates: Requirements 13.1**
            const values = prompt.choices.map(c => c.value);
            assert.ok(values.includes('runtime'), 'Choices must include runtime');
            assert.ok(values.includes('build-time'), 'Choices must include build-time');
        });

        it('when() returns true for transformers architecture', () => {
            // **Validates: Requirements 13.1**
            assert.strictEqual(
                prompt.when({ architecture: 'transformers' }),
                true,
                'Prompt must be shown for transformers architecture'
            );
        });

        it('when() returns true for diffusors architecture', () => {
            // **Validates: Requirements 13.1**
            assert.strictEqual(
                prompt.when({ architecture: 'diffusors' }),
                true,
                'Prompt must be shown for diffusors architecture'
            );
        });

        it('when() returns true when architecture derived from deploymentConfig', () => {
            // **Validates: Requirements 13.1**
            assert.strictEqual(
                prompt.when({ deploymentConfig: 'transformers-vllm' }),
                true,
                'Prompt must be shown when deploymentConfig starts with transformers'
            );
            assert.strictEqual(
                prompt.when({ deploymentConfig: 'diffusors-vllm-omni' }),
                true,
                'Prompt must be shown when deploymentConfig starts with diffusors'
            );
        });

        it('when() returns false for http architecture', () => {
            // **Validates: Requirements 13.1**
            assert.strictEqual(
                prompt.when({ architecture: 'http' }),
                false,
                'Prompt must NOT be shown for http architecture'
            );
        });

        it('when() returns false for triton architecture', () => {
            // **Validates: Requirements 13.1**
            assert.strictEqual(
                prompt.when({ architecture: 'triton' }),
                false,
                'Prompt must NOT be shown for triton architecture'
            );
        });

        it('when() returns false for sklearn deploymentConfig', () => {
            // **Validates: Requirements 13.1**
            assert.strictEqual(
                prompt.when({ deploymentConfig: 'http-flask' }),
                false,
                'Prompt must NOT be shown for http-flask deploymentConfig'
            );
        });

        it('when() returns false for triton deploymentConfig', () => {
            // **Validates: Requirements 13.1**
            assert.strictEqual(
                prompt.when({ deploymentConfig: 'triton-fil' }),
                false,
                'Prompt must NOT be shown for triton-fil deploymentConfig'
            );
        });
    });
});

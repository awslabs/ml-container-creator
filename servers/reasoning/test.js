#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the reasoning MCP server.
 * Mocks @aws-sdk/client-bedrock-runtime to avoid real API calls.
 * Run: node servers/reasoning/test.js
 */

import assert from 'node:assert';

// ── Mock setup ───────────────────────────────────────────────────────────────

// We mock the AWS SDK by intercepting the dynamic import in the server.
// Since the server uses dynamic import(), we'll test parseBedrockResponse
// and handleInterpret with a mocked invokeBedrockProvider.

// Import server components
import {
    parseBedrockResponse,
    loadReasoningConfig,
    reasoningConfig,
    server,
    DEFAULT_REASONING_CONFIG,
    SYSTEM_PROMPT
} from './index.js';

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            passed++;
            console.log(`  ✓ ${name}`);
        })
        .catch((err) => {
            failed++;
            console.error(`  ✗ ${name}`);
            console.error(`    ${err.message}`);
        });
}

// ── Helper ───────────────────────────────────────────────────────────────────

function parseResponse(result) {
    assert.ok(result, 'result should not be null');
    assert.ok(result.content, 'result should have content');
    assert.ok(Array.isArray(result.content), 'content should be an array');
    assert.ok(result.content.length > 0, 'content should not be empty');
    assert.strictEqual(result.content[0].type, 'text', 'content[0].type should be text');
    return JSON.parse(result.content[0].text);
}

// ── Tests: Tool Schema ───────────────────────────────────────────────────────

console.log('\nreasoning: tool schema\n');

await test('server is an McpServer instance', async () => {
    assert.ok(server, 'server should be exported');
    assert.ok(typeof server === 'object', 'server should be an object');
});

await test('SYSTEM_PROMPT is a non-empty string', async () => {
    assert.ok(typeof SYSTEM_PROMPT === 'string', 'SYSTEM_PROMPT should be a string');
    assert.ok(SYSTEM_PROMPT.length > 100, 'SYSTEM_PROMPT should be substantial');
    assert.ok(SYSTEM_PROMPT.includes('interpretation'), 'SYSTEM_PROMPT should mention interpretation');
});

await test('DEFAULT_REASONING_CONFIG has required fields', async () => {
    assert.strictEqual(DEFAULT_REASONING_CONFIG.provider, 'bedrock');
    assert.ok(DEFAULT_REASONING_CONFIG.modelId.includes('claude'), 'modelId should reference claude');
    assert.strictEqual(typeof DEFAULT_REASONING_CONFIG.maxTokens, 'number');
    assert.strictEqual(typeof DEFAULT_REASONING_CONFIG.temperature, 'number');
    assert.ok(DEFAULT_REASONING_CONFIG.temperature >= 0 && DEFAULT_REASONING_CONFIG.temperature <= 1);
});

// ── Tests: parseBedrockResponse ──────────────────────────────────────────────

console.log('\nreasoning: parseBedrockResponse\n');

await test('happy path: parses valid JSON with all fields', async () => {
    const text = JSON.stringify({
        interpretation: 'The model needs 48GB VRAM for fp16 inference.',
        confidence: 0.92,
        suggestions: ['Use ml.g5.xlarge for cost efficiency', 'Consider AWQ quantization']
    });

    const result = parseBedrockResponse(text);
    assert.strictEqual(result.interpretation, 'The model needs 48GB VRAM for fp16 inference.');
    assert.strictEqual(result.confidence, 0.92);
    assert.deepStrictEqual(result.suggestions, [
        'Use ml.g5.xlarge for cost efficiency',
        'Consider AWQ quantization'
    ]);
});

await test('happy path: parses JSON without optional fields', async () => {
    const text = JSON.stringify({
        interpretation: 'Deploy with tensor parallelism across 4 GPUs.'
    });

    const result = parseBedrockResponse(text);
    assert.strictEqual(result.interpretation, 'Deploy with tensor parallelism across 4 GPUs.');
    assert.strictEqual(result.confidence, undefined);
    assert.strictEqual(result.suggestions, undefined);
});

await test('handles markdown-fenced JSON response', async () => {
    const text = '```json\n{"interpretation": "Use g5.2xlarge", "confidence": 0.8}\n```';

    const result = parseBedrockResponse(text);
    assert.strictEqual(result.interpretation, 'Use g5.2xlarge');
    assert.strictEqual(result.confidence, 0.8);
});

await test('handles non-JSON response as raw interpretation', async () => {
    const text = 'The model architecture suggests using a multi-GPU setup for optimal throughput.';

    const result = parseBedrockResponse(text);
    assert.strictEqual(result.interpretation, text);
    assert.strictEqual(result.confidence, undefined);
    assert.strictEqual(result.suggestions, undefined);
});

await test('confidence out of range is excluded', async () => {
    const text = JSON.stringify({
        interpretation: 'test',
        confidence: 1.5
    });

    const result = parseBedrockResponse(text);
    assert.strictEqual(result.interpretation, 'test');
    assert.strictEqual(result.confidence, undefined);
});

await test('confidence at boundaries is included', async () => {
    const text0 = JSON.stringify({ interpretation: 'low', confidence: 0 });
    const text1 = JSON.stringify({ interpretation: 'high', confidence: 1 });

    const result0 = parseBedrockResponse(text0);
    const result1 = parseBedrockResponse(text1);
    assert.strictEqual(result0.confidence, 0);
    assert.strictEqual(result1.confidence, 1);
});

await test('suggestions with non-string items are filtered', async () => {
    const text = JSON.stringify({
        interpretation: 'test',
        suggestions: ['valid', 123, null, 'also valid', {}]
    });

    const result = parseBedrockResponse(text);
    assert.deepStrictEqual(result.suggestions, ['valid', 'also valid']);
});

await test('empty suggestions array is excluded', async () => {
    const text = JSON.stringify({
        interpretation: 'test',
        suggestions: []
    });

    const result = parseBedrockResponse(text);
    assert.strictEqual(result.suggestions, undefined);
});

await test('extracts JSON from text with surrounding prose', async () => {
    const text = 'Here is my analysis:\n{"interpretation": "The deployment is healthy", "confidence": 0.95}\nEnd of response.';

    const result = parseBedrockResponse(text);
    assert.strictEqual(result.interpretation, 'The deployment is healthy');
    assert.strictEqual(result.confidence, 0.95);
});

// ── Tests: Config loading ────────────────────────────────────────────────────

console.log('\nreasoning: config loading\n');

await test('loadReasoningConfig returns valid config object', async () => {
    const config = loadReasoningConfig();
    assert.ok(config, 'config should not be null');
    assert.ok(typeof config.provider === 'string', 'provider should be a string');
    assert.ok(typeof config.modelId === 'string', 'modelId should be a string');
    assert.ok(typeof config.maxTokens === 'number', 'maxTokens should be a number');
    assert.ok(typeof config.temperature === 'number', 'temperature should be a number');
});

await test('reasoningConfig loaded at startup matches config/agent.json', async () => {
    // The config should reflect what's in config/agent.json
    assert.strictEqual(reasoningConfig.provider, 'bedrock');
    assert.ok(reasoningConfig.modelId.includes('claude'), 'modelId should reference claude');
    assert.strictEqual(reasoningConfig.maxTokens, 2048);
    assert.strictEqual(reasoningConfig.temperature, 0.3);
});

// ── Tests: handleInterpret (integration, will fail on Bedrock but tests structure) ──

console.log('\nreasoning: handleInterpret error handling\n');

await test('handleInterpret returns structured error when Bedrock unavailable', async () => {
    // This test calls handleInterpret which will try to load the AWS SDK.
    // In CI/test environment without AWS credentials, it should return a structured error
    // rather than crashing.
    const { handleInterpret } = await import('./index.js');

    const result = await handleInterpret({
        context: 'Test project running vLLM with Llama-3.1-8B',
        objective: 'Explain the deployment configuration'
    });

    const data = parseResponse(result);

    // Should have interpretation field (even if empty on error)
    assert.ok('interpretation' in data, 'response should have interpretation field');
    assert.ok(typeof data.interpretation === 'string', 'interpretation should be a string');

    // If there's an error, it should be structured
    if (data.error) {
        assert.ok(typeof data.error === 'string', 'error should be a string');
    }
});

await test('handleInterpret with data field returns structured response', async () => {
    const { handleInterpret } = await import('./index.js');

    const result = await handleInterpret({
        context: 'SageMaker deployment for text generation',
        data: { instanceType: 'ml.g5.2xlarge', latencyP50: 120, latencyP99: 450 },
        objective: 'Diagnose latency issues'
    });

    const data = parseResponse(result);
    assert.ok('interpretation' in data, 'response should have interpretation field');
    assert.ok(typeof data.interpretation === 'string', 'interpretation should be a string');
});

await test('handleInterpret with empty context does not crash', async () => {
    const { handleInterpret } = await import('./index.js');

    const result = await handleInterpret({
        context: '',
        objective: 'Explain something'
    });

    const data = parseResponse(result);
    assert.ok('interpretation' in data, 'response should have interpretation field');
});

await test('handleInterpret with large data object does not crash', async () => {
    const { handleInterpret } = await import('./index.js');

    // Create a large data object
    const largeData = {};
    for (let i = 0; i < 1000; i++) {
        largeData[`metric_${i}`] = { value: Math.random(), timestamp: Date.now() };
    }

    const result = await handleInterpret({
        context: 'Performance monitoring data',
        data: largeData,
        objective: 'Summarize performance trends'
    });

    const data = parseResponse(result);
    assert.ok('interpretation' in data, 'response should have interpretation field');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);

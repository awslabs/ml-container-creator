#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live HuggingFace Hub discovery check for an uncatalogued multimodal model
 * (Qwen/Qwen3.5-4B, the neat-transformer-classifier regression).
 *
 * NETWORK-DEPENDENT: listed in scripts/run-server-tests.js NETWORK_DEPENDENT,
 * so it only runs with `--include-network`. Offline path is deterministic:
 * when the Hub is unreachable the test reports SKIP and exits 0.
 *
 * Asserts behavior, not frozen numbers: a "4B" model resolves to a few
 * billion parameters and a context window longer than the 4096 default.
 *
 * Run: node servers/instance-sizer/test/hf-discovery.network.test.js
 */

import assert from 'node:assert';
import { discoverFromHuggingFace, hasUsableSize } from '../lib/model-resolver.js';

const MODEL = 'Qwen/Qwen3.5-4B';
const result = await discoverFromHuggingFace(MODEL, { timeout: 10000 });

if (!result) {
    console.log(`  - SKIP ${MODEL}: HuggingFace Hub unreachable (offline) — re-run with network access`);
    process.exit(0);
}

try {
    assert.ok(hasUsableSize(result), 'live discovery must yield a usable size');
    assert.ok(result.parameterCount > 3e9 && result.parameterCount < 7e9,
        `a "4B" model should be a few billion params, got ${result.parameterCount}`);
    assert.ok(result.maxPositionEmbeddings > 4096, `context should come from text_config, got ${result.maxPositionEmbeddings}`);
    assert.strictEqual(result.dtype, 'bfloat16');
    console.log(`  ✓ ${MODEL}: ${result.parameterCount} params (${result.parameterCountSource}), ctx ${result.maxPositionEmbeddings}`);
    console.log('\n  1 passing, 0 failing\n');
    process.exit(0);
} catch (err) {
    console.error(`  ✗ ${MODEL}: ${err.message}`);
    console.log('\n  0 passing, 1 failing\n');
    process.exit(1);
}

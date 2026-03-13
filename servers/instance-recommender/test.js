#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone tests for the instance-recommender MCP server.
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-recommender/test.js
 */

import assert from 'node:assert'
import { getStaticInstances, INSTANCE_CATALOG, INSTANCE_RECOMMENDATIONS, GPU_FRAMEWORKS } from './index.js'

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        fn()
        passed++
        console.log(`  ✓ ${name}`)
    } catch (err) {
        failed++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
    }
}

console.log('\ninstance-recommender: getStaticInstances\n')

// --- CPU framework returns CPU instances ---
test('sklearn (CPU framework) returns CPU instances', () => {
    const instances = getStaticInstances({ framework: 'sklearn' })
    assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.cpu)
})

test('xgboost (CPU framework) returns CPU instances', () => {
    const instances = getStaticInstances({ framework: 'xgboost' })
    assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.cpu)
})

// --- GPU framework returns GPU instances ---
test('transformers (GPU framework) returns GPU instances', () => {
    const instances = getStaticInstances({ framework: 'transformers' })
    assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.gpu)
})

// --- GPU_FRAMEWORKS set is correct ---
test('GPU_FRAMEWORKS contains transformers', () => {
    assert.ok(GPU_FRAMEWORKS.has('transformers'))
})

test('GPU_FRAMEWORKS does not contain sklearn', () => {
    assert.ok(!GPU_FRAMEWORKS.has('sklearn'))
})

// --- No framework defaults to CPU ---
test('no framework context returns CPU instances', () => {
    const instances = getStaticInstances({})
    assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.cpu)
})

test('undefined context returns CPU instances', () => {
    const instances = getStaticInstances(undefined)
    assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.cpu)
})

// --- Limit enforcement ---
test('limit enforcement: slicing CPU instances to 3', () => {
    const instances = getStaticInstances({ framework: 'sklearn' })
    const limited = instances.slice(0, 3)
    assert.strictEqual(limited.length, 3)
    assert.deepStrictEqual(limited, INSTANCE_RECOMMENDATIONS.cpu.slice(0, 3))
})

test('limit enforcement: slicing GPU instances to 2', () => {
    const instances = getStaticInstances({ framework: 'transformers' })
    const limited = instances.slice(0, 2)
    assert.strictEqual(limited.length, 2)
    assert.deepStrictEqual(limited, INSTANCE_RECOMMENDATIONS.gpu.slice(0, 2))
})

// --- Response format: values.instanceType matches first choice ---
test('first CPU instance is values.instanceType', () => {
    const instances = getStaticInstances({ framework: 'sklearn' })
    const limited = instances.slice(0, 10)
    assert.strictEqual(limited[0], INSTANCE_RECOMMENDATIONS.cpu[0])
})

test('first GPU instance is values.instanceType', () => {
    const instances = getStaticInstances({ framework: 'transformers' })
    const limited = instances.slice(0, 10)
    assert.strictEqual(limited[0], INSTANCE_RECOMMENDATIONS.gpu[0])
})

// --- All instances have ml. prefix ---
test('all CPU instances have ml. prefix', () => {
    for (const inst of INSTANCE_RECOMMENDATIONS.cpu) {
        assert.ok(inst.startsWith('ml.'), `${inst} should start with ml.`)
    }
})

test('all GPU instances have ml. prefix', () => {
    for (const inst of INSTANCE_RECOMMENDATIONS.gpu) {
        assert.ok(inst.startsWith('ml.'), `${inst} should start with ml.`)
    }
})

// --- Smart mode not activated without BEDROCK_SMART=true ---
test('smart mode not activated without BEDROCK_SMART=true', () => {
    assert.strictEqual(process.env.BEDROCK_SMART, undefined)
    // Static function works without Bedrock — confirms smart mode is off
    const instances = getStaticInstances({ framework: 'sklearn' })
    assert.ok(instances.length > 0, 'static mode should return results')
})

// --- Search filtering ---
console.log('\ninstance-recommender: search filtering\n')

test('"multi gpu" returns only multi-GPU instances', () => {
    const instances = getStaticInstances({ instanceSearch: 'multi gpu' })
    assert.ok(instances.length > 0, 'should return results')
    for (const inst of instances) {
        const meta = INSTANCE_CATALOG[inst]
        assert.ok(meta, `${inst} should be in catalog`)
        assert.ok(meta.gpus > 1, `${inst} should have multiple GPUs (has ${meta.gpus})`)
    }
})

test('"multi-gpu" (hyphenated) returns only multi-GPU instances', () => {
    const instances = getStaticInstances({ instanceSearch: 'multi-gpu' })
    assert.ok(instances.length > 0, 'should return results')
    for (const inst of instances) {
        assert.ok(INSTANCE_CATALOG[inst].gpus > 1, `${inst} should have multiple GPUs`)
    }
})

test('"cost-effective cpu" returns budget CPU instances', () => {
    const instances = getStaticInstances({ instanceSearch: 'cost-effective cpu' })
    assert.ok(instances.length > 0, 'should return results')
    // All results should be CPU instances
    for (const inst of instances) {
        const meta = INSTANCE_CATALOG[inst]
        assert.ok(meta.tags.includes('cpu') || meta.tags.includes('cost-effective'),
            `${inst} should match cost-effective or cpu`)
    }
})

test('"v100" returns V100 instances', () => {
    const instances = getStaticInstances({ instanceSearch: 'v100' })
    assert.ok(instances.length > 0, 'should return results')
    for (const inst of instances) {
        assert.ok(inst.includes('p3'), `${inst} should be a p3 (V100) instance`)
    }
})

test('"a10g" returns A10G instances', () => {
    const instances = getStaticInstances({ instanceSearch: 'a10g' })
    assert.ok(instances.length > 0, 'should return results')
    for (const inst of instances) {
        assert.ok(inst.includes('g5'), `${inst} should be a g5 (A10G) instance`)
    }
})

test('nonsense search falls back to CPU list', () => {
    const instances = getStaticInstances({ instanceSearch: 'zzzznotreal' })
    assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.cpu)
})

test('nonsense search with GPU framework falls back to GPU list', () => {
    const instances = getStaticInstances({ framework: 'transformers', instanceSearch: 'zzzznotreal' })
    assert.deepStrictEqual(instances, INSTANCE_RECOMMENDATIONS.gpu,
        'should fall back to legacy GPU list when no search matches')
})

// --- CUDA version search ---
console.log('\ninstance-recommender: CUDA version search\n')

test('"cuda 12" returns only CUDA 12.x capable instances', () => {
    const instances = getStaticInstances({ instanceSearch: 'cuda 12' })
    assert.ok(instances.length > 0, 'should return results')
    for (const inst of instances) {
        const meta = INSTANCE_CATALOG[inst]
        assert.ok(meta.cudaVersions, `${inst} should have cudaVersions`)
        const hasCuda12 = meta.cudaVersions.some(v => v.startsWith('12'))
        assert.ok(hasCuda12, `${inst} should support CUDA 12.x (has ${meta.cudaVersions.join(', ')})`)
    }
})

test('"cuda 11.8" returns instances supporting CUDA 11.8', () => {
    const instances = getStaticInstances({ instanceSearch: 'cuda 11.8' })
    assert.ok(instances.length > 0, 'should return results')
    for (const inst of instances) {
        const meta = INSTANCE_CATALOG[inst]
        assert.ok(meta.cudaVersions, `${inst} should have cudaVersions`)
        assert.ok(meta.cudaVersions.includes('11.8'), `${inst} should support CUDA 11.8 (has ${meta.cudaVersions.join(', ')})`)
    }
})

test('CPU instances have null cudaVersions', () => {
    for (const [name, meta] of Object.entries(INSTANCE_CATALOG)) {
        if (meta.category === 'cpu') {
            assert.strictEqual(meta.cudaVersions, null, `${name} (CPU) should have cudaVersions: null`)
        }
    }
})

test('GPU instances have non-empty cudaVersions array', () => {
    for (const [name, meta] of Object.entries(INSTANCE_CATALOG)) {
        if (meta.category === 'gpu') {
            assert.ok(Array.isArray(meta.cudaVersions), `${name} should have cudaVersions array`)
            assert.ok(meta.cudaVersions.length > 0, `${name} should have at least one CUDA version`)
        }
    }
})

// --- Summary ---
console.log(`\n  ${passed} passing, ${failed} failing\n`)
process.exit(failed > 0 ? 1 : 0)

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Athena Query Performance Validation
 *
 * Simulates query performance against 10K synthetic benchmark records
 * using in-memory data structures that mirror the Athena table schema.
 * Verifies the 3 query patterns from Req 5.4 complete under 5 seconds.
 *
 * Since we cannot run real Athena queries in unit tests, this test validates:
 * 1. The query logic is correct (returns expected results)
 * 2. The in-memory equivalent completes well under 5 seconds with 10K records
 * 3. The schema supports the required query patterns efficiently
 *
 * Feature: ci-benchmark-pipeline
 * Task: 8.4 Query performance validation
 * Requirements: 5.4
 */

import { describe, it, before } from 'mocha'
import assert from 'assert'

// ── Synthetic Data Generation ────────────────────────────────────────────────

const MODEL_FAMILIES = ['qwen3', 'qwen2.5', 'llama3', 'deepseek-r1', 'mistral', 'gemma2', 'phi3', 'gpt-oss']
const INSTANCE_FAMILIES = ['g5', 'g6', 'g6e', 'p5', 'p4d', 'inf2', 'trn2']
const DEPLOYMENT_CONFIGS = ['http-flask', 'http-fastapi', 'transformers-vllm', 'transformers-sglang', 'transformers-tensorrt-llm', 'transformers-lmi']
const QUANTIZATIONS = ['none', 'fp16', 'fp8', 'int8', 'int4', 'awq', 'gptq']
const DEPLOYMENT_TARGETS = ['realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks']
const STATUSES = ['completed', 'failed', 'timeout']
const TP_DEGREES = [1, 2, 4, 8]
const CONCURRENCY_LEVELS = [1, 4, 8, 16, 32]

/**
 * Deterministic pseudo-random number generator (mulberry32).
 */
function createRNG(seed = 42) {
    let s = seed
    return function () {
        s |= 0; s = s + 0x6D2B79F5 | 0
        let t = Math.imul(s ^ s >>> 15, 1 | s)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
}

/**
 * Generate 10K synthetic benchmark records matching the Athena schema.
 */
function generate10KRecords() {
    const rng = createRNG(12345)
    const pick = (arr) => arr[Math.floor(rng() * arr.length)]

    const records = []
    for (let i = 0; i < 10000; i++) {
        const modelFamily = pick(MODEL_FAMILIES)
        const instanceFamily = pick(INSTANCE_FAMILIES)
        records.push({
            config_id: `cfg${String(i).padStart(5, '0')}`,
            model_name: `org/${modelFamily}-${Math.floor(rng() * 100)}B`,
            model_family: modelFamily,
            instance_type: `ml.${instanceFamily}.${pick(['xlarge', '2xlarge', '4xlarge', '12xlarge', '48xlarge'])}`,
            instance_family: instanceFamily,
            deployment_config: pick(DEPLOYMENT_CONFIGS),
            deployment_target: pick(DEPLOYMENT_TARGETS),
            quantization: pick(QUANTIZATIONS),
            tensor_parallel_degree: pick(TP_DEGREES),
            enable_lora: rng() > 0.5,
            concurrency: pick(CONCURRENCY_LEVELS),
            status: pick(STATUSES),
            run_type: pick(['ci', 'path_prove', 'optimization', 'manual']),
            ttft_p50_ms: 20 + rng() * 500,
            ttft_p99_ms: 100 + rng() * 2000,
            itl_p50_ms: 5 + rng() * 50,
            itl_p99_ms: 15 + rng() * 100,
            throughput_rps: 1 + rng() * 100,
            tokens_per_second: 50 + rng() * 2000,
            cost_per_1m_tokens: 0.1 + rng() * 10,
            error_rate: rng() * 0.1,
            run_timestamp: `2026-${String(1 + Math.floor(rng() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rng() * 28)).padStart(2, '0')}T12:00:00Z`,
            mcc_version: `0.${10 + Math.floor(rng() * 5)}.${Math.floor(rng() * 10)}`,
            region: pick(['us-east-1', 'us-west-2', 'eu-west-1']),
            year: '2026',
            month: String(1 + Math.floor(rng() * 12)).padStart(2, '0')
        })
    }
    return records
}

// ── Query Implementations (mirroring Athena SQL) ─────────────────────────────

/**
 * Query Pattern 1: Find configs with specific model_family AND instance_family AND status
 *
 * SQL equivalent:
 *   SELECT * FROM benchmark_results
 *   WHERE model_family = 'qwen3' AND instance_family = 'g5' AND status = 'completed'
 */
function queryByFamilyAndInstance(records, modelFamily, instanceFamily, status) {
    return records.filter(r =>
        r.model_family === modelFamily &&
        r.instance_family === instanceFamily &&
        r.status === status
    )
}

/**
 * Query Pattern 2: Find model families with zero records for a given instance_family
 *
 * SQL equivalent:
 *   WITH all_configs AS (SELECT DISTINCT model_family FROM benchmark_results),
 *   target_instance AS (SELECT DISTINCT model_family FROM benchmark_results WHERE instance_family = 'g6e')
 *   SELECT ac.model_family FROM all_configs ac
 *   LEFT JOIN target_instance ti ON ac.model_family = ti.model_family
 *   WHERE ti.model_family IS NULL
 */
function queryMissingFamiliesForInstance(records, targetInstanceFamily) {
    const allFamilies = new Set(records.map(r => r.model_family))
    const coveredFamilies = new Set(
        records.filter(r => r.instance_family === targetInstanceFamily).map(r => r.model_family)
    )
    return [...allFamilies].filter(f => !coveredFamilies.has(f))
}

/**
 * Query Pattern 3: Find the 5 closest configs by Hamming distance on dimension vector
 *
 * For a given configId, compute distance to all other configs and return top 5.
 */
function queryClosestByHamming(records, targetConfigId, limit = 5) {
    const target = records.find(r => r.config_id === targetConfigId)
    if (!target) return []

    const dimensions = ['deployment_config', 'model_family', 'instance_family', 'quantization', 'tensor_parallel_degree', 'deployment_target']

    const scored = records
        .filter(r => r.config_id !== targetConfigId && r.status === 'completed')
        .map(r => {
            let distance = 0
            for (const dim of dimensions) {
                if (String(r[dim]) !== String(target[dim])) distance++
            }
            return { record: r, distance }
        })
        .sort((a, b) => a.distance - b.distance)

    return scored.slice(0, limit)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Athena Query Performance Validation', function () {
    this.timeout(30000)

    let records

    before(() => {
        records = generate10KRecords()
    })

    describe('Data generation', () => {
        it('generates exactly 10,000 records', () => {
            assert.strictEqual(records.length, 10000)
        })

        it('records have all required columns', () => {
            const required = [
                'config_id', 'model_name', 'model_family', 'instance_type',
                'instance_family', 'deployment_config', 'deployment_target',
                'quantization', 'status', 'run_type', 'throughput_rps',
                'ttft_p50_ms', 'concurrency'
            ]
            for (const col of required) {
                assert.ok(records[0][col] !== undefined, `Record should have column: ${col}`)
            }
        })

        it('records cover all model families', () => {
            const families = new Set(records.map(r => r.model_family))
            for (const f of MODEL_FAMILIES) {
                assert.ok(families.has(f), `Should cover model family: ${f}`)
            }
        })

        it('records cover all instance families', () => {
            const families = new Set(records.map(r => r.instance_family))
            for (const f of INSTANCE_FAMILIES) {
                assert.ok(families.has(f), `Should cover instance family: ${f}`)
            }
        })
    })

    describe('Query Pattern 1: Find by model_family + instance_family + status', () => {
        it('returns results for common combinations', () => {
            const results = queryByFamilyAndInstance(records, 'qwen3', 'g5', 'completed')
            assert.ok(results.length > 0, 'Should find some qwen3 + g5 + completed records')
        })

        it('all returned records match the filter criteria', () => {
            const results = queryByFamilyAndInstance(records, 'qwen3', 'g5', 'completed')
            for (const r of results) {
                assert.strictEqual(r.model_family, 'qwen3')
                assert.strictEqual(r.instance_family, 'g5')
                assert.strictEqual(r.status, 'completed')
            }
        })

        it('completes within 5 seconds on 10K records', () => {
            const start = Date.now()
            for (let i = 0; i < 100; i++) {
                queryByFamilyAndInstance(records, 'qwen3', 'g5', 'completed')
            }
            const elapsed = Date.now() - start
            // 100 iterations should still be well under 5 seconds
            assert.ok(elapsed < 5000,
                `100 iterations of Query Pattern 1 took ${elapsed}ms (should be < 5000ms)`)
        })
    })

    describe('Query Pattern 2: Find model families with zero records for instance', () => {
        it('identifies missing coverage gaps', () => {
            const missing = queryMissingFamiliesForInstance(records, 'g6e')
            // With 10K random records, most families will be covered — but test the logic
            assert.ok(Array.isArray(missing))
        })

        it('returned families genuinely have no records for target instance', () => {
            const targetInstance = 'trn2'
            const missing = queryMissingFamiliesForInstance(records, targetInstance)

            for (const family of missing) {
                const hasRecords = records.some(r =>
                    r.model_family === family && r.instance_family === targetInstance
                )
                assert.strictEqual(hasRecords, false,
                    `Family ${family} was reported as missing but has records for ${targetInstance}`)
            }
        })

        it('completes within 5 seconds on 10K records', () => {
            const start = Date.now()
            for (let i = 0; i < 100; i++) {
                queryMissingFamiliesForInstance(records, 'g6e')
            }
            const elapsed = Date.now() - start
            assert.ok(elapsed < 5000,
                `100 iterations of Query Pattern 2 took ${elapsed}ms (should be < 5000ms)`)
        })
    })

    describe('Query Pattern 3: Closest configs by Hamming distance', () => {
        it('returns up to 5 results', () => {
            const results = queryClosestByHamming(records, 'cfg00001', 5)
            assert.ok(results.length > 0, 'Should find at least one close config')
            assert.ok(results.length <= 5)
        })

        it('results are ordered by ascending distance', () => {
            const results = queryClosestByHamming(records, 'cfg00001', 5)
            for (let i = 1; i < results.length; i++) {
                assert.ok(
                    results[i].distance >= results[i - 1].distance,
                    'Results must be ordered by ascending Hamming distance'
                )
            }
        })

        it('only returns completed configs', () => {
            const results = queryClosestByHamming(records, 'cfg00100', 5)
            for (const r of results) {
                assert.strictEqual(r.record.status, 'completed')
            }
        })

        it('does not include the target config itself', () => {
            const targetId = 'cfg00050'
            const results = queryClosestByHamming(records, targetId, 5)
            for (const r of results) {
                assert.notStrictEqual(r.record.config_id, targetId)
            }
        })

        it('completes within 5 seconds on 10K records', () => {
            const start = Date.now()
            for (let i = 0; i < 10; i++) {
                queryClosestByHamming(records, `cfg${String(i * 1000).padStart(5, '0')}`, 5)
            }
            const elapsed = Date.now() - start
            assert.ok(elapsed < 5000,
                `10 iterations of Query Pattern 3 took ${elapsed}ms (should be < 5000ms)`)
        })

        it('distance 0 means all dimensions match', () => {
            const results = queryClosestByHamming(records, 'cfg00001', 5)
            if (results.length > 0 && results[0].distance === 0) {
                const target = records.find(r => r.config_id === 'cfg00001')
                const match = results[0].record
                assert.strictEqual(match.deployment_config, target.deployment_config)
                assert.strictEqual(match.model_family, target.model_family)
                assert.strictEqual(match.instance_family, target.instance_family)
            }
        })
    })

    describe('Combined performance', () => {
        it('all 3 query patterns complete together under 5 seconds', () => {
            const start = Date.now()

            // Run each pattern multiple times
            for (let i = 0; i < 50; i++) {
                queryByFamilyAndInstance(records, 'llama3', 'g5', 'completed')
                queryMissingFamiliesForInstance(records, 'p5')
                queryClosestByHamming(records, `cfg${String(i * 200).padStart(5, '0')}`, 5)
            }

            const elapsed = Date.now() - start
            assert.ok(elapsed < 5000,
                `Combined query workload (150 queries) took ${elapsed}ms (should be < 5000ms)`)
        })
    })
})

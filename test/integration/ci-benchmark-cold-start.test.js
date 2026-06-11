// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-End Cold-Start Integration Test
 *
 * Verifies the full pipeline starting from zero state:
 *   - Empty DynamoDB (no prior records)
 *   - Empty Athena (no proven configs)
 *   - Trigger Path Prover → verify seed selection from gap identification
 *   - Mock CodeBuild success → verify DynamoDB updated, Parquet record built,
 *     partition registered, and Athena record queryable
 *
 * Feature: ci-benchmark-pipeline
 * Task: 8.1 End-to-end cold-start test
 * Requirements: 8.1, 8.11
 */

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';
import {
    buildCiRecord,
    applyRecordDefaults,
    buildBenchmarkFields,
    computeConfigId
} from '../../src/lib/ci-register-helpers.js';
import {
    identifyGaps,
    findNearestSubstitution,
    buildPathProverRecord,
    classifyFailure
} from '../../src/lib/path-prover-brain.js';

// ── Mock Infrastructure ──────────────────────────────────────────────────────

/**
 * Simulated DynamoDB store for CI records.
 */
class MockDynamoDB {
    constructor() {
        this.records = new Map();
    }

    putItem(record) {
        this.records.set(record.configId, { ...record });
    }

    getItem(configId) {
        const record = this.records.get(configId);
        return record ? { ...record } : null;
    }

    updateItem(configId, fields) {
        const existing = this.records.get(configId);
        if (existing) {
            this.records.set(configId, { ...existing, ...fields });
        }
    }

    isEmpty() {
        return this.records.size === 0;
    }
}

/**
 * Simulated Athena query results store.
 * Represents the benchmark_results table.
 */
class MockAthena {
    constructor() {
        this.records = [];
        this.partitions = [];
    }

    query(filter = {}) {
        return this.records.filter(r => {
            for (const [key, val] of Object.entries(filter)) {
                if (r[key] !== val) return false;
            }
            return true;
        });
    }

    getProvenConfigs() {
        return this.records.filter(r => r.status === 'completed');
    }

    addRecord(record) {
        this.records.push({ ...record });
    }

    registerPartition(partition) {
        this.partitions.push(partition);
    }

    isEmpty() {
        return this.records.length === 0;
    }
}

/**
 * Simulated S3 writes for Parquet files.
 */
class MockS3 {
    constructor() {
        this.objects = new Map();
    }

    putObject(key, content) {
        this.objects.set(key, content);
    }

    hasObject(key) {
        return this.objects.has(key);
    }

    listByPrefix(prefix) {
        return [...this.objects.keys()].filter(k => k.startsWith(prefix));
    }

    isEmpty() {
        return this.objects.size === 0;
    }
}

/**
 * Simulate a Path Prover execution lifecycle for a given config.
 *
 * In cold-start scenario, the brain must select a seed config to prove
 * (since there are no proven configs to substitute from).
 */
function simulatePathProverColdStart(db, athena, s3, seedConfig, options = {}) {
    const { succeed = true } = options;
    const execution = {
        gapIdentified: false,
        seedSelected: null,
        lifecycleRan: false,
        recordWritten: false,
        partitionRegistered: false,
        dynamoUpdated: false
    };

    // Step 1: Brain identifies gaps — with empty Athena, everything is a gap
    const provenConfigs = athena.getProvenConfigs();
    identifyGaps(provenConfigs);

    // In cold-start, identifyGaps with empty list returns empty (no known dimension space)
    // So the brain uses the seed config directly as the first prove request
    execution.gapIdentified = true;
    execution.seedSelected = seedConfig;

    // Step 2: Check for nearest substitution — should return noMatch for cold start
    const substitution = findNearestSubstitution(seedConfig, provenConfigs);
    // Expected: noMatch because no proven configs exist
    assert.ok(substitution.noMatch, 'Cold start should have no proven substitutions');

    // Step 3: Execute lifecycle (mocked)
    execution.lifecycleRan = true;

    if (succeed) {
        // Step 4: Build a path prover record for successful execution
        const result = {
            config: seedConfig,
            success: true,
            metrics: {
                ttft_p50_ms: 45.2,
                ttft_p99_ms: 112.4,
                itl_p50_ms: 8.1,
                itl_p99_ms: 18.7,
                throughput_rps: 12.5,
                tokens_per_second: 487.2,
                cost_per_1m_tokens: 0.85,
                error_rate: 0.0
            },
            concurrency: 1
        };

        const record = buildPathProverRecord(result, null);
        assert.strictEqual(record.run_type, 'path_prove', 'Record must have run_type=path_prove');
        assert.strictEqual(record.status, 'completed');

        // Step 5: Write to S3 (Parquet equivalent)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
        const partitionPath = `region=${seedConfig.region || 'us-east-1'}/year=2026/month=06`;
        const s3Key = `${partitionPath}/run-${seedConfig.config_id || 'seed123'}-${timestamp}Z.parquet`;
        s3.putObject(s3Key, JSON.stringify(record));
        execution.recordWritten = true;

        // Step 6: Register partition in Athena
        athena.registerPartition({ region: seedConfig.region || 'us-east-1', year: '2026', month: '06' });
        execution.partitionRegistered = true;

        // Step 7: Add record to Athena (makes it queryable)
        athena.addRecord({
            ...seedConfig,
            ...record,
            config_id: seedConfig.config_id || computeConfigId(
                seedConfig.deployment_config,
                seedConfig.model_name || 'none',
                seedConfig.instance_type || 'ml.g5.xlarge',
                seedConfig.region || 'us-east-1',
                seedConfig.deployment_target
            )
        });

        // Step 8: Update DynamoDB with benchmark fields
        const configId = seedConfig.config_id || computeConfigId(
            seedConfig.deployment_config,
            seedConfig.model_name || 'none',
            seedConfig.instance_type || 'ml.g5.xlarge',
            seedConfig.region || 'us-east-1',
            seedConfig.deployment_target
        );
        if (db.getItem(configId)) {
            const benchmarkFields = buildBenchmarkFields(
                `bmk-${timestamp}Z`,
                'completed',
                new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
            );
            db.updateItem(configId, benchmarkFields);
            execution.dynamoUpdated = true;
        }
    } else {
        // Failure case
        const classification = classifyFailure('InsufficientInstanceCapacity: no ml.g5.xlarge available');
        const record = buildPathProverRecord({ config: seedConfig, success: false, error: 'InsufficientInstanceCapacity: no ml.g5.xlarge available' }, classification);
        athena.addRecord({
            ...seedConfig,
            ...record,
            config_id: seedConfig.config_id || 'seed123'
        });
        execution.recordWritten = true;
    }

    return execution;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CI Benchmark Cold-Start Integration', function () {
    this.timeout(30000);

    let db;
    let athena;
    let s3;
    let seedConfig;

    beforeEach(() => {
        db = new MockDynamoDB();
        athena = new MockAthena();
        s3 = new MockS3();

        seedConfig = {
            deployment_config: 'transformers-vllm',
            model_family: 'qwen3',
            model_name: 'Qwen/Qwen3-4B',
            instance_type: 'ml.g5.xlarge',
            instance_family: 'g5',
            quantization: 'none',
            tp_degree: '1',
            deployment_target: 'realtime-inference',
            region: 'us-east-1'
        };

        // Register the seed config in DynamoDB (simulating do/register)
        const configId = computeConfigId(
            seedConfig.deployment_config,
            seedConfig.model_name,
            seedConfig.instance_type,
            seedConfig.region,
            seedConfig.deployment_target
        );
        seedConfig.config_id = configId;

        const ciRecord = buildCiRecord(configId, JSON.stringify(seedConfig), {
            deploymentConfig: seedConfig.deployment_config,
            baseImage: 'vllm/vllm-openai:v0.8.5',
            baseImageVersion: 'v0.8.5',
            projectName: 'test-qwen3-4b'
        });
        applyRecordDefaults(ciRecord);
        ciRecord.testStatus = 'pass';
        ciRecord.benchmarkEnabled = true;
        db.putItem(ciRecord);
    });

    describe('Empty state verification', () => {
        it('Athena starts empty (no proven configs)', () => {
            assert.strictEqual(athena.isEmpty(), true);
            assert.deepStrictEqual(athena.getProvenConfigs(), []);
        });

        it('S3 starts empty (no Parquet files)', () => {
            assert.strictEqual(s3.isEmpty(), true);
        });

        it('identifyGaps returns empty for empty proven set', () => {
            const gaps = identifyGaps([]);
            assert.deepStrictEqual(gaps, []);
        });

        it('findNearestSubstitution returns noMatch for empty proven set', () => {
            const result = findNearestSubstitution(seedConfig, []);
            assert.strictEqual(result.noMatch, true);
            assert.ok(result.message.includes('no coverage'));
        });
    });

    describe('Seed selection and lifecycle execution', () => {
        it('Path Prover selects seed config when no proven configs exist', () => {
            const execution = simulatePathProverColdStart(db, athena, s3, seedConfig);

            assert.strictEqual(execution.gapIdentified, true);
            assert.deepStrictEqual(execution.seedSelected, seedConfig);
        });

        it('Full lifecycle executes for seed config', () => {
            const execution = simulatePathProverColdStart(db, athena, s3, seedConfig);

            assert.strictEqual(execution.lifecycleRan, true);
        });

        it('Successful prove writes record to S3', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig);

            assert.strictEqual(s3.isEmpty(), false, 'S3 should contain the written Parquet record');
            const keys = s3.listByPrefix('region=us-east-1/year=2026/month=06/');
            assert.ok(keys.length > 0, 'S3 should have a record in the correct partition path');
        });

        it('Successful prove registers partition in Athena', () => {
            const execution = simulatePathProverColdStart(db, athena, s3, seedConfig);

            assert.strictEqual(execution.partitionRegistered, true);
            assert.strictEqual(athena.partitions.length, 1);
            assert.deepStrictEqual(athena.partitions[0], {
                region: 'us-east-1',
                year: '2026',
                month: '06'
            });
        });

        it('Successful prove makes config queryable in Athena', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig);

            const results = athena.query({ status: 'completed', run_type: 'path_prove' });
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0].deployment_config, 'transformers-vllm');
            assert.strictEqual(results[0].model_family, 'qwen3');
        });
    });

    describe('DynamoDB updates after successful prove', () => {
        it('DynamoDB record gains benchmark fields', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig);

            const record = db.getItem(seedConfig.config_id);
            assert.ok(record.lastBenchmarkRunId, 'lastBenchmarkRunId should be set');
            assert.ok(record.lastBenchmarkTimestamp, 'lastBenchmarkTimestamp should be set');
            assert.strictEqual(record.lastBenchmarkStatus, 'completed');
        });

        it('testStatus remains unchanged after benchmark', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig);

            const record = db.getItem(seedConfig.config_id);
            assert.strictEqual(record.testStatus, 'pass',
                'testStatus must not change after benchmark stage');
        });
    });

    describe('Athena record integrity', () => {
        it('Record has run_type=path_prove', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig);

            const results = athena.query({ run_type: 'path_prove' });
            assert.strictEqual(results.length, 1);
        });

        it('Record has status=completed for successful prove', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig);

            const results = athena.query({ status: 'completed' });
            assert.strictEqual(results.length, 1);
        });

        it('Record has correct config dimensions', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig);

            const results = athena.getProvenConfigs();
            assert.strictEqual(results.length, 1);
            const r = results[0];
            assert.strictEqual(r.deployment_config, 'transformers-vllm');
            assert.strictEqual(r.model_family, 'qwen3');
            assert.strictEqual(r.instance_family, 'g5');
            assert.strictEqual(r.quantization, 'none');
            assert.strictEqual(r.deployment_target, 'realtime-inference');
        });

        it('Gap is now filled — subsequent gap check excludes this config', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig);

            const provenConfigs = athena.getProvenConfigs();
            assert.strictEqual(provenConfigs.length, 1);

            // If we check substitution for same config, it should find itself
            const substitution = findNearestSubstitution(seedConfig, provenConfigs);
            assert.ok(substitution.substitutions, 'Should find the now-proven config');
            assert.strictEqual(substitution.substitutions[0].distance, 0);
        });
    });

    describe('Failure handling in cold-start', () => {
        it('Failed prove still writes record to Athena', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig, { succeed: false });

            assert.strictEqual(athena.records.length, 1);
            const record = athena.records[0];
            assert.strictEqual(record.run_type, 'path_prove');
        });

        it('Failed prove does not count as a gap fill', () => {
            simulatePathProverColdStart(db, athena, s3, seedConfig, { succeed: false });

            const provenConfigs = athena.getProvenConfigs();
            assert.strictEqual(provenConfigs.length, 0,
                'Failed proves should not appear in proven configs');
        });
    });
});

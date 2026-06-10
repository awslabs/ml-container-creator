// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Benchmark DynamoDB Invariant Preservation Property Tests
 *
 * Property P4: For any DynamoDB record with existing fields, executing
 * Stage 2 (success or failure) SHALL NOT modify pre-existing field values.
 * Only lastBenchmarkRunId, lastBenchmarkTimestamp, lastBenchmarkStatus
 * may be added or changed.
 *
 * Also tests backward compatibility: old records without benchmark fields
 * read without errors via applyRecordDefaults().
 *
 * Feature: ci-benchmark-pipeline
 */

import fc from 'fast-check';
import { describe, it } from 'mocha';
import assert from 'assert';
import {
    buildCiRecord,
    buildBenchmarkFields,
    applyRecordDefaults,
    computeConfigId
} from '../../src/lib/ci-register-helpers.js';

const FAST_PROPERTY_CONFIG = {
    numRuns: parseInt(process.env.PROPERTY_NUM_RUNS || '100', 10),
    verbose: false
};

// ── Generators ───────────────────────────────────────────────────────────────

const arbDeploymentConfig = fc.constantFrom(
    'transformers-vllm', 'transformers-sglang', 'transformers-lmi',
    'transformers-djl', 'http-flask', 'http-fastapi',
    'triton-fil', 'triton-python', 'diffusors-vllm'
);

const arbModelName = fc.oneof(
    fc.constant('Qwen/Qwen3-4B'),
    fc.constant('meta-llama/Llama-3.1-8B'),
    fc.constant('deepseek-ai/DeepSeek-R1-Distill-Qwen-7B'),
    fc.constant('microsoft/Phi-4'),
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-/'.split('')), { minLength: 3, maxLength: 40 }).map(arr => arr.join(''))
);

const arbInstanceType = fc.constantFrom(
    'ml.g5.xlarge', 'ml.g5.2xlarge', 'ml.g5.12xlarge', 'ml.g5.48xlarge',
    'ml.g6.xlarge', 'ml.g6e.xlarge', 'ml.p4d.24xlarge', 'ml.p5.48xlarge'
);

const arbRegion = fc.constantFrom(
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1'
);

const arbDeploymentTarget = fc.constantFrom(
    'realtime-inference', 'async-inference', 'batch-transform', 'hyperpod-eks'
);

const arbBaseImage = fc.constantFrom(
    'vllm/vllm-openai:v0.8.5',
    'nvcr.io/nvidia/tritonserver:24.01-py3',
    'custom-image:latest',
    'my-registry/my-image:1.2.3',
    'sglang/sglang:v0.4.0'
);

const arbBaseImageVersion = fc.constantFrom(
    'v0.8.5', '24.01-py3', 'latest', '1.2.3', 'v0.4.0'
);

const arbProjectName = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    { minLength: 3, maxLength: 20 }
).map(arr => arr.join(''));

const arbBuildStrategy = fc.constantFrom(
    'codebuild-submit', 'local-docker', 'codebuild-custom'
);

const arbTestStatus = fc.constantFrom(
    'untested', 'passed', 'failed', 'running'
);

const arbTimestamp = fc.integer({
    min: new Date('2024-01-01T00:00:00Z').getTime(),
    max: new Date('2027-12-31T23:59:59Z').getTime()
}).map(ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));

const arbBenchmarkRunId = fc.array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-T'.split('')),
    { minLength: 10, maxLength: 30 }
).map(arr => `bmk-${arr.join('')}`);

const arbBenchmarkStatus = fc.constantFrom('completed', 'failed', 'in-progress');

/**
 * Generate a complete DynamoDB CI record with all existing fields populated.
 */
const arbExistingRecord = fc.record({
    deploymentConfig: arbDeploymentConfig,
    modelName: arbModelName,
    instanceType: arbInstanceType,
    region: arbRegion,
    deploymentTarget: arbDeploymentTarget,
    baseImage: arbBaseImage,
    baseImageVersion: arbBaseImageVersion,
    projectName: arbProjectName,
    buildStrategy: arbBuildStrategy,
    testStatus: arbTestStatus,
    lastTestTimestamp: arbTimestamp,
    createdAt: arbTimestamp,
    schemaVersion: fc.constant(1)
}).map(fields => {
    const configId = computeConfigId(
        fields.deploymentConfig,
        fields.modelName,
        fields.instanceType,
        fields.region,
        fields.deploymentTarget
    );
    const configJson = JSON.stringify({
        deploymentConfig: fields.deploymentConfig,
        modelName: fields.modelName,
        instanceType: fields.instanceType,
        awsRegion: fields.region,
        deploymentTarget: fields.deploymentTarget,
        baseImage: fields.baseImage,
        projectName: fields.projectName
    });
    return {
        configId,
        schemaVersion: fields.schemaVersion,
        configJson,
        testStatus: fields.testStatus,
        lastTestTimestamp: fields.lastTestTimestamp,
        deploymentConfig: fields.deploymentConfig,
        baseImage: fields.baseImage,
        baseImageVersion: fields.baseImageVersion,
        buildStrategy: fields.buildStrategy,
        projectName: fields.projectName,
        createdAt: fields.createdAt
    };
});

// ── Property P4: Benchmark Stage Preserves DynamoDB Record Invariants ────────

describe('Feature: ci-benchmark-pipeline, Property P4: Benchmark Stage Preserves DynamoDB Record Invariants', () => {

    /**
     * Validates: Requirements 1.4, 7.3
     *
     * For any DynamoDB record with existing fields, executing Stage 2
     * (success or failure) SHALL NOT modify pre-existing field values.
     * Only lastBenchmarkRunId, lastBenchmarkTimestamp, lastBenchmarkStatus
     * may be added or updated.
     */
    it('buildBenchmarkFields() only produces benchmark-specific fields, never existing record fields', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbExistingRecord,
            arbBenchmarkRunId,
            arbBenchmarkStatus,
            arbTimestamp,
            (existingRecord, runId, benchmarkStatus, timestamp) => {
                // Snapshot all existing field values before benchmark update
                const originalSnapshot = JSON.parse(JSON.stringify(existingRecord));

                // Build the benchmark update fields (simulates Stage 2 completion)
                const benchmarkUpdate = buildBenchmarkFields(runId, benchmarkStatus, timestamp);

                // Simulate the DynamoDB UpdateExpression: merge benchmark fields into record
                const updatedRecord = { ...existingRecord, ...benchmarkUpdate };

                // Assert: all original fields remain unchanged
                const existingFields = [
                    'configId', 'schemaVersion', 'configJson', 'testStatus',
                    'lastTestTimestamp', 'deploymentConfig', 'baseImage',
                    'baseImageVersion', 'buildStrategy', 'projectName', 'createdAt'
                ];

                for (const field of existingFields) {
                    assert.deepStrictEqual(
                        updatedRecord[field],
                        originalSnapshot[field],
                        `Field '${field}' was modified by benchmark update. ` +
                        `Expected: ${JSON.stringify(originalSnapshot[field])}, ` +
                        `Got: ${JSON.stringify(updatedRecord[field])}`
                    );
                }

                // Assert: only benchmark-specific fields are new/changed
                const allowedNewFields = new Set([
                    'lastBenchmarkRunId', 'lastBenchmarkTimestamp', 'lastBenchmarkStatus'
                ]);

                const newKeys = Object.keys(updatedRecord).filter(k => !(k in existingRecord));
                for (const key of newKeys) {
                    assert(
                        allowedNewFields.has(key),
                        `Unexpected new field '${key}' added by benchmark update. ` +
                        `Only ${[...allowedNewFields].join(', ')} are allowed.`
                    );
                }

                // Assert: benchmark fields have correct values
                assert.strictEqual(updatedRecord.lastBenchmarkRunId, runId);
                assert.strictEqual(updatedRecord.lastBenchmarkStatus, benchmarkStatus);
                assert.strictEqual(updatedRecord.lastBenchmarkTimestamp, timestamp);
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 1.4, 7.3
     *
     * Regardless of whether Stage 2 succeeds or fails, the testStatus
     * field SHALL never be modified by the benchmark update.
     */
    it('testStatus remains unchanged regardless of benchmark success or failure', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbExistingRecord,
            arbBenchmarkRunId,
            arbBenchmarkStatus,
            (existingRecord, runId, benchmarkStatus) => {
                const originalTestStatus = existingRecord.testStatus;

                // Apply benchmark fields (simulates both success and failure paths)
                const benchmarkUpdate = buildBenchmarkFields(runId, benchmarkStatus);
                const updatedRecord = { ...existingRecord, ...benchmarkUpdate };

                assert.strictEqual(
                    updatedRecord.testStatus,
                    originalTestStatus,
                    `testStatus changed from '${originalTestStatus}' to '${updatedRecord.testStatus}' ` +
                    `after benchmark with status '${benchmarkStatus}'`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 1.4, 7.3
     *
     * buildBenchmarkFields() returns exactly 3 keys and no others,
     * ensuring it cannot accidentally overwrite existing record fields.
     */
    it('buildBenchmarkFields() returns exactly 3 benchmark-specific keys', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbBenchmarkRunId,
            arbBenchmarkStatus,
            arbTimestamp,
            (runId, benchmarkStatus, timestamp) => {
                const fields = buildBenchmarkFields(runId, benchmarkStatus, timestamp);
                const keys = Object.keys(fields).sort();

                assert.deepStrictEqual(
                    keys,
                    ['lastBenchmarkRunId', 'lastBenchmarkStatus', 'lastBenchmarkTimestamp'],
                    `Expected exactly 3 benchmark keys, got: ${JSON.stringify(keys)}`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });
});

// ── Backward Compatibility Tests ─────────────────────────────────────────────

describe('Feature: ci-benchmark-pipeline, Property P4: Backward Compatibility - Records Without Benchmark Fields', () => {

    /**
     * Validates: Requirements 7.4
     *
     * Old records without any benchmark fields (lastBenchmarkRunId,
     * lastBenchmarkTimestamp, lastBenchmarkStatus, benchmarkEnabled)
     * can be read and processed by applyRecordDefaults() without errors.
     */
    it('applyRecordDefaults() handles records without benchmark fields without crashing', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbExistingRecord,
            (existingRecord) => {
                // Ensure record has NO benchmark fields (simulates old record)
                delete existingRecord.lastBenchmarkRunId;
                delete existingRecord.lastBenchmarkTimestamp;
                delete existingRecord.lastBenchmarkStatus;
                delete existingRecord.benchmarkEnabled;
                delete existingRecord.benchmarkConcurrencyLevels;

                // applyRecordDefaults should not throw
                const result = applyRecordDefaults(existingRecord);

                // Result should be the same object (mutates in place)
                assert.strictEqual(result, existingRecord);

                // benchmarkEnabled defaults to false
                assert.strictEqual(
                    result.benchmarkEnabled,
                    false,
                    `benchmarkEnabled should default to false, got: ${result.benchmarkEnabled}`
                );

                // No phantom benchmark history: lastBenchmarkRunId should remain absent
                assert.strictEqual(
                    result.lastBenchmarkRunId,
                    undefined,
                    `lastBenchmarkRunId should remain absent (undefined), got: ${result.lastBenchmarkRunId}`
                );
                assert.strictEqual(
                    result.lastBenchmarkTimestamp,
                    undefined,
                    `lastBenchmarkTimestamp should remain absent, got: ${result.lastBenchmarkTimestamp}`
                );
                assert.strictEqual(
                    result.lastBenchmarkStatus,
                    undefined,
                    `lastBenchmarkStatus should remain absent, got: ${result.lastBenchmarkStatus}`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 7.4
     *
     * benchmarkConcurrencyLevels gets a sensible default when absent.
     */
    it('applyRecordDefaults() provides default concurrency levels for old records', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbExistingRecord,
            (existingRecord) => {
                // Remove benchmark-related fields
                delete existingRecord.benchmarkEnabled;
                delete existingRecord.benchmarkConcurrencyLevels;

                const result = applyRecordDefaults(existingRecord);

                assert(
                    Array.isArray(result.benchmarkConcurrencyLevels),
                    'benchmarkConcurrencyLevels should be an array'
                );
                assert.deepStrictEqual(
                    result.benchmarkConcurrencyLevels,
                    [1, 4, 8],
                    `Default concurrency levels should be [1, 4, 8], got: ${JSON.stringify(result.benchmarkConcurrencyLevels)}`
                );
            }
        ), FAST_PROPERTY_CONFIG);
    });

    /**
     * Validates: Requirements 7.3, 7.4
     *
     * applyRecordDefaults() preserves all existing field values — it only
     * fills in missing attributes, never overwrites present ones.
     */
    it('applyRecordDefaults() preserves existing field values', function () {
        this.timeout(30000);

        fc.assert(fc.property(
            arbExistingRecord,
            (existingRecord) => {
                // Snapshot original values of fields that exist
                const originalConfigId = existingRecord.configId;
                const originalConfigJson = existingRecord.configJson;
                const originalTestStatus = existingRecord.testStatus;
                const originalDeploymentConfig = existingRecord.deploymentConfig;
                const originalBaseImage = existingRecord.baseImage;
                const originalCreatedAt = existingRecord.createdAt;

                applyRecordDefaults(existingRecord);

                assert.strictEqual(existingRecord.configId, originalConfigId);
                assert.strictEqual(existingRecord.configJson, originalConfigJson);
                assert.strictEqual(existingRecord.testStatus, originalTestStatus);
                assert.strictEqual(existingRecord.deploymentConfig, originalDeploymentConfig);
                assert.strictEqual(existingRecord.baseImage, originalBaseImage);
                assert.strictEqual(existingRecord.createdAt, originalCreatedAt);
            }
        ), FAST_PROPERTY_CONFIG);
    });
});

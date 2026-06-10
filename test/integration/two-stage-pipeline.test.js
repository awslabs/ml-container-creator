// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Two-Stage CI Pipeline Integration Tests
 *
 * Verifies the end-to-end orchestration logic of the two-stage pipeline:
 *   Stage 1: CI Gate (generate → build → push → deploy → test → register)
 *   Stage 2: Benchmark (benchmark → write → update DynamoDB)
 *
 * These tests mock CodeBuild execution and DynamoDB calls to verify:
 * 1. Happy path: benchmarkEnabled=true → Stage 2 runs → DynamoDB has benchmark fields
 * 2. Benchmark failure isolation: Stage 2 failure does NOT affect testStatus
 * 3. Stage 1 failure halts: no Stage 2 execution when Stage 1 fails
 * 4. Benchmark disabled: benchmarkEnabled=false → Stage 2 skipped
 *
 * Feature: ci-benchmark-pipeline
 * Task: 3.7 Write integration test for two-stage flow
 * Requirements: 1.2, 1.3, 1.4
 */

import { describe, it, beforeEach } from 'mocha'
import assert from 'assert'
import {
    buildCiRecord,
    applyRecordDefaults,
    buildBenchmarkFields,
    isBenchmarkEnabled,
    getBenchmarkConcurrencyLevels,
    hasBeenBenchmarked,
    computeConfigId
} from '../../src/lib/ci-register-helpers.js'
import {
    computeTestStatus,
    STAGE_ORDER,
    ALWAYS_RUN_STAGES,
    applySkipLogic
} from '../../src/lib/ci-stage-helpers.js'

// ── Mock Infrastructure ──────────────────────────────────────────────────────

/**
 * Simulated DynamoDB store — holds CI records keyed by configId.
 */
class MockDynamoDB {
    constructor() {
        this.records = new Map()
        this.updateCalls = []
    }

    putItem(record) {
        this.records.set(record.configId, { ...record })
    }

    getItem(configId) {
        const record = this.records.get(configId)
        return record ? { ...record } : null
    }

    updateItem(configId, fields) {
        this.updateCalls.push({ configId, fields: { ...fields } })
        const existing = this.records.get(configId)
        if (existing) {
            this.records.set(configId, { ...existing, ...fields })
        }
    }

    reset() {
        this.records.clear()
        this.updateCalls = []
    }
}

/**
 * Simulated CodeBuild execution for a lifecycle stage.
 * Returns structured stage results.
 */
function mockCodeBuildStage(stageName, { succeed = true, durationSeconds = 10, errorSummary = '' } = {}) {
    return {
        status: succeed ? 'pass' : 'fail',
        durationSeconds,
        logPointer: `s3://ci-logs/${stageName}/build-123`,
        errorSummary: succeed ? '' : (errorSummary || `${stageName} failed`)
    }
}

/**
 * Simulate the full Stage 1 execution (CI Gate).
 * Runs generate → validate → build → deploy_test → register → teardown → update
 *
 * @param {object} options - Simulation options
 * @param {string|null} options.failAtStage - Stage to fail at (null = all pass)
 * @returns {object} { stageResults, testStatus }
 */
function simulateStage1(options = {}) {
    const { failAtStage = null } = options
    const stageResults = {}

    for (const stage of STAGE_ORDER) {
        if (failAtStage && stage === failAtStage) {
            stageResults[stage] = mockCodeBuildStage(stage, { succeed: false })
            // Apply skip logic for remaining stages
            applySkipLogic(stageResults, stage)
            break
        }
        stageResults[stage] = mockCodeBuildStage(stage)
    }

    // If no failure, all stages pass
    if (!failAtStage) {
        for (const stage of STAGE_ORDER) {
            if (!stageResults[stage]) {
                stageResults[stage] = mockCodeBuildStage(stage)
            }
        }
    } else {
        // Ensure always-run stages still execute
        for (const stage of ALWAYS_RUN_STAGES) {
            if (!stageResults[stage] || stageResults[stage].status === 'skip') {
                stageResults[stage] = mockCodeBuildStage(stage)
            }
        }
    }

    const testStatus = computeTestStatus(stageResults)
    return { stageResults, testStatus }
}

/**
 * Simulate Stage 2 (Benchmark Stage).
 *
 * @param {object} options
 * @param {boolean} options.succeed - Whether the benchmark succeeds
 * @param {string} options.configId - The configId being benchmarked
 * @returns {object} { benchmarkFields, succeed }
 */
function simulateBenchmarkStage(options = {}) {
    const { succeed = true, configId = 'abc123def4567890' } = options
    const runId = `bmk-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}Z`
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

    const status = succeed ? 'completed' : 'failed'
    const benchmarkFields = buildBenchmarkFields(runId, status, timestamp)

    return { benchmarkFields, succeed, runId, timestamp }
}

/**
 * Simulate the full two-stage CI pipeline orchestration.
 *
 * @param {MockDynamoDB} db - Mock DynamoDB store
 * @param {object} record - The initial CI record (with defaults applied)
 * @param {object} options
 * @param {string|null} options.failAtStage - Stage 1 failure point
 * @param {boolean} options.benchmarkSucceeds - Whether benchmark stage succeeds
 * @returns {object} Pipeline execution result
 */
function simulateTwoStagePipeline(db, record, options = {}) {
    const { failAtStage = null, benchmarkSucceeds = true } = options
    const execution = {
        stage1Ran: false,
        stage2Ran: false,
        cleanRan: false,
        stage1Result: null,
        stage2Result: null
    }

    // ── Stage 1: CI Gate ──
    execution.stage1Ran = true
    const stage1 = simulateStage1({ failAtStage })
    execution.stage1Result = stage1

    // Update DynamoDB with Stage 1 results
    db.updateItem(record.configId, {
        testStatus: stage1.testStatus,
        stageResults: stage1.stageResults,
        lastTestTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    })

    // ── Decision: proceed to Stage 2? ──
    if (stage1.testStatus !== 'pass') {
        // Stage 1 failed — halt pipeline, only do/clean runs
        execution.cleanRan = true
        return execution
    }

    // Check if benchmark is enabled for this config
    const updatedRecord = db.getItem(record.configId)
    if (!isBenchmarkEnabled(record)) {
        // benchmarkEnabled=false → skip Stage 2
        execution.cleanRan = true
        return execution
    }

    // ── Stage 2: Benchmark (async, non-blocking) ──
    execution.stage2Ran = true
    const stage2 = simulateBenchmarkStage({
        succeed: benchmarkSucceeds,
        configId: record.configId
    })
    execution.stage2Result = stage2

    // Update DynamoDB with benchmark fields ONLY
    db.updateItem(record.configId, stage2.benchmarkFields)

    // do/clean always runs at the end
    execution.cleanRan = true

    return execution
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Two-Stage CI Pipeline Integration', function () {
    this.timeout(30000)

    let db
    let baseRecord

    beforeEach(() => {
        db = new MockDynamoDB()

        const configId = computeConfigId(
            'transformers-vllm',
            'Qwen/Qwen3-4B',
            'ml.g5.xlarge',
            'us-east-1',
            'realtime-inference'
        )

        baseRecord = buildCiRecord(configId, JSON.stringify({
            deploymentConfig: 'transformers-vllm',
            modelName: 'Qwen/Qwen3-4B',
            instanceType: 'ml.g5.xlarge',
            region: 'us-east-1',
            deploymentTarget: 'realtime-inference'
        }), {
            deploymentConfig: 'transformers-vllm',
            baseImage: 'vllm/vllm-openai:v0.8.5',
            baseImageVersion: 'v0.8.5',
            projectName: 'test-qwen3-4b'
        })

        // Apply defaults (includes benchmarkEnabled, benchmarkConcurrencyLevels)
        applyRecordDefaults(baseRecord)
        db.putItem(baseRecord)
    })

    // ── Requirement 1.2: Happy path (benchmarkEnabled=true) ──

    describe('Happy path: benchmarkEnabled=true, Stage 1 passes', () => {

        beforeEach(() => {
            baseRecord.benchmarkEnabled = true
            db.putItem(baseRecord)
        })

        it('Stage 2 runs after Stage 1 success', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord)

            assert.strictEqual(execution.stage1Ran, true, 'Stage 1 should have run')
            assert.strictEqual(execution.stage2Ran, true, 'Stage 2 should have run when benchmarkEnabled=true and Stage 1 passes')
        })

        it('DynamoDB record has benchmark fields after Stage 2', () => {
            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.ok(finalRecord.lastBenchmarkRunId, 'lastBenchmarkRunId should be set')
            assert.ok(finalRecord.lastBenchmarkTimestamp, 'lastBenchmarkTimestamp should be set')
            assert.strictEqual(finalRecord.lastBenchmarkStatus, 'completed', 'lastBenchmarkStatus should be completed')
        })

        it('testStatus remains "pass" after successful benchmark', () => {
            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.testStatus, 'pass', 'testStatus should still be pass after benchmark')
        })

        it('hasBeenBenchmarked returns true after Stage 2', () => {
            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(hasBeenBenchmarked(finalRecord), true)
        })

        it('stageResults from Stage 1 are preserved', () => {
            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.ok(finalRecord.stageResults, 'stageResults should be present')
            assert.strictEqual(computeTestStatus(finalRecord.stageResults), 'pass')
        })

        it('do/clean runs at the end', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord)
            assert.strictEqual(execution.cleanRan, true, 'do/clean should run at the end of the pipeline')
        })

        it('benchmark concurrency levels are accessible for Stage 2', () => {
            baseRecord.benchmarkConcurrencyLevels = [1, 8, 16, 32]
            db.putItem(baseRecord)

            const levels = getBenchmarkConcurrencyLevels(baseRecord)
            assert.deepStrictEqual(levels, [1, 8, 16, 32])
        })
    })

    // ── Requirement 1.4: Benchmark failure isolation ──

    describe('Benchmark failure isolation: Stage 2 failure does not affect testStatus', () => {

        beforeEach(() => {
            baseRecord.benchmarkEnabled = true
            db.putItem(baseRecord)
        })

        it('testStatus remains "pass" when benchmark fails', () => {
            simulateTwoStagePipeline(db, baseRecord, { benchmarkSucceeds: false })

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.testStatus, 'pass',
                'testStatus MUST remain pass even when benchmark fails (Requirement 1.4)')
        })

        it('lastBenchmarkStatus is "failed" when benchmark fails', () => {
            simulateTwoStagePipeline(db, baseRecord, { benchmarkSucceeds: false })

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.lastBenchmarkStatus, 'failed',
                'lastBenchmarkStatus should record the benchmark outcome separately')
        })

        it('lastBenchmarkRunId is set even on failure', () => {
            simulateTwoStagePipeline(db, baseRecord, { benchmarkSucceeds: false })

            const finalRecord = db.getItem(baseRecord.configId)
            assert.ok(finalRecord.lastBenchmarkRunId,
                'lastBenchmarkRunId should be set even when benchmark fails')
        })

        it('existing record fields (configJson, schemaVersion, etc.) are unchanged after benchmark failure', () => {
            const originalConfigJson = baseRecord.configJson
            const originalSchemaVersion = baseRecord.schemaVersion
            const originalDeploymentConfig = baseRecord.deploymentConfig
            const originalBaseImage = baseRecord.baseImage
            const originalProjectName = baseRecord.projectName
            const originalCreatedAt = baseRecord.createdAt

            simulateTwoStagePipeline(db, baseRecord, { benchmarkSucceeds: false })

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.configJson, originalConfigJson)
            assert.strictEqual(finalRecord.schemaVersion, originalSchemaVersion)
            assert.strictEqual(finalRecord.deploymentConfig, originalDeploymentConfig)
            assert.strictEqual(finalRecord.baseImage, originalBaseImage)
            assert.strictEqual(finalRecord.projectName, originalProjectName)
            assert.strictEqual(finalRecord.createdAt, originalCreatedAt)
        })

        it('DynamoDB update only touches benchmark-specific fields on Stage 2', () => {
            simulateTwoStagePipeline(db, baseRecord, { benchmarkSucceeds: false })

            // Find the Stage 2 update call (the last one should be benchmark fields)
            const benchmarkUpdate = db.updateCalls.find(call =>
                call.fields.lastBenchmarkRunId !== undefined
            )
            assert.ok(benchmarkUpdate, 'Should have a benchmark-specific update call')

            // Verify only benchmark fields are in the update
            const updateKeys = Object.keys(benchmarkUpdate.fields)
            const allowedKeys = ['lastBenchmarkRunId', 'lastBenchmarkTimestamp', 'lastBenchmarkStatus']
            for (const key of updateKeys) {
                assert.ok(allowedKeys.includes(key),
                    `Benchmark update should only contain benchmark fields, found: ${key}`)
            }
        })
    })

    // ── Requirement 1.3: Stage 1 failure halts pipeline ──

    describe('Stage 1 failure halts pipeline: no Stage 2 execution', () => {

        beforeEach(() => {
            baseRecord.benchmarkEnabled = true
            db.putItem(baseRecord)
        })

        it('Stage 2 does NOT run when Stage 1 fails at build', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord, { failAtStage: 'build' })

            assert.strictEqual(execution.stage1Ran, true, 'Stage 1 should run')
            assert.strictEqual(execution.stage2Ran, false, 'Stage 2 MUST NOT run when Stage 1 fails')
        })

        it('Stage 2 does NOT run when Stage 1 fails at deploy_test', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord, { failAtStage: 'deploy_test' })

            assert.strictEqual(execution.stage2Ran, false, 'Stage 2 MUST NOT run when deploy_test fails')
        })

        it('Stage 2 does NOT run when Stage 1 fails at generate', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord, { failAtStage: 'generate' })

            assert.strictEqual(execution.stage2Ran, false, 'Stage 2 MUST NOT run when generate fails')
        })

        it('Stage 2 does NOT run when Stage 1 fails at validate', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord, { failAtStage: 'validate' })

            assert.strictEqual(execution.stage2Ran, false, 'Stage 2 MUST NOT run when validate fails')
        })

        it('do/clean still runs after Stage 1 failure', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord, { failAtStage: 'build' })

            assert.strictEqual(execution.cleanRan, true, 'do/clean MUST run even when Stage 1 fails')
        })

        it('testStatus reflects the Stage 1 failure', () => {
            simulateTwoStagePipeline(db, baseRecord, { failAtStage: 'build' })

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.testStatus, 'fail-build',
                'testStatus should indicate which stage failed')
        })

        it('no benchmark fields are written when Stage 1 fails', () => {
            simulateTwoStagePipeline(db, baseRecord, { failAtStage: 'deploy_test' })

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.lastBenchmarkRunId, undefined,
                'No benchmark fields should be written when Stage 1 fails')
            assert.strictEqual(finalRecord.lastBenchmarkTimestamp, undefined)
            assert.strictEqual(finalRecord.lastBenchmarkStatus, undefined)
        })

        it('DynamoDB updates only include Stage 1 results (no benchmark update)', () => {
            simulateTwoStagePipeline(db, baseRecord, { failAtStage: 'build' })

            const benchmarkUpdates = db.updateCalls.filter(call =>
                call.fields.lastBenchmarkRunId !== undefined
            )
            assert.strictEqual(benchmarkUpdates.length, 0,
                'No benchmark-related DynamoDB updates should occur when Stage 1 fails')
        })
    })

    // ── Requirement 1.2: benchmarkEnabled=false skips Stage 2 ──

    describe('Benchmark disabled: benchmarkEnabled=false skips Stage 2', () => {

        beforeEach(() => {
            baseRecord.benchmarkEnabled = false
            db.putItem(baseRecord)
        })

        it('Stage 2 is skipped when benchmarkEnabled=false', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord)

            assert.strictEqual(execution.stage1Ran, true, 'Stage 1 should run')
            assert.strictEqual(execution.stage2Ran, false, 'Stage 2 should be skipped when benchmarkEnabled=false')
        })

        it('testStatus is "pass" after Stage 1 success with benchmark disabled', () => {
            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.testStatus, 'pass')
        })

        it('no benchmark fields are added when benchmarkEnabled=false', () => {
            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.lastBenchmarkRunId, undefined,
                'No benchmark fields should be added when benchmarkEnabled=false')
            assert.strictEqual(finalRecord.lastBenchmarkTimestamp, undefined)
            assert.strictEqual(finalRecord.lastBenchmarkStatus, undefined)
        })

        it('do/clean still runs', () => {
            const execution = simulateTwoStagePipeline(db, baseRecord)
            assert.strictEqual(execution.cleanRan, true)
        })

        it('hasBeenBenchmarked returns false', () => {
            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(hasBeenBenchmarked(finalRecord), false)
        })

        it('isBenchmarkEnabled reflects the config setting', () => {
            assert.strictEqual(isBenchmarkEnabled(baseRecord), false)
        })

        it('existing record fields are unchanged', () => {
            const originalConfigJson = baseRecord.configJson
            const originalDeploymentConfig = baseRecord.deploymentConfig

            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.strictEqual(finalRecord.configJson, originalConfigJson)
            assert.strictEqual(finalRecord.deploymentConfig, originalDeploymentConfig)
        })
    })

    // ── Edge cases ──

    describe('Edge cases', () => {

        it('record without benchmarkEnabled defaults to false (Stage 2 skipped)', () => {
            // Remove benchmarkEnabled entirely to simulate legacy record
            delete baseRecord.benchmarkEnabled
            db.putItem(baseRecord)

            // Re-apply defaults — benchmarkEnabled should default to false
            const recordWithDefaults = applyRecordDefaults({ ...baseRecord })
            assert.strictEqual(isBenchmarkEnabled(recordWithDefaults), false)

            const execution = simulateTwoStagePipeline(db, baseRecord)
            assert.strictEqual(execution.stage2Ran, false,
                'Stage 2 should be skipped for legacy records without benchmarkEnabled')
        })

        it('DynamoDB update sequence is correct: Stage 1 then Stage 2', () => {
            baseRecord.benchmarkEnabled = true
            db.putItem(baseRecord)

            simulateTwoStagePipeline(db, baseRecord)

            assert.strictEqual(db.updateCalls.length, 2,
                'Should have exactly 2 DynamoDB updates (Stage 1 + Stage 2)')

            // First update: Stage 1 results (testStatus)
            const stage1Update = db.updateCalls[0]
            assert.ok('testStatus' in stage1Update.fields,
                'First update should contain testStatus from Stage 1')

            // Second update: Stage 2 results (benchmark fields)
            const stage2Update = db.updateCalls[1]
            assert.ok('lastBenchmarkRunId' in stage2Update.fields,
                'Second update should contain benchmark fields from Stage 2')
        })

        it('benchmark timestamp is in valid ISO 8601 format', () => {
            baseRecord.benchmarkEnabled = true
            db.putItem(baseRecord)

            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.match(finalRecord.lastBenchmarkTimestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
                'Benchmark timestamp should be ISO 8601 without milliseconds')
        })

        it('benchmark runId follows expected naming pattern', () => {
            baseRecord.benchmarkEnabled = true
            db.putItem(baseRecord)

            simulateTwoStagePipeline(db, baseRecord)

            const finalRecord = db.getItem(baseRecord.configId)
            assert.match(finalRecord.lastBenchmarkRunId, /^bmk-/,
                'Benchmark runId should start with bmk- prefix')
        })
    })
})

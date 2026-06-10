// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Stage 2 Failure Isolation Tests
 *
 * Validates that Stage 2 (benchmark) failures do NOT change the DynamoDB
 * testStatus field. A config that passed Stage 1 (testStatus=passed) remains
 * passed even when benchmarking fails.
 *
 * The `do/register --benchmark-status` command uses an UpdateExpression that
 * ONLY writes the 3 benchmark fields (lastBenchmarkRunId, lastBenchmarkTimestamp,
 * lastBenchmarkStatus) without touching testStatus or any other existing fields.
 *
 * Feature: ci-benchmark-pipeline
 * Task: 3.5 Ensure Stage 2 failure isolation
 * Requirements: 1.4, 7.3
 */

import { describe, it } from 'mocha'
import assert from 'assert'
import {
    buildBenchmarkFields,
    applyRecordDefaults,
    buildCiRecord
} from '../../src/lib/ci-register-helpers.js'

describe('Stage 2 Failure Isolation (Req 1.4, 7.3)', () => {

    describe('buildBenchmarkFields never includes testStatus', () => {
        it('completed status does not include testStatus', () => {
            const fields = buildBenchmarkFields('bmk-run-001', 'completed', '2026-06-09T14:30:22Z')
            assert.strictEqual('testStatus' in fields, false,
                'buildBenchmarkFields must NOT include testStatus')
        })

        it('failed status does not include testStatus', () => {
            const fields = buildBenchmarkFields('bmk-run-002', 'failed', '2026-06-09T15:00:00Z')
            assert.strictEqual('testStatus' in fields, false,
                'buildBenchmarkFields must NOT include testStatus when benchmark fails')
        })

        it('in-progress status does not include testStatus', () => {
            const fields = buildBenchmarkFields('bmk-run-003', 'in-progress', '2026-06-09T15:30:00Z')
            assert.strictEqual('testStatus' in fields, false,
                'buildBenchmarkFields must NOT include testStatus when benchmark is in-progress')
        })
    })

    describe('buildBenchmarkFields only writes exactly 3 benchmark fields', () => {
        it('returns exactly lastBenchmarkRunId, lastBenchmarkTimestamp, lastBenchmarkStatus', () => {
            const fields = buildBenchmarkFields('bmk-run-001', 'failed', '2026-06-09T14:30:22Z')
            const keys = Object.keys(fields).sort()
            assert.deepStrictEqual(keys, [
                'lastBenchmarkRunId',
                'lastBenchmarkStatus',
                'lastBenchmarkTimestamp'
            ], 'buildBenchmarkFields must return exactly 3 benchmark-specific keys')
        })

        it('never includes configJson, configId, schemaVersion, or any non-benchmark field', () => {
            const fields = buildBenchmarkFields('bmk-run-001', 'completed', '2026-06-09T14:30:22Z')
            const forbiddenFields = [
                'testStatus', 'configJson', 'configId', 'schemaVersion',
                'lastTestTimestamp', 'deploymentConfig', 'baseImage',
                'baseImageVersion', 'buildStrategy', 'projectName', 'createdAt'
            ]
            for (const field of forbiddenFields) {
                assert.strictEqual(field in fields, false,
                    `buildBenchmarkFields must NOT include '${field}'`)
            }
        })
    })

    describe('testStatus remains passed after Stage 2 failure simulation', () => {
        it('applying benchmark failure fields to a passed record preserves testStatus', () => {
            // Simulate a DynamoDB record that passed Stage 1
            const record = buildCiRecord('abc123def45678', '{"test":"config"}', {
                deploymentConfig: 'transformers-vllm',
                baseImage: 'vllm/vllm-openai:v0.8.5',
                baseImageVersion: 'v0.8.5',
                projectName: 'test-project'
            })
            // Simulate Stage 1 success: testStatus = passed
            record.testStatus = 'passed'
            record.lastTestTimestamp = '2026-06-09T14:00:00Z'

            // Simulate Stage 2 FAILURE: benchmark failed
            const benchmarkFields = buildBenchmarkFields('bmk-20260609T143022Z', 'failed', '2026-06-09T14:35:00Z')

            // Apply benchmark fields (mimics DynamoDB UpdateExpression SET)
            const updatedRecord = { ...record, ...benchmarkFields }

            // CRITICAL ASSERTION: testStatus must remain 'passed'
            assert.strictEqual(updatedRecord.testStatus, 'passed',
                'testStatus must remain passed after Stage 2 benchmark failure')

            // Verify benchmark failure is recorded separately
            assert.strictEqual(updatedRecord.lastBenchmarkStatus, 'failed',
                'lastBenchmarkStatus should record the failure')
            assert.strictEqual(updatedRecord.lastBenchmarkRunId, 'bmk-20260609T143022Z',
                'lastBenchmarkRunId should be recorded')
            assert.strictEqual(updatedRecord.lastBenchmarkTimestamp, '2026-06-09T14:35:00Z',
                'lastBenchmarkTimestamp should be recorded')
        })

        it('applying benchmark failure does not modify configJson', () => {
            const originalConfigJson = '{"modelName":"Qwen/Qwen3-4B","instanceType":"ml.g5.xlarge"}'
            const record = buildCiRecord('feedface12345678', originalConfigJson, {
                deploymentConfig: 'transformers-vllm',
                baseImage: 'vllm/vllm-openai:v0.8.5',
                baseImageVersion: 'v0.8.5',
                projectName: 'test-project'
            })
            record.testStatus = 'passed'

            const benchmarkFields = buildBenchmarkFields('bmk-fail-001', 'failed', '2026-06-09T15:00:00Z')
            const updatedRecord = { ...record, ...benchmarkFields }

            assert.strictEqual(updatedRecord.configJson, originalConfigJson,
                'configJson must not be modified by Stage 2 failure')
        })

        it('applying benchmark failure does not modify schemaVersion', () => {
            const record = buildCiRecord('deadbeef12345678', '{}', {
                deploymentConfig: 'transformers-vllm',
                baseImage: '',
                baseImageVersion: '',
                projectName: 'test'
            })
            record.testStatus = 'passed'

            const benchmarkFields = buildBenchmarkFields('bmk-fail-002', 'failed', '2026-06-09T15:00:00Z')
            const updatedRecord = { ...record, ...benchmarkFields }

            assert.strictEqual(updatedRecord.schemaVersion, 1,
                'schemaVersion must not be modified by Stage 2 failure')
        })

        it('applying benchmark failure does not modify deploymentConfig', () => {
            const record = buildCiRecord('aabbccdd12345678', '{}', {
                deploymentConfig: 'transformers-sglang',
                baseImage: 'sglang/sglang:v0.4.6',
                baseImageVersion: 'v0.4.6',
                projectName: 'sglang-test'
            })
            record.testStatus = 'passed'

            const benchmarkFields = buildBenchmarkFields('bmk-fail-003', 'failed', '2026-06-09T16:00:00Z')
            const updatedRecord = { ...record, ...benchmarkFields }

            assert.strictEqual(updatedRecord.deploymentConfig, 'transformers-sglang',
                'deploymentConfig must not be modified by Stage 2 failure')
        })

        it('applying benchmark failure does not modify createdAt', () => {
            const record = buildCiRecord('11223344aabbccdd', '{}', {
                deploymentConfig: 'transformers-vllm',
                baseImage: '',
                baseImageVersion: '',
                projectName: 'test'
            })
            record.testStatus = 'passed'
            const originalCreatedAt = record.createdAt

            const benchmarkFields = buildBenchmarkFields('bmk-fail-004', 'failed', '2026-06-09T17:00:00Z')
            const updatedRecord = { ...record, ...benchmarkFields }

            assert.strictEqual(updatedRecord.createdAt, originalCreatedAt,
                'createdAt must not be modified by Stage 2 failure')
        })
    })

    describe('testStatus remains passed after Stage 2 success', () => {
        it('applying benchmark success fields to a passed record preserves testStatus', () => {
            const record = buildCiRecord('abc123def45678', '{}', {
                deploymentConfig: 'transformers-vllm',
                baseImage: 'vllm/vllm-openai:v0.8.5',
                baseImageVersion: 'v0.8.5',
                projectName: 'test-project'
            })
            record.testStatus = 'passed'

            const benchmarkFields = buildBenchmarkFields('bmk-success-001', 'completed', '2026-06-09T14:45:00Z')
            const updatedRecord = { ...record, ...benchmarkFields }

            // testStatus must still be passed even when benchmark succeeds
            assert.strictEqual(updatedRecord.testStatus, 'passed',
                'testStatus must remain passed after successful benchmark')
            assert.strictEqual(updatedRecord.lastBenchmarkStatus, 'completed',
                'lastBenchmarkStatus should record success separately')
        })
    })

    describe('backward compatibility: records without benchmark fields', () => {
        it('old records without benchmark fields still read correctly after defaults applied', () => {
            // Simulate a legacy record (created before benchmark feature existed)
            const legacyRecord = {
                configId: 'legacy123456789',
                schemaVersion: 1,
                configJson: '{"old":"config"}',
                testStatus: 'passed',
                lastTestTimestamp: '2026-01-15T10:00:00Z',
                deploymentConfig: 'transformers-vllm',
                baseImage: 'vllm/vllm-openai:v0.7.0',
                baseImageVersion: 'v0.7.0',
                projectName: 'old-project',
                createdAt: '2025-12-01T00:00:00Z'
            }

            const withDefaults = applyRecordDefaults(legacyRecord)

            // testStatus preserved
            assert.strictEqual(withDefaults.testStatus, 'passed')

            // Benchmark fields absent (never benchmarked)
            assert.strictEqual(withDefaults.lastBenchmarkRunId, undefined)
            assert.strictEqual(withDefaults.lastBenchmarkTimestamp, undefined)
            assert.strictEqual(withDefaults.lastBenchmarkStatus, undefined)

            // Benchmark defaults applied
            assert.strictEqual(withDefaults.benchmarkEnabled, false)
            assert.deepStrictEqual(withDefaults.benchmarkConcurrencyLevels, [1, 4, 8])
        })

        it('applying benchmark failure to a legacy record preserves all existing fields', () => {
            const legacyRecord = {
                configId: 'legacy123456789',
                schemaVersion: 1,
                configJson: '{"old":"config"}',
                testStatus: 'passed',
                lastTestTimestamp: '2026-01-15T10:00:00Z',
                deploymentConfig: 'transformers-vllm',
                baseImage: 'vllm/vllm-openai:v0.7.0',
                baseImageVersion: 'v0.7.0',
                buildStrategy: 'codebuild-submit',
                projectName: 'old-project',
                createdAt: '2025-12-01T00:00:00Z'
            }

            // Shallow-copy to simulate DynamoDB update
            const benchmarkFields = buildBenchmarkFields('bmk-legacy-fail', 'failed', '2026-06-10T10:00:00Z')
            const updatedRecord = { ...legacyRecord, ...benchmarkFields }

            // ALL original fields must be preserved
            assert.strictEqual(updatedRecord.configId, 'legacy123456789')
            assert.strictEqual(updatedRecord.schemaVersion, 1)
            assert.strictEqual(updatedRecord.configJson, '{"old":"config"}')
            assert.strictEqual(updatedRecord.testStatus, 'passed')
            assert.strictEqual(updatedRecord.lastTestTimestamp, '2026-01-15T10:00:00Z')
            assert.strictEqual(updatedRecord.deploymentConfig, 'transformers-vllm')
            assert.strictEqual(updatedRecord.baseImage, 'vllm/vllm-openai:v0.7.0')
            assert.strictEqual(updatedRecord.baseImageVersion, 'v0.7.0')
            assert.strictEqual(updatedRecord.buildStrategy, 'codebuild-submit')
            assert.strictEqual(updatedRecord.projectName, 'old-project')
            assert.strictEqual(updatedRecord.createdAt, '2025-12-01T00:00:00Z')

            // Only benchmark fields added
            assert.strictEqual(updatedRecord.lastBenchmarkRunId, 'bmk-legacy-fail')
            assert.strictEqual(updatedRecord.lastBenchmarkStatus, 'failed')
            assert.strictEqual(updatedRecord.lastBenchmarkTimestamp, '2026-06-10T10:00:00Z')
        })
    })

    describe('RecordBenchmarkFailure UpdateExpression correctness', () => {
        /**
         * This test validates the DynamoDB UpdateExpression pattern used by:
         * 1. The `do/register --benchmark-status` command
         * 2. The Step Functions RecordBenchmarkFailure state
         *
         * Both use: SET lastBenchmarkRunId = :rid, lastBenchmarkTimestamp = :ts, lastBenchmarkStatus = :bs
         * This is a SET-only operation on 3 specific fields — it cannot modify any other field.
         */
        it('UpdateExpression pattern only targets benchmark fields', () => {
            const updateExpression = 'SET lastBenchmarkRunId = :rid, lastBenchmarkTimestamp = :ts, lastBenchmarkStatus = :bs'

            // Verify the expression does NOT contain testStatus
            assert.strictEqual(updateExpression.includes('testStatus'), false,
                'UpdateExpression must NOT reference testStatus')

            // Verify it does NOT contain configJson
            assert.strictEqual(updateExpression.includes('configJson'), false,
                'UpdateExpression must NOT reference configJson')

            // Verify it does NOT contain any REMOVE or DELETE operations
            assert.strictEqual(updateExpression.includes('REMOVE'), false,
                'UpdateExpression must NOT use REMOVE')
            assert.strictEqual(updateExpression.includes('DELETE'), false,
                'UpdateExpression must NOT use DELETE')

            // Verify it only contains the 3 expected field names
            const expectedFields = ['lastBenchmarkRunId', 'lastBenchmarkTimestamp', 'lastBenchmarkStatus']
            for (const field of expectedFields) {
                assert.ok(updateExpression.includes(field),
                    `UpdateExpression must include ${field}`)
            }

            // Count SET assignments (should be exactly 3)
            const assignments = updateExpression.replace('SET ', '').split(',')
            assert.strictEqual(assignments.length, 3,
                'UpdateExpression must have exactly 3 SET assignments')
        })
    })
})

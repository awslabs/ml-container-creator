// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Register Benchmark Status Unit Tests
 *
 * Tests the --benchmark-status mode of do/register template:
 *   - Argument parsing for --benchmark-status and --benchmark-run-id
 *   - Validation of benchmark status values
 *   - DynamoDB UpdateExpression uses only the 3 benchmark fields
 *   - Existing fields (testStatus, configJson, etc.) are NOT modified
 *   - Early exit after benchmark update (does not fall through to CI or registry logic)
 *
 * Also tests the buildBenchmarkFields helper from ci-register-helpers.js.
 *
 * Validates: Requirements 7.2, 7.3
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildBenchmarkFields } from '../../src/lib/ci-register-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/register');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/register template with the given variables.
 */
function renderRegister(vars) {
    return ejs.render(templateContent, vars);
}

/** Base template variables for a real-time inference project */
function realtimeVars(overrides = {}) {
    return {
        projectName: 'my-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'codebuild',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        modelName: 'Qwen/Qwen3-4B',
        modelFormat: null,
        modelEnvVars: {},
        serverEnvVars: {},
        orderedEnvVars: [],
        baseImage: 'vllm/vllm-openai:v0.8.5',
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        icCpuCount: null,
        icMemorySize: null,
        icGpuCount: 1,
        icCopyCount: 1,
        icModelWeight: null,
        endpointInitialInstanceCount: null,
        endpointDataCapturePercent: null,
        endpointVariantName: null,
        endpointVolumeSize: null,
        inferenceAmiVersion: null,
        hfToken: null,
        hfTokenArn: null,
        ngcTokenArn: null,
        ngcApiKey: null,
        ...overrides
    };
}

describe('do/register --benchmark-status mode (Req 7.2, 7.3)', () => {

    describe('Argument parsing', () => {
        it('rendered script accepts --benchmark-status flag', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('--benchmark-status)'),
                'Register script must accept --benchmark-status argument'
            );
        });

        it('rendered script accepts --benchmark-status= format', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('--benchmark-status=*)'),
                'Register script must accept --benchmark-status=value format'
            );
        });

        it('rendered script accepts --benchmark-run-id flag', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('--benchmark-run-id)'),
                'Register script must accept --benchmark-run-id argument'
            );
        });

        it('rendered script accepts --benchmark-run-id= format', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('--benchmark-run-id=*)'),
                'Register script must accept --benchmark-run-id=value format'
            );
        });

        it('initializes BENCHMARK_STATUS and BENCHMARK_RUN_ID variables', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('BENCHMARK_STATUS=""'),
                'Register script must initialize BENCHMARK_STATUS to empty'
            );
            assert.ok(
                rendered.includes('BENCHMARK_RUN_ID=""'),
                'Register script must initialize BENCHMARK_RUN_ID to empty'
            );
        });
    });

    describe('Benchmark status validation', () => {
        it('validates benchmark status against allowed values (completed, failed, in-progress)', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('completed|failed|in-progress)'),
                'Register script must validate benchmark status values'
            );
        });

        it('rejects invalid benchmark status with error message', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('Invalid benchmark status'),
                'Register script must show error for invalid benchmark status'
            );
        });

        it('requires --benchmark-run-id when --benchmark-status is provided', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('--benchmark-run-id is required when using --benchmark-status'),
                'Register script must require --benchmark-run-id with --benchmark-status'
            );
        });
    });

    describe('DynamoDB UpdateExpression (Req 7.3 — only benchmark fields)', () => {
        it('uses UpdateExpression with SET for exactly 3 benchmark fields', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('--update-expression "SET lastBenchmarkRunId = :rid, lastBenchmarkTimestamp = :ts, lastBenchmarkStatus = :bs"'),
                'UpdateExpression must SET only lastBenchmarkRunId, lastBenchmarkTimestamp, lastBenchmarkStatus'
            );
        });

        it('does NOT use testStatus as a DynamoDB attribute in the benchmark update', () => {
            const rendered = renderRegister(realtimeVars());
            // Find the benchmark update section (between the if and exit 0/fi)
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            // testStatus should not appear in the update-expression or expression-attribute-values
            // It may appear in comments, which is acceptable
            assert.ok(
                !benchmarkSection.includes('testStatus = '),
                'Benchmark UpdateExpression must NOT set testStatus (Req 7.3)'
            );
            assert.ok(
                !benchmarkSection.includes('"testStatus"'),
                'Benchmark expression-attribute-values must NOT reference testStatus (Req 7.3)'
            );
        });

        it('does NOT include configJson in the benchmark update expression', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                !benchmarkSection.includes('configJson = '),
                'Benchmark UpdateExpression must NOT set configJson (Req 7.3)'
            );
        });

        it('does NOT include schemaVersion in the benchmark update expression', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                !benchmarkSection.includes('schemaVersion = '),
                'Benchmark UpdateExpression must NOT set schemaVersion (Req 7.3)'
            );
        });

        it('does NOT include deploymentConfig in the benchmark update expression', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                !benchmarkSection.includes('deploymentConfig = '),
                'Benchmark UpdateExpression must NOT set deploymentConfig (Req 7.3)'
            );
        });

        it('uses aws dynamodb update-item (not put-item)', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                benchmarkSection.includes('aws dynamodb update-item'),
                'Benchmark mode must use update-item (not put-item) to avoid overwriting fields'
            );
            assert.ok(
                !benchmarkSection.includes('aws dynamodb put-item'),
                'Benchmark mode must NOT use put-item (would overwrite existing fields)'
            );
        });

        it('provides expression-attribute-values for the 3 fields', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                benchmarkSection.includes(':rid'),
                'Expression attribute values must include :rid for run ID'
            );
            assert.ok(
                benchmarkSection.includes(':ts'),
                'Expression attribute values must include :ts for timestamp'
            );
            assert.ok(
                benchmarkSection.includes(':bs'),
                'Expression attribute values must include :bs for status'
            );
            // Verify the values reference the correct shell variables
            assert.ok(
                benchmarkSection.includes('${BENCHMARK_RUN_ID}'),
                'Expression :rid must reference ${BENCHMARK_RUN_ID}'
            );
            assert.ok(
                benchmarkSection.includes('${BENCHMARK_TIMESTAMP}'),
                'Expression :ts must reference ${BENCHMARK_TIMESTAMP}'
            );
            assert.ok(
                benchmarkSection.includes('${BENCHMARK_STATUS}'),
                'Expression :bs must reference ${BENCHMARK_STATUS}'
            );
        });
    });

    describe('Early exit behavior', () => {
        it('exits with 0 after successful benchmark update', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                benchmarkSection.includes('exit 0'),
                'Benchmark status mode must exit 0 after successful update'
            );
        });

        it('exits with 1 on failed benchmark update', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                benchmarkSection.includes('exit 1'),
                'Benchmark status mode must exit 1 when DynamoDB update fails'
            );
        });

        it('benchmark mode exits before reaching write_ci_record function definition', () => {
            const rendered = renderRegister(realtimeVars());
            // The benchmark section exits before reaching write_ci_record
            const benchmarkExitIdx = rendered.indexOf('exit 0\nfi', rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]'));
            const writeCiRecordIdx = rendered.indexOf('write_ci_record()');
            assert.ok(
                benchmarkExitIdx < writeCiRecordIdx,
                'Benchmark mode must exit before write_ci_record is defined/called'
            );
        });
    });

    describe('CI table check', () => {
        it('checks CI table existence before attempting benchmark update', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                benchmarkSection.includes('aws dynamodb describe-table'),
                'Benchmark mode must check if CI table exists before updating'
            );
        });

        it('exits gracefully when CI table does not exist', () => {
            const rendered = renderRegister(realtimeVars());
            const benchmarkStart = rendered.indexOf('if [ -n "${BENCHMARK_STATUS}" ]');
            const benchmarkEnd = rendered.indexOf('exit 0\nfi', benchmarkStart) + 'exit 0\nfi'.length;
            const benchmarkSection = rendered.substring(benchmarkStart, benchmarkEnd);
            assert.ok(
                benchmarkSection.includes('CI infrastructure not provisioned'),
                'Benchmark mode must show graceful message when table missing'
            );
        });
    });

    describe('Usage message', () => {
        it('includes benchmark-status usage in the help text', () => {
            const rendered = renderRegister(realtimeVars());
            assert.ok(
                rendered.includes('--benchmark-status <completed|failed|in-progress> --benchmark-run-id <run-id>'),
                'Usage message must document --benchmark-status and --benchmark-run-id flags'
            );
        });
    });
});

describe('buildBenchmarkFields helper (Req 7.2, 7.3)', () => {

    it('returns only the 3 benchmark fields', () => {
        const fields = buildBenchmarkFields('bmk-20260609T143022Z', 'completed');
        const keys = Object.keys(fields);
        assert.deepStrictEqual(keys.sort(), [
            'lastBenchmarkRunId',
            'lastBenchmarkStatus',
            'lastBenchmarkTimestamp'
        ]);
    });

    it('sets lastBenchmarkRunId to the provided runId', () => {
        const fields = buildBenchmarkFields('bmk-test-123', 'completed');
        assert.strictEqual(fields.lastBenchmarkRunId, 'bmk-test-123');
    });

    it('sets lastBenchmarkStatus to the provided status', () => {
        const fields = buildBenchmarkFields('bmk-xxx', 'failed');
        assert.strictEqual(fields.lastBenchmarkStatus, 'failed');
    });

    it('uses provided timestamp when given', () => {
        const fields = buildBenchmarkFields('bmk-xxx', 'completed', '2026-06-09T14:30:22Z');
        assert.strictEqual(fields.lastBenchmarkTimestamp, '2026-06-09T14:30:22Z');
    });

    it('generates a timestamp when none provided', () => {
        const fields = buildBenchmarkFields('bmk-xxx', 'completed');
        assert.ok(fields.lastBenchmarkTimestamp);
        assert.ok(fields.lastBenchmarkTimestamp.endsWith('Z'));
        // Should be a valid ISO 8601 date
        const date = new Date(fields.lastBenchmarkTimestamp);
        assert.ok(!isNaN(date.getTime()));
    });

    it('accepts "in-progress" status', () => {
        const fields = buildBenchmarkFields('bmk-running', 'in-progress');
        assert.strictEqual(fields.lastBenchmarkStatus, 'in-progress');
    });

    it('throws for invalid status value', () => {
        assert.throws(
            () => buildBenchmarkFields('bmk-xxx', 'invalid'),
            /Invalid benchmark status/
        );
    });

    it('throws for empty runId', () => {
        assert.throws(
            () => buildBenchmarkFields('', 'completed'),
            /Benchmark runId is required/
        );
    });

    it('throws for null runId', () => {
        assert.throws(
            () => buildBenchmarkFields(null, 'completed'),
            /Benchmark runId is required/
        );
    });

    it('does NOT include testStatus in returned fields', () => {
        const fields = buildBenchmarkFields('bmk-xxx', 'completed');
        assert.strictEqual(fields.testStatus, undefined);
    });

    it('does NOT include configJson in returned fields', () => {
        const fields = buildBenchmarkFields('bmk-xxx', 'completed');
        assert.strictEqual(fields.configJson, undefined);
    });

    it('does NOT include any non-benchmark field', () => {
        const fields = buildBenchmarkFields('bmk-xxx', 'completed');
        const allowedKeys = ['lastBenchmarkRunId', 'lastBenchmarkTimestamp', 'lastBenchmarkStatus'];
        for (const key of Object.keys(fields)) {
            assert.ok(
                allowedKeys.includes(key),
                `Unexpected field "${key}" in benchmark fields — only benchmark-specific fields allowed (Req 7.3)`
            );
        }
    });
});

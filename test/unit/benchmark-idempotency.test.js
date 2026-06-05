// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for benchmark idempotency features.
 *
 * Tests that the do/benchmark template contains idempotency logic:
 * - _update_benchmark_var calls for BENCHMARK_JOB_NAME and BENCHMARK_WORKLOAD_CONFIG_NAME
 * - Resume logic (RESUME_EXISTING, describe-ai-benchmark-job for existing job check)
 * - --force flag that skips existing job check
 * - Workload config idempotency (describe-ai-workload-config, comparison logic)
 * - do/config contains BENCHMARK_JOB_NAME and BENCHMARK_WORKLOAD_CONFIG_NAME initialization
 * - Failed/Stopped status suggests --force
 *
 * Feature: sagemaker-ai-benchmarking
 * Validates: Requirement 4.1
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const benchmarkTemplate = readFileSync(
    path.join(__dirname, '../../templates/do/benchmark'),
    'utf8'
);

const configTemplate = readFileSync(
    path.join(__dirname, '../../templates/do/config'),
    'utf8'
);

/** Base template variables for config rendering */
function baseVars(overrides = {}) {
    return {
        projectName: 'test-project',
        deploymentConfig: 'transformers-vllm',
        framework: 'transformers',
        modelServer: 'vllm',
        awsRegion: 'us-east-1',
        buildTarget: 'local',
        deploymentTarget: 'realtime-inference',
        instanceType: 'ml.g5.xlarge',
        inferenceAmiVersion: undefined,
        roleArn: 'arn:aws:iam::123456789012:role/SageMakerRole',
        modelName: 'meta-llama/Llama-2-7b',
        hfToken: 'hf_test_token',
        hfTokenArn: undefined,
        ngcApiKey: undefined,
        ngcTokenArn: undefined,
        modelFormat: undefined,
        hyperPodCluster: undefined,
        hyperPodNamespace: undefined,
        hyperPodReplicas: undefined,
        fsxVolumeHandle: undefined,
        codebuildComputeType: undefined,
        orderedEnvVars: [],
        baseImage: '',
        includeBenchmark: true,
        benchmarkConcurrency: 10,
        benchmarkInputTokensMean: 550,
        benchmarkOutputTokensMean: 150,
        benchmarkStreaming: true,
        benchmarkRequestCount: null,
        benchmarkS3OutputPath: '',
        ...overrides
    };
}

describe('Benchmark Idempotency', () => {

    describe('do/benchmark template: _update_benchmark_var persistence', () => {
        it('should contain _update_benchmark_var call for BENCHMARK_JOB_NAME', () => {
            assert.ok(
                benchmarkTemplate.includes('_update_benchmark_var "BENCHMARK_JOB_NAME"'),
                'must persist BENCHMARK_JOB_NAME via _update_benchmark_var'
            );
        });

        it('should contain _update_benchmark_var call for BENCHMARK_WORKLOAD_CONFIG_NAME', () => {
            assert.ok(
                benchmarkTemplate.includes('_update_benchmark_var "BENCHMARK_WORKLOAD_CONFIG_NAME"'),
                'must persist BENCHMARK_WORKLOAD_CONFIG_NAME via _update_benchmark_var'
            );
        });
    });

    describe('do/benchmark template: resume logic', () => {
        it('should contain RESUME_EXISTING variable for resume detection', () => {
            assert.ok(
                benchmarkTemplate.includes('RESUME_EXISTING='),
                'must contain RESUME_EXISTING variable'
            );
        });

        it('should contain describe-ai-benchmark-job for existing job check', () => {
            assert.ok(
                benchmarkTemplate.includes('describe-ai-benchmark-job'),
                'must call describe-ai-benchmark-job to check existing job status'
            );
        });

        it('should check BENCHMARK_JOB_NAME before creating a new job', () => {
            assert.ok(
                benchmarkTemplate.includes('BENCHMARK_JOB_NAME'),
                'must reference BENCHMARK_JOB_NAME for idempotency check'
            );
        });
    });

    describe('do/benchmark template: --force flag', () => {
        it('should contain --force flag parsing', () => {
            assert.ok(
                benchmarkTemplate.includes('--force'),
                'must support --force flag'
            );
        });

        it('should skip existing job check when FORCE is true', () => {
            assert.ok(
                benchmarkTemplate.includes('FORCE'),
                'must use FORCE variable to skip existing job check'
            );
        });

        it('should check FORCE=false before resume logic', () => {
            assert.ok(
                benchmarkTemplate.includes('"${FORCE}" = false'),
                'must check FORCE=false condition before resume logic'
            );
        });
    });

    describe('do/benchmark template: workload config idempotency', () => {
        it('should contain describe-ai-workload-config for existence check', () => {
            assert.ok(
                benchmarkTemplate.includes('describe-ai-workload-config'),
                'must call describe-ai-workload-config to check if config exists'
            );
        });

        it('should contain comparison logic for existing config spec', () => {
            assert.ok(
                benchmarkTemplate.includes('EXISTING_NORMALIZED'),
                'must normalize existing config for comparison'
            );
            assert.ok(
                benchmarkTemplate.includes('DESIRED_NORMALIZED'),
                'must normalize desired config for comparison'
            );
        });

        it('should reuse config when params match', () => {
            assert.ok(
                benchmarkTemplate.includes('reusing'),
                'must indicate reuse when params match'
            );
        });

        it('should recreate config when params differ', () => {
            assert.ok(
                benchmarkTemplate.includes('recreating'),
                'must indicate recreation when params differ'
            );
        });

        it('should use CREATE_WORKLOAD_CONFIG flag to conditionally create', () => {
            assert.ok(
                benchmarkTemplate.includes('CREATE_WORKLOAD_CONFIG'),
                'must use CREATE_WORKLOAD_CONFIG flag'
            );
        });
    });

    describe('do/config template: benchmark state initialization', () => {
        it('should contain BENCHMARK_JOB_NAME initialization when includeBenchmark is true', () => {
            const output = ejs.render(configTemplate, baseVars());
            assert.ok(
                output.includes('BENCHMARK_JOB_NAME=""'),
                'must initialize BENCHMARK_JOB_NAME to empty string'
            );
        });

        it('should contain BENCHMARK_WORKLOAD_CONFIG_NAME initialization when includeBenchmark is true', () => {
            const output = ejs.render(configTemplate, baseVars());
            assert.ok(
                output.includes('BENCHMARK_WORKLOAD_CONFIG_NAME=""'),
                'must initialize BENCHMARK_WORKLOAD_CONFIG_NAME to empty string'
            );
        });

        it('should NOT export BENCHMARK_JOB_NAME when includeBenchmark is false', () => {
            const output = ejs.render(configTemplate, baseVars({ includeBenchmark: false }));
            // Check that no uncommented export line exists for this var
            const activeExport = output.split('\n').some(line =>
                line.trim().startsWith('export') && line.includes('BENCHMARK_JOB_NAME')
            );
            assert.ok(
                !activeExport,
                'must not actively export BENCHMARK_JOB_NAME when benchmark disabled'
            );
        });

        it('should NOT export BENCHMARK_WORKLOAD_CONFIG_NAME when includeBenchmark is false', () => {
            const output = ejs.render(configTemplate, baseVars({ includeBenchmark: false }));
            // Check that no uncommented export line exists for this var
            const activeExport = output.split('\n').some(line =>
                line.trim().startsWith('export') && line.includes('BENCHMARK_WORKLOAD_CONFIG_NAME')
            );
            assert.ok(
                !activeExport,
                'must not actively export BENCHMARK_WORKLOAD_CONFIG_NAME when benchmark disabled'
            );
        });
    });

    describe('do/benchmark template: Failed/Stopped suggests --force', () => {
        it('should suggest --force when previous job Failed or Stopped', () => {
            assert.ok(
                benchmarkTemplate.includes('Use --force to start a new benchmark'),
                'must suggest --force for Failed/Stopped jobs'
            );
        });

        it('should exit with error on Failed/Stopped status', () => {
            // Check that the Failed|Stopped case contains exit 1
            const failedSection = benchmarkTemplate.substring(
                benchmarkTemplate.indexOf('Failed|Stopped)'),
                benchmarkTemplate.indexOf(';;', benchmarkTemplate.indexOf('Failed|Stopped)'))
            );
            assert.ok(
                failedSection.includes('exit 1'),
                'must exit with error on Failed/Stopped status'
            );
        });

        it('should fetch FailureReason for Failed jobs', () => {
            const failedSection = benchmarkTemplate.substring(
                benchmarkTemplate.indexOf('Failed|Stopped)'),
                benchmarkTemplate.indexOf(';;', benchmarkTemplate.indexOf('Failed|Stopped)'))
            );
            assert.ok(
                failedSection.includes('FailureReason'),
                'must fetch FailureReason from describe-ai-benchmark-job'
            );
        });
    });
});

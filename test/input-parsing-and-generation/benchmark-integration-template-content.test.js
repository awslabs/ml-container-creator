// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for benchmark template content.
 *
 * Renders do/config and do/clean templates with includeBenchmark === true
 * and verifies that benchmark-specific content is present.
 * Also verifies do/benchmark template contains key orchestration content.
 *
 * Validates: Requirements 4.1-4.9, 5.1-5.3, 6.1-6.5
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load templates
const configTemplate = readFileSync(path.join(__dirname, '../../templates/do/config'), 'utf8');
const cleanTemplatePath = path.join(__dirname, '../../templates/do/clean');
const cleanTemplate = readFileSync(cleanTemplatePath, 'utf8');
const benchmarkTemplatePath = path.join(__dirname, '../../templates/do/benchmark');

/** Base template variables for benchmark rendering */
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

describe('Benchmark Integration: Generated template content', function () {
    this.timeout(30000);

    before(() => {
        console.log('\n🚀 Starting benchmark integration template content tests');
        console.log('📋 Validates: Requirements 4.1-4.9, 5.1-5.3, 6.1-6.5\n');
    });

    // ================================================================
    // Test 1: do/config has NO benchmark exports (FTP-4 cleanup)
    // Benchmark config is now resolved from MCP/profile at runtime.
    // ================================================================
    describe('do/config benchmark cleanup (FTP-4)', () => {
        it('should NOT contain any benchmark export statements', () => {
            const output = ejs.render(configTemplate, baseVars());
            const benchmarkExports = output.split('\n').filter(line =>
                line.trim().startsWith('export') && line.includes('BENCHMARK_')
            );
            assert.strictEqual(benchmarkExports.length, 0,
                `must contain zero benchmark exports, found: ${benchmarkExports.join(', ')}`);
        });

        it('should contain only a comment block for benchmarking', () => {
            const output = ejs.render(configTemplate, baseVars());
            assert.ok(
                output.includes('# Benchmark configuration is resolved from MCP/profile at runtime.'),
                'must contain the runtime resolution comment'
            );
        });

        it('should contain the SageMaker AI Benchmarking section header', () => {
            const output = ejs.render(configTemplate, baseVars());
            assert.ok(
                output.includes('SageMaker AI Benchmarking'),
                'must contain section header comment'
            );
        });

        it('should direct users to do/benchmark command', () => {
            const output = ejs.render(configTemplate, baseVars());
            assert.ok(
                output.includes('do/benchmark'),
                'must reference do/benchmark command'
            );
        });
    });

    // ================================================================
    // Test 2: do/benchmark template exists and contains key content
    // ================================================================
    describe('do/benchmark template', () => {
        it('should exist as a template file', () => {
            assert.ok(existsSync(benchmarkTemplatePath), 'templates/do/benchmark must exist');
        });

        it('should contain create-ai-workload-config command', () => {
            const content = readFileSync(benchmarkTemplatePath, 'utf8');
            assert.ok(
                content.includes('create-ai-workload-config'),
                'must contain create-ai-workload-config'
            );
        });

        it('should contain create-ai-benchmark-job command', () => {
            const content = readFileSync(benchmarkTemplatePath, 'utf8');
            assert.ok(
                content.includes('create-ai-benchmark-job'),
                'must contain create-ai-benchmark-job'
            );
        });

        it('should contain describe-ai-benchmark-job for polling', () => {
            const content = readFileSync(benchmarkTemplatePath, 'utf8');
            assert.ok(
                content.includes('describe-ai-benchmark-job'),
                'must contain describe-ai-benchmark-job for polling'
            );
        });

        it('should contain --clean flag support', () => {
            const content = readFileSync(benchmarkTemplatePath, 'utf8');
            assert.ok(
                content.includes('--clean'),
                'must contain --clean flag'
            );
        });
    });

    // ================================================================
    // Test 3: do/clean contains benchmark) case
    // ================================================================
    describe('do/clean with includeBenchmark === true', () => {
        it('should contain benchmark) case statement', () => {
            const output = ejs.render(cleanTemplate, baseVars(), { filename: cleanTemplatePath });
            assert.ok(
                output.includes('benchmark)'),
                'must contain benchmark) case'
            );
        });
    });
});

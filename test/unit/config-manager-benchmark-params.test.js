// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for benchmark parameter matrix entries in ConfigManager
 *
 * Verifies that the seven benchmark parameters exist in the ConfigManager
 * parameter matrix with correct CLI options, env vars, and defaults.
 * Also verifies loading from CLI options and config files.
 *
 * Feature: sagemaker-ai-benchmarking
 * Validates: Requirements 1.6, 2.6
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ConfigManager from '../../src/lib/config-manager.js';
import {
    createMockGenerator,
    createMockGeneratorWithOptions,
    cleanupEnvVars
} from '../helpers/mock-generator.js';

describe('ConfigManager Benchmark Parameter Matrix Entries', () => {
    let envVarsToCleanup = [];
    let tempFiles = [];

    afterEach(() => {
        cleanupEnvVars(envVarsToCleanup);
        envVarsToCleanup = [];
        tempFiles.forEach(f => {
            try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
        });
        tempFiles = [];
    });

    /**
     * Helper: get the parameter matrix from a fresh ConfigManager instance
     */
    function getParameterMatrix() {
        const mockGen = createMockGenerator();
        const cm = new ConfigManager(mockGen);
        return cm.parameterMatrix;
    }

    /**
     * Helper: create a temporary config file and return its path
     */
    function createTempConfigFile(config) {
        const tmpDir = os.tmpdir();
        const configPath = path.join(tmpDir, `benchmark-test-config-${Date.now()}.json`);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        tempFiles.push(configPath);
        return configPath;
    }

    describe('includeBenchmark (Requirement 1.6)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.includeBenchmark, 'includeBenchmark must exist in parameter matrix');
        });

        it('should have CLI option include-benchmark', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.includeBenchmark.cliOption, 'include-benchmark');
        });

        it('should have env var ML_INCLUDE_BENCHMARK', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.includeBenchmark.envVar, 'ML_INCLUDE_BENCHMARK');
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.includeBenchmark.configFile, true);
        });

        it('should default to false', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.includeBenchmark.default, false);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'include-benchmark': true });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.includeBenchmark, true);
        });

        it('should load from config file', async () => {
            const configPath = createTempConfigFile({ includeBenchmark: true });
            const mockGen = createMockGeneratorWithOptions({ config: configPath });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.includeBenchmark, true);
        });
    });

    describe('benchmarkConcurrency (Requirement 2.6)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.benchmarkConcurrency, 'benchmarkConcurrency must exist in parameter matrix');
        });

        it('should have CLI option benchmark-concurrency', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkConcurrency.cliOption, 'benchmark-concurrency');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkConcurrency.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkConcurrency.configFile, true);
        });

        it('should default to 10', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkConcurrency.default, 10);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'benchmark-concurrency': 20 });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkConcurrency, 20);
        });

        it('should load from config file', async () => {
            const configPath = createTempConfigFile({ benchmarkConcurrency: 25 });
            const mockGen = createMockGeneratorWithOptions({ config: configPath });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkConcurrency, 25);
        });
    });

    describe('benchmarkInputTokensMean (Requirement 2.6)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.benchmarkInputTokensMean, 'benchmarkInputTokensMean must exist in parameter matrix');
        });

        it('should have CLI option benchmark-input-tokens', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkInputTokensMean.cliOption, 'benchmark-input-tokens');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkInputTokensMean.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkInputTokensMean.configFile, true);
        });

        it('should default to 550', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkInputTokensMean.default, 550);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'benchmark-input-tokens': 1000 });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkInputTokensMean, 1000);
        });

        it('should load from config file', async () => {
            const configPath = createTempConfigFile({ benchmarkInputTokensMean: 800 });
            const mockGen = createMockGeneratorWithOptions({ config: configPath });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkInputTokensMean, 800);
        });
    });

    describe('benchmarkOutputTokensMean (Requirement 2.6)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.benchmarkOutputTokensMean, 'benchmarkOutputTokensMean must exist in parameter matrix');
        });

        it('should have CLI option benchmark-output-tokens', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkOutputTokensMean.cliOption, 'benchmark-output-tokens');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkOutputTokensMean.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkOutputTokensMean.configFile, true);
        });

        it('should default to 150', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkOutputTokensMean.default, 150);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'benchmark-output-tokens': 300 });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkOutputTokensMean, 300);
        });

        it('should load from config file', async () => {
            const configPath = createTempConfigFile({ benchmarkOutputTokensMean: 200 });
            const mockGen = createMockGeneratorWithOptions({ config: configPath });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkOutputTokensMean, 200);
        });
    });

    describe('benchmarkStreaming (Requirement 2.6)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.benchmarkStreaming, 'benchmarkStreaming must exist in parameter matrix');
        });

        it('should have CLI option benchmark-streaming', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkStreaming.cliOption, 'benchmark-streaming');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkStreaming.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkStreaming.configFile, true);
        });

        it('should default to true', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkStreaming.default, true);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'benchmark-streaming': false });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkStreaming, false);
        });

        it('should load from config file', async () => {
            const configPath = createTempConfigFile({ benchmarkStreaming: false });
            const mockGen = createMockGeneratorWithOptions({ config: configPath });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkStreaming, false);
        });
    });

    describe('benchmarkRequestCount (Requirement 2.6)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.benchmarkRequestCount, 'benchmarkRequestCount must exist in parameter matrix');
        });

        it('should have CLI option benchmark-request-count', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkRequestCount.cliOption, 'benchmark-request-count');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkRequestCount.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkRequestCount.configFile, true);
        });

        it('should default to null', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkRequestCount.default, null);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'benchmark-request-count': 500 });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkRequestCount, 500);
        });

        it('should load from config file', async () => {
            const configPath = createTempConfigFile({ benchmarkRequestCount: 1000 });
            const mockGen = createMockGeneratorWithOptions({ config: configPath });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkRequestCount, 1000);
        });
    });

    describe('benchmarkS3OutputPath (Requirement 2.6)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.benchmarkS3OutputPath, 'benchmarkS3OutputPath must exist in parameter matrix');
        });

        it('should have CLI option benchmark-s3-output-path', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkS3OutputPath.cliOption, 'benchmark-s3-output-path');
        });

        it('should have env var ML_BENCHMARK_S3_OUTPUT_PATH', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkS3OutputPath.envVar, 'ML_BENCHMARK_S3_OUTPUT_PATH');
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkS3OutputPath.configFile, true);
        });

        it('should default to null', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.benchmarkS3OutputPath.default, null);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'benchmark-s3-output-path': 's3://my-bucket/results/' });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkS3OutputPath, 's3://my-bucket/results/');
        });

        it('should load from config file', async () => {
            const configPath = createTempConfigFile({ benchmarkS3OutputPath: 's3://config-bucket/benchmark/' });
            const mockGen = createMockGeneratorWithOptions({ config: configPath });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.benchmarkS3OutputPath, 's3://config-bucket/benchmark/');
        });
    });
});

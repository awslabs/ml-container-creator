// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for async parameter matrix entries in ConfigManager
 *
 * Verifies that the four new async parameters exist in the ConfigManager
 * parameter matrix with correct CLI options, env vars, and defaults.
 * Also verifies deploymentTarget defaults to 'managed-inference'.
 *
 * Feature: async-inference-endpoint
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 10.3
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import ConfigManager from '../../src/lib/config-manager.js';
import {
    createMockGenerator,
    createMockGeneratorWithOptions,
    cleanupEnvVars
} from '../helpers/mock-generator.js';

describe('ConfigManager Async Parameter Matrix Entries', () => {
    let envVarsToCleanup = [];

    afterEach(() => {
        cleanupEnvVars(envVarsToCleanup);
        envVarsToCleanup = [];
    });

    /**
     * Helper: get the parameter matrix from a fresh ConfigManager instance
     */
    function getParameterMatrix() {
        const mockGen = createMockGenerator();
        const cm = new ConfigManager(mockGen);
        return cm.parameterMatrix;
    }

    describe('asyncS3OutputPath (Requirement 3.1)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.asyncS3OutputPath, 'asyncS3OutputPath must exist in parameter matrix');
        });

        it('should have CLI option async-s3-output-path', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncS3OutputPath.cliOption, 'async-s3-output-path');
        });

        it('should have env var ML_ASYNC_S3_OUTPUT_PATH', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncS3OutputPath.envVar, 'ML_ASYNC_S3_OUTPUT_PATH');
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncS3OutputPath.configFile, true);
        });

        it('should default to null', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncS3OutputPath.default, null);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'async-s3-output-path': 's3://my-bucket/output/' });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.asyncS3OutputPath, 's3://my-bucket/output/');
        });

        it('should load from environment variable', async () => {
            process.env.ML_ASYNC_S3_OUTPUT_PATH = 's3://env-bucket/output/';
            envVarsToCleanup.push('ML_ASYNC_S3_OUTPUT_PATH');

            const mockGen = createMockGenerator();
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.asyncS3OutputPath, 's3://env-bucket/output/');
        });
    });

    describe('asyncSnsSuccessTopic (Requirement 3.2)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.asyncSnsSuccessTopic, 'asyncSnsSuccessTopic must exist in parameter matrix');
        });

        it('should have CLI option async-sns-success-topic', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncSnsSuccessTopic.cliOption, 'async-sns-success-topic');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncSnsSuccessTopic.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncSnsSuccessTopic.configFile, true);
        });

        it('should default to null', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncSnsSuccessTopic.default, null);
        });

        it('should load from CLI option', async () => {
            const arn = 'arn:aws:sns:us-east-1:123456789012:my-success-topic';
            const mockGen = createMockGeneratorWithOptions({ 'async-sns-success-topic': arn });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.asyncSnsSuccessTopic, arn);
        });
    });

    describe('asyncSnsErrorTopic (Requirement 3.3)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.asyncSnsErrorTopic, 'asyncSnsErrorTopic must exist in parameter matrix');
        });

        it('should have CLI option async-sns-error-topic', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncSnsErrorTopic.cliOption, 'async-sns-error-topic');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncSnsErrorTopic.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncSnsErrorTopic.configFile, true);
        });

        it('should default to null', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncSnsErrorTopic.default, null);
        });

        it('should load from CLI option', async () => {
            const arn = 'arn:aws:sns:us-east-1:123456789012:my-error-topic';
            const mockGen = createMockGeneratorWithOptions({ 'async-sns-error-topic': arn });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.asyncSnsErrorTopic, arn);
        });
    });

    describe('asyncMaxConcurrentInvocations (Requirement 3.4)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.asyncMaxConcurrentInvocations, 'asyncMaxConcurrentInvocations must exist in parameter matrix');
        });

        it('should have CLI option async-max-concurrent', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncMaxConcurrentInvocations.cliOption, 'async-max-concurrent');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncMaxConcurrentInvocations.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncMaxConcurrentInvocations.configFile, true);
        });

        it('should default to 1', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.asyncMaxConcurrentInvocations.default, 1);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'async-max-concurrent': 5 });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.asyncMaxConcurrentInvocations, 5);
        });
    });

    describe('deploymentTarget default (Requirement 10.3)', () => {
        it('should default to managed-inference', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.deploymentTarget.default, 'managed-inference');
        });

        it('should apply managed-inference default when no value provided', async () => {
            const mockGen = createMockGenerator();
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.deploymentTarget, 'managed-inference');
        });
    });
});

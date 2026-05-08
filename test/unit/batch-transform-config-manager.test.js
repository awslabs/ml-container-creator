// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for batch parameter matrix entries in ConfigManager
 *
 * Verifies that the eight new batch parameters exist in the ConfigManager
 * parameter matrix with correct CLI options, env vars, and defaults.
 * Also verifies deploymentTarget defaults to 'realtime-inference'.
 *
 * Feature: batch-transform-endpoint
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 10.4
 */

import { describe, it, afterEach } from 'mocha';
import { strict as assert } from 'node:assert';
import ConfigManager from '../../src/lib/config-manager.js';
import {
    createMockGenerator,
    createMockGeneratorWithOptions,
    cleanupEnvVars
} from '../helpers/mock-generator.js';

describe('ConfigManager Batch Parameter Matrix Entries', () => {
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

    describe('batchInputPath (Requirement 3.1)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.batchInputPath, 'batchInputPath must exist in parameter matrix');
        });

        it('should have CLI option batch-input-path', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchInputPath.cliOption, 'batch-input-path');
        });

        it('should have env var ML_BATCH_INPUT_PATH', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchInputPath.envVar, 'ML_BATCH_INPUT_PATH');
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchInputPath.configFile, true);
        });

        it('should default to null', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchInputPath.default, null);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'batch-input-path': 's3://my-bucket/input/' });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchInputPath, 's3://my-bucket/input/');
        });

        it('should load from environment variable', async () => {
            process.env.ML_BATCH_INPUT_PATH = 's3://env-bucket/input/';
            envVarsToCleanup.push('ML_BATCH_INPUT_PATH');

            const mockGen = createMockGenerator();
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchInputPath, 's3://env-bucket/input/');
        });
    });

    describe('batchOutputPath (Requirement 3.2)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.batchOutputPath, 'batchOutputPath must exist in parameter matrix');
        });

        it('should have CLI option batch-output-path', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchOutputPath.cliOption, 'batch-output-path');
        });

        it('should have env var ML_BATCH_OUTPUT_PATH', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchOutputPath.envVar, 'ML_BATCH_OUTPUT_PATH');
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchOutputPath.configFile, true);
        });

        it('should default to null', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchOutputPath.default, null);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'batch-output-path': 's3://my-bucket/output/' });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchOutputPath, 's3://my-bucket/output/');
        });

        it('should load from environment variable', async () => {
            process.env.ML_BATCH_OUTPUT_PATH = 's3://env-bucket/output/';
            envVarsToCleanup.push('ML_BATCH_OUTPUT_PATH');

            const mockGen = createMockGenerator();
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchOutputPath, 's3://env-bucket/output/');
        });
    });

    describe('batchInstanceCount (Requirement 3.3)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.batchInstanceCount, 'batchInstanceCount must exist in parameter matrix');
        });

        it('should have CLI option batch-instance-count', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchInstanceCount.cliOption, 'batch-instance-count');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchInstanceCount.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchInstanceCount.configFile, true);
        });

        it('should default to 1', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchInstanceCount.default, 1);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'batch-instance-count': 4 });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchInstanceCount, 4);
        });
    });

    describe('batchSplitType (Requirement 3.4)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.batchSplitType, 'batchSplitType must exist in parameter matrix');
        });

        it('should have CLI option batch-split-type', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchSplitType.cliOption, 'batch-split-type');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchSplitType.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchSplitType.configFile, true);
        });

        it('should default to Line', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchSplitType.default, 'Line');
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'batch-split-type': 'RecordIO' });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchSplitType, 'RecordIO');
        });
    });

    describe('batchStrategy (Requirement 3.5)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.batchStrategy, 'batchStrategy must exist in parameter matrix');
        });

        it('should have CLI option batch-strategy', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchStrategy.cliOption, 'batch-strategy');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchStrategy.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchStrategy.configFile, true);
        });

        it('should default to MultiRecord', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchStrategy.default, 'MultiRecord');
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'batch-strategy': 'SingleRecord' });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchStrategy, 'SingleRecord');
        });
    });

    describe('batchJoinSource (Requirement 3.6)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.batchJoinSource, 'batchJoinSource must exist in parameter matrix');
        });

        it('should have CLI option batch-join-source', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchJoinSource.cliOption, 'batch-join-source');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchJoinSource.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchJoinSource.configFile, true);
        });

        it('should default to None', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchJoinSource.default, 'None');
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'batch-join-source': 'Input' });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchJoinSource, 'Input');
        });
    });

    describe('batchMaxConcurrentTransforms (Requirement 3.7)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.batchMaxConcurrentTransforms, 'batchMaxConcurrentTransforms must exist in parameter matrix');
        });

        it('should have CLI option batch-max-concurrent', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchMaxConcurrentTransforms.cliOption, 'batch-max-concurrent');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchMaxConcurrentTransforms.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchMaxConcurrentTransforms.configFile, true);
        });

        it('should default to 1', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchMaxConcurrentTransforms.default, 1);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'batch-max-concurrent': 10 });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchMaxConcurrentTransforms, 10);
        });
    });

    describe('batchMaxPayloadInMB (Requirement 3.8)', () => {
        it('should exist in the parameter matrix', () => {
            const matrix = getParameterMatrix();
            assert.ok(matrix.batchMaxPayloadInMB, 'batchMaxPayloadInMB must exist in parameter matrix');
        });

        it('should have CLI option batch-max-payload', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchMaxPayloadInMB.cliOption, 'batch-max-payload');
        });

        it('should have no env var', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchMaxPayloadInMB.envVar, null);
        });

        it('should support config file', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchMaxPayloadInMB.configFile, true);
        });

        it('should default to 6', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.batchMaxPayloadInMB.default, 6);
        });

        it('should load from CLI option', async () => {
            const mockGen = createMockGeneratorWithOptions({ 'batch-max-payload': 50 });
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.batchMaxPayloadInMB, 50);
        });
    });

    describe('deploymentTarget default (Requirement 10.4)', () => {
        it('should default to realtime-inference', () => {
            const matrix = getParameterMatrix();
            assert.equal(matrix.deploymentTarget.default, 'realtime-inference');
        });

        it('should apply realtime-inference default when no value provided', async () => {
            const mockGen = createMockGenerator();
            const cm = new ConfigManager(mockGen);
            const config = await cm.loadConfiguration();
            assert.equal(config.deploymentTarget, 'realtime-inference');
        });
    });
});

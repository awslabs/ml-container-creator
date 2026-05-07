// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Batch Transform Integration Tests
 *
 * Runs the CLI generator with batch-transform configuration
 * and verifies the generated file contents.
 *
 * Requirements: 4.1, 5.1, 6.1, 7.1, 13.1, 14.1, 14.2, 15.1
 */

import { runGenerator } from './helpers/run-generator.js';

describe('batch-transform integration: generated template content', function () {
    this.timeout(60000);

    let result;

    const batchOptions = {
        'skip-prompts': true,
        'project-name': 'test-batch-project',
        'deployment-config': 'http-flask',
        'model-format': 'pkl',
        'region': 'us-east-1',
        'deployment-target': 'batch-transform',
        'instance-type': 'ml.m5.large',
        'batch-input-path': 's3://test-bucket/input/',
        'batch-output-path': 's3://test-bucket/output/',
        'batch-instance-count': 2,
        'batch-split-type': 'Line',
        'batch-strategy': 'MultiRecord',
        'batch-join-source': 'None',
        'batch-max-concurrent': 1,
        'batch-max-payload': 6,
        'build-target': 'codebuild',
        'include-sample': false,
        'include-testing': false
    };

    beforeEach(() => {
        result = runGenerator(batchOptions);
    });

    afterEach(() => {
        result.cleanup();
    });

    // Requirement 7.1: do/config contains batch variables
    it('do/config contains batch variables when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/config', 'BATCH_INPUT_PATH');
        result.assertFileContent('do/config', 'BATCH_OUTPUT_PATH');
        result.assertFileContent('do/config', 'BATCH_INSTANCE_COUNT');
        result.assertFileContent('do/config', 'BATCH_SPLIT_TYPE');
        result.assertFileContent('do/config', 'BATCH_STRATEGY');
        result.assertFileContent('do/config', 'INSTANCE_TYPE');
    });

    // Requirement 4.1: do/deploy contains create-transform-job
    it('do/deploy contains create-transform-job when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/deploy', 'create-transform-job');
    });

    // Requirement 5.1: do/test contains describe-transform-job
    it('do/test contains describe-transform-job when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/test', 'describe-transform-job');
    });

    // Requirement 6.1: do/clean contains batch cleanup target
    it('do/clean contains batch cleanup target when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/clean', 'batch');
    });

    // Requirement 6.1: do/clean contains stop-transform-job
    it('do/clean contains stop-transform-job when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/clean', 'stop-transform-job');
    });

    // Requirement 13.1: do/logs contains /aws/sagemaker/TransformJobs
    it('do/logs contains /aws/sagemaker/TransformJobs when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/logs', '/aws/sagemaker/TransformJobs');
    });

    // Requirement 14.1: do/register summary contains BATCH_INSTANCE_COUNT
    it('do/register summary contains BATCH_INSTANCE_COUNT when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/register', 'BATCH_INSTANCE_COUNT');
    });

    // Requirement 14.2: do/register CLI args contain --instance-type
    it('do/register CLI args contain --instance-type when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/register', '--instance-type');
    });

    // Requirement 15.1: do/export contains --batch-input-path
    it('do/export contains --batch-input-path when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/export', '--batch-input-path');
    });

    // Requirement 15.1: do/export contains --instance-type
    it('do/export contains --instance-type when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/export', '--instance-type');
    });
});

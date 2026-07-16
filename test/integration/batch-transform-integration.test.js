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

import { runGenerator } from '../helpers/run-generator.js';
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.join(__dirname, '../../templates/do');

describe('batch-transform integration: generated template content', function () {
    this.timeout(60000);

    let result;

    const batchOptions = {
        'skip-prompts': true,
        'project-name': 'test-batch-project',
        'deployment-config': 'http-flask',
        'model-format': 'pkl',
        'region': 'us-east-1',
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
        result.assertFileContent('do/deploy.d/batch-transform', 'create-transform-job');
    });

    // Requirement 5.1: do/test contains describe-transform-job
    it('do/test contains describe-transform-job when deploymentTarget === batch-transform', () => {
        // do/test is a unified template with all target branches — check the template source
        const testTemplate = readFileSync(path.join(TEMPLATES_DIR, 'test'), 'utf8');
        assert.ok(testTemplate.includes('describe-transform-job'),
            'do/test template must contain describe-transform-job for batch-transform target');
    });

    // Requirement 6.1: do/clean contains batch cleanup target
    it('do/clean contains batch cleanup target when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/clean.d/batch-transform', 'batch');
    });

    // Requirement 6.1: do/clean contains stop-transform-job
    it('do/clean contains stop-transform-job when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/clean.d/batch-transform', 'stop-transform-job');
    });

    // Requirement 13.1: do/logs contains /aws/sagemaker/TransformJobs
    it('do/logs contains /aws/sagemaker/TransformJobs when deploymentTarget === batch-transform', () => {
        const logsTemplate = readFileSync(path.join(TEMPLATES_DIR, 'logs'), 'utf8');
        assert.ok(logsTemplate.includes('/aws/sagemaker/TransformJobs'),
            'do/logs template must contain /aws/sagemaker/TransformJobs for batch-transform target');
    });

    // Requirement 14.1: do/register summary contains BATCH_INSTANCE_COUNT
    it('do/register summary contains BATCH_INSTANCE_COUNT when deploymentTarget === batch-transform', () => {
        const registerTemplate = readFileSync(path.join(TEMPLATES_DIR, 'register'), 'utf8');
        assert.ok(registerTemplate.includes('BATCH_INSTANCE_COUNT'),
            'do/register template must contain BATCH_INSTANCE_COUNT for batch-transform target');
    });

    // Requirement 14.2: do/register CLI args contain --instance-type
    it('do/register CLI args contain --instance-type when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/register', '--instance-type');
    });

    // Requirement 15.1: do/export contains --batch-input-path
    it('do/export contains --batch-input-path when deploymentTarget === batch-transform', () => {
        const exportTemplate = readFileSync(path.join(TEMPLATES_DIR, 'export'), 'utf8');
        assert.ok(exportTemplate.includes('--batch-input-path'),
            'do/export template must contain --batch-input-path for batch-transform target');
    });

    // Requirement 15.1: do/export contains --instance-type
    it('do/export contains --instance-type when deploymentTarget === batch-transform', () => {
        result.assertFileContent('do/export', '--instance-type');
    });
});

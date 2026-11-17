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
import { execFileSync } from 'child_process';
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

    // Requirement 15.1 (updated by Wave 8 / BL160): do/export no longer hardcodes
    // per-target flags — it derives them at run time from do/config through the
    // schema's doConfigVar map. Run the generated script and check its output.
    // BATCH_INPUT_PATH / BATCH_OUTPUT_PATH are profile-resolved at deploy time
    // (b77ffd61), not do/config inputs, so they are not part of the export. This
    // suite's project keeps the default DEPLOYMENT_TARGET, so the export is run with
    // --target batch-transform (the same override do/deploy --target offers).
    function runExport(args = []) {
        const env = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (!/^(AWS_|BATCH_|INSTANCE_TYPE$|DEPLOYMENT_TARGET$)/.test(k)) env[k] = v;
        }
        return execFileSync('/bin/bash', [result.file('do/export'), ...args], {
            cwd: result.dir, env: { ...env, HOME: result.dir }, encoding: 'utf8'
        });
    }
    it('do/export emits the batch-transform flags from do/config', () => {
        const out = runExport(['--target', 'batch-transform']);
        assert.ok(out.includes('--deployment-target=batch-transform'), out);
        assert.ok(out.includes('--instance-type=ml.m5.large'), out);
        assert.ok(!out.includes('--batch-input-path'), 'profile-resolved batch paths are not exported');
    });
    it('do/export --json emits typed schema keys for batch-transform', () => {
        const data = JSON.parse(runExport(['--json', '--target', 'batch-transform']));
        assert.strictEqual(data.deploymentTarget, 'batch-transform');
        assert.strictEqual(data.instanceType, 'ml.m5.large');
        // Only what do/config declares is exported: this project was generated for the
        // default target, so its batch block is commented out and not exported.
        assert.ok(!('batchInstanceCount' in data), JSON.stringify(data));
    });
});

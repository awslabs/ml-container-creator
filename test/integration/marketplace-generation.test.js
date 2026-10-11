// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Refusal Integration Tests
 *
 * Marketplace deployment configs are deprecated and hard-refused: deploying a
 * pre-built vendor model package never builds a container, which violates this
 * tool's core promise (bring your own container). The generator must refuse with
 * a non-zero exit and a clear message, mirroring the JumpStart hard-refusal.
 *
 * The marketplace generation surface was removed (BL120); only the hard-refusal
 * remains, so generation must NOT produce a project.
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { runGenerator } from '../helpers/run-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../../bin/cli.js');

describe('Marketplace Refusal (Integration)', () => {

    /**
     * Runs the generator and returns the thrown wrapped error (exitCode/stderr),
     * failing the test if generation unexpectedly succeeds.
     */
    function runExpectingRefusal(args) {
        let result;
        try {
            result = runGenerator(args);
        } catch (error) {
            return error;
        }
        // Generation should never succeed for marketplace — clean up and fail.
        result.cleanup();
        throw new Error('Expected marketplace generation to be refused, but it succeeded');
    }

    /**
     * Runs the CLI against a JSON config file (bypassing Commander's per-flag enum
     * validation) and returns { exitCode, stderr, stdout }.
     */
    function runWithConfigFile(config) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcc-mkt-'));
        const configPath = path.join(tempDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(config));
        try {
            execFileSync(process.execPath, [
                CLI_PATH, '--skip-prompts', `--config=${configPath}`, `--project-dir=${tempDir}`
            ], { cwd: tempDir, env: { ...process.env, VALIDATE_ENV_VARS: 'false' }, stdio: 'pipe' });
        } catch (error) {
            return {
                exitCode: error.status,
                stderr: error.stderr ? error.stderr.toString() : '',
                stdout: error.stdout ? error.stdout.toString() : ''
            };
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        return { exitCode: 0, stderr: '', stdout: '' };
    }

    it('the CLI rejects --deployment-config=marketplace (not an allowed choice)', () => {
        // marketplace is no longer in the deployment-config enum, so Commander
        // itself rejects it at parse time with a non-zero exit.
        const error = runExpectingRefusal({
            'project-name': 'test-marketplace-refusal',
            'deployment-config': 'marketplace',
            'instance-type': 'ml.g5.xlarge',
            'region': 'us-east-1'
        });
        assert.equal(error.exitCode, 1, 'generator should exit non-zero');
        // Commander reports the invalid value and lists the allowed choices;
        // marketplace must not appear in that allowed-choices list.
        const allowedMatch = error.stderr.match(/[Aa]llowed choices are ([^.\n]*)/);
        assert.ok(allowedMatch, `expected an "allowed choices" list in stderr:\n${error.stderr}`);
        assert.doesNotMatch(allowedMatch[1], /marketplace/i, 'marketplace must not be an allowed choice');
    });

    it('refuses deploymentConfig=marketplace from a config file with the deprecation message', () => {
        const { exitCode, stderr } = runWithConfigFile({
            deploymentConfig: 'marketplace',
            instanceType: 'ml.g5.xlarge',
            region: 'us-east-1',
            projectName: 'cfg-mkt'
        });
        assert.equal(exitCode, 1, 'generator should exit non-zero');
        assert.match(stderr, /Marketplace deployments are no longer supported/);
        assert.match(stderr, /bring your own\s+container/i);
    });

    it('refuses a marketplace:// model name with the deprecation message', () => {
        const error = runExpectingRefusal({
            'project-name': 'test-marketplace-refusal-model',
            'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
            'instance-type': 'ml.g5.xlarge',
            'region': 'us-east-1'
        });
        assert.equal(error.exitCode, 1, 'generator should exit non-zero');
        assert.match(error.stderr, /Marketplace deployments are no longer supported/);
    });

    it('the deprecation message suggests BYOC alternatives (HuggingFace / s3 / registry)', () => {
        const error = runExpectingRefusal({
            'project-name': 'test-marketplace-refusal-alts',
            'model-name': 'marketplace://arn:aws:sagemaker:us-east-1:123456789012:model-package/test-model/1',
            'instance-type': 'ml.g5.xlarge',
            'region': 'us-east-1'
        });
        assert.match(error.stderr, /HuggingFace model ID/);
        assert.match(error.stderr, /s3:\/\//);
        assert.match(error.stderr, /registry:\/\//);
    });
});

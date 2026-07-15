// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * do/stage --update-config Tests
 *
 * Verifies:
 * 1. The do/stage template includes the --update-config flag
 * 2. The sed command correctly replaces MODEL_NAME in do/config
 * 3. The --update-config flag is documented in --help output
 *
 * Validates: Requirements FTP-2 (2.1, 2.2)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STAGE_TEMPLATE = path.join(PROJECT_ROOT, 'templates/do/stage');

describe('do/stage --update-config (FTP-2: 2.1, 2.2)', () => {
    it('stage template contains --update-config flag handling', () => {
        const content = fs.readFileSync(STAGE_TEMPLATE, 'utf8');
        assert.ok(
            content.includes('--update-config'),
            'do/stage template should contain --update-config flag'
        );
        assert.ok(
            content.includes('UPDATE_CONFIG=true'),
            'do/stage should set UPDATE_CONFIG=true when --update-config is passed'
        );
        assert.ok(
            content.includes('UPDATE_CONFIG=false'),
            'do/stage should initialize UPDATE_CONFIG=false'
        );
    });

    it('stage template uses sed to update MODEL_NAME in do/config', () => {
        const content = fs.readFileSync(STAGE_TEMPLATE, 'utf8');
        // Verify sed command targets the MODEL_NAME export line
        assert.ok(
            content.includes('sed -i.bak'),
            'do/stage should use sed -i.bak for in-place editing'
        );
        assert.ok(
            content.includes('export MODEL_NAME='),
            'sed pattern should target export MODEL_NAME= lines'
        );
        // Verify backup file cleanup
        assert.ok(
            content.includes('rm -f "${CONFIG_FILE}.bak"'),
            'do/stage should remove the .bak file after sed'
        );
    });

    it('stage template documents --update-config in --help output', () => {
        const content = fs.readFileSync(STAGE_TEMPLATE, 'utf8');
        assert.ok(
            content.includes('updates MODEL_NAME in do/config'),
            '--help output should describe --update-config'
        );
    });

    it('sed command correctly replaces MODEL_NAME in a config file', () => {
        // Create a temporary directory with a mock do/config
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcc-stage-test-'));
        const configFile = path.join(tmpDir, 'config');

        try {
            // Write a mock do/config with a HuggingFace model name
            fs.writeFileSync(configFile, [
                '#!/bin/bash',
                'export PROJECT_NAME="my-project"',
                'export MODEL_NAME="meta-llama/Llama-3.1-8B-Instruct"',
                'export AWS_REGION="us-east-1"',
                ''
            ].join('\n'));

            const s3Uri = 's3://my-bucket/models/my-project/';

            // Run the same sed command that do/stage uses
            execFileSync('sed', [
                '-i.bak',
                `s|^export MODEL_NAME=.*|export MODEL_NAME="${s3Uri}"|`,
                configFile
            ]);

            // Read the updated file
            const updated = fs.readFileSync(configFile, 'utf8');

            // Verify MODEL_NAME was updated
            assert.ok(
                updated.includes(`export MODEL_NAME="${s3Uri}"`),
                `Expected config to contain 'export MODEL_NAME="${s3Uri}"'\nActual:\n${updated}`
            );

            // Verify other exports were not modified
            assert.ok(
                updated.includes('export PROJECT_NAME="my-project"'),
                'PROJECT_NAME should not be modified'
            );
            assert.ok(
                updated.includes('export AWS_REGION="us-east-1"'),
                'AWS_REGION should not be modified'
            );

            // Verify the old model name is gone
            assert.ok(
                !updated.includes('meta-llama/Llama-3.1-8B-Instruct'),
                'Old model name should be replaced'
            );

            // Clean up .bak file
            const bakFile = `${configFile  }.bak`;
            assert.ok(
                fs.existsSync(bakFile),
                'sed should create a .bak backup file'
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('sed command handles S3 URIs with special characters in path', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcc-stage-test-'));
        const configFile = path.join(tmpDir, 'config');

        try {
            fs.writeFileSync(configFile, [
                '#!/bin/bash',
                'export MODEL_NAME="google/gemma-4-31b-it"',
                ''
            ].join('\n'));

            // S3 URI with hyphens and numbers in bucket/path
            const s3Uri = 's3://sagemaker-benchmark-us-east-2-946952788839/models/gemma-4-31b-vllm/';

            execFileSync('sed', [
                '-i.bak',
                `s|^export MODEL_NAME=.*|export MODEL_NAME="${s3Uri}"|`,
                configFile
            ]);

            const updated = fs.readFileSync(configFile, 'utf8');
            assert.ok(
                updated.includes(`export MODEL_NAME="${s3Uri}"`),
                `Expected config to contain full S3 URI\nActual:\n${updated}`
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('sed command handles MODEL_NAME with environment variable override syntax', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlcc-stage-test-'));
        const configFile = path.join(tmpDir, 'config');

        try {
            // Some generated configs use ${OVERRIDE:-default} pattern
            fs.writeFileSync(configFile, [
                '#!/bin/bash',
                'export MODEL_NAME=${MODEL_NAME:-meta-llama/Llama-3.1-8B}',
                ''
            ].join('\n'));

            const s3Uri = 's3://my-bucket/models/test/';

            execFileSync('sed', [
                '-i.bak',
                `s|^export MODEL_NAME=.*|export MODEL_NAME="${s3Uri}"|`,
                configFile
            ]);

            const updated = fs.readFileSync(configFile, 'utf8');
            assert.ok(
                updated.includes(`export MODEL_NAME="${s3Uri}"`),
                `Expected MODEL_NAME to be updated regardless of original format\nActual:\n${updated}`
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('stage template prints S3 URI on success', () => {
        const content = fs.readFileSync(STAGE_TEMPLATE, 'utf8');
        assert.ok(
            content.includes('S3 URI: ${MODEL_S3_URI}'),
            'do/stage should print the S3 URI on successful staging'
        );
    });

    it('stage template suggests re-deploy after --update-config', () => {
        const content = fs.readFileSync(STAGE_TEMPLATE, 'utf8');
        assert.ok(
            content.includes('Subsequent tasks (submit, deploy) will pull from S3'),
            'After --update-config, script should suggest running do/deploy'
        );
    });
});

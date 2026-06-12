// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * S3 Model URI Passthrough Tests
 *
 * Verifies that when modelName starts with 's3://', the full S3 URI passes
 * through unmodified to the generated do/config template as MODEL_NAME,
 * and that the serve script correctly handles the S3 model source.
 *
 * Validates: Requirements FTP-2 (2.1, 2.2, 2.4, 2.5)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runGenerator } from '../helpers/run-generator.js';
import fs from 'fs';

describe('S3 Model URI Passthrough (FTP-2: 2.1, 2.4)', () => {
    it('MODEL_NAME in do/config contains the full S3 URI unmodified', () => {
        const s3Uri = 's3://sagemaker-benchmark-us-east-2-946952788839/models/gemma-4-31b-vllm/';

        const result = runGenerator({
            'project-name': 'test-s3-passthrough',
            'deployment-config': 'transformers-vllm',
            'model-name': s3Uri,
            'instance-type': 'ml.g5.48xlarge',
            'region': 'us-east-1',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        try {
            result.assertFile('do/config');

            const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

            // MODEL_NAME should contain the exact S3 URI
            assert.ok(
                configContent.includes(`export MODEL_NAME="${s3Uri}"`),
                `Expected do/config to contain 'export MODEL_NAME="${s3Uri}"'\n` +
                `Actual MODEL_NAME line: ${configContent.split('\n').find(l => l.includes('MODEL_NAME')) || 'NOT FOUND'}`
            );

            // Verify the URI is not truncated or transformed
            assert.ok(
                configContent.includes('s3://sagemaker-benchmark-us-east-2-946952788839/models/gemma-4-31b-vllm/'),
                'S3 URI should be present in full, not truncated'
            );
        } finally {
            result.cleanup();
        }
    });

    it('S3 URI with minimal path passes through unmodified', () => {
        const s3Uri = 's3://my-bucket/model/';

        const result = runGenerator({
            'project-name': 'test-s3-short-path',
            'deployment-config': 'transformers-vllm',
            'model-name': s3Uri,
            'instance-type': 'ml.g5.xlarge',
            'region': 'us-west-2',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        try {
            result.assertFile('do/config');

            const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

            assert.ok(
                configContent.includes(`export MODEL_NAME="${s3Uri}"`),
                `Expected do/config to contain 'export MODEL_NAME="${s3Uri}"'\n` +
                `Actual MODEL_NAME line: ${configContent.split('\n').find(l => l.includes('MODEL_NAME')) || 'NOT FOUND'}`
            );
        } finally {
            result.cleanup();
        }
    });

    it('S3 URI with deep nested path passes through unmodified', () => {
        const s3Uri = 's3://company-models/prod/llm/v2/gemma-4-31b/weights/';

        const result = runGenerator({
            'project-name': 'test-s3-deep-path',
            'deployment-config': 'transformers-vllm',
            'model-name': s3Uri,
            'instance-type': 'ml.g5.12xlarge',
            'region': 'eu-west-1',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        try {
            result.assertFile('do/config');

            const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

            assert.ok(
                configContent.includes(`export MODEL_NAME="${s3Uri}"`),
                `Expected do/config to contain 'export MODEL_NAME="${s3Uri}"'\n` +
                `Actual MODEL_NAME line: ${configContent.split('\n').find(l => l.includes('MODEL_NAME')) || 'NOT FOUND'}`
            );
        } finally {
            result.cleanup();
        }
    });

    it('generate with s3://test-bucket/models/test-model/ — do/config and serve script are correct', () => {
        const s3Uri = 's3://test-bucket/models/test-model/';

        const result = runGenerator({
            'project-name': 'test-s3-config-and-serve',
            'deployment-config': 'transformers-vllm',
            'model-name': s3Uri,
            'instance-type': 'ml.g5.48xlarge',
            'region': 'us-east-1',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        try {
            // --- Verify do/config ---
            result.assertFile('do/config');
            const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

            // MODEL_NAME should contain the exact S3 URI
            assert.ok(
                configContent.includes(`export MODEL_NAME="${s3Uri}"`),
                `Expected do/config to contain 'export MODEL_NAME="${s3Uri}"'\n` +
                `Actual MODEL_NAME line: ${configContent.split('\n').find(l => l.includes('MODEL_NAME')) || 'NOT FOUND'}`
            );

            // --- Verify serve script ---
            result.assertFile('code/serve');
            const serveContent = fs.readFileSync(result.file('code/serve'), 'utf8');

            // Serve script should have MODEL_SOURCE variable handling
            assert.ok(
                serveContent.includes('MODEL_SOURCE='),
                'Serve script should reference MODEL_SOURCE for model resolution'
            );

            // Serve script should have the resolve_model function for S3 handling
            assert.ok(
                serveContent.includes('resolve_model'),
                'Serve script should contain resolve_model function for S3 model resolution'
            );

            // Serve script should define the VLLM_MODEL var reference (vLLM server)
            assert.ok(
                serveContent.includes('VLLM_MODEL'),
                'Serve script should reference VLLM_MODEL as the model variable for vLLM'
            );

            // Serve script should handle S3 source in the resolve_model case statement
            assert.ok(
                serveContent.includes('s3|registry'),
                'Serve script should handle s3 source in resolve_model case statement'
            );

            // Serve script should have the S3 download function
            assert.ok(
                serveContent.includes('download_model_from_s3'),
                'Serve script should define download_model_from_s3 function for S3 model downloads'
            );
        } finally {
            result.cleanup();
        }
    });
});

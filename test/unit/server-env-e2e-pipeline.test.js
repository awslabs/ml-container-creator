// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-End Test: --server-env Pipeline
 *
 * Generates a project with --server-env SM_VLLM_KV_CACHE_DTYPE=fp8, then verifies:
 * 1. The generated do/config contains an export line for the env var (with engine prefix)
 * 2. The generated do/deploy script injects the var into the container Environment
 *
 * Task 3.4: End-to-end test for server-env pipeline
 * Requirements: FTP-3 (3.1, 3.4, 3.5)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runGenerator } from '../helpers/run-generator.js';
import fs from 'fs';

describe('Server-Env E2E Pipeline (Task 3.4, FTP-3: 3.1, 3.4, 3.5)', () => {

    it('--server-env SM_VLLM_KV_CACHE_DTYPE=fp8 flows through to do/config and do/deploy', function () {
        const result = runGenerator({
            'project-name': 'test-server-env-e2e',
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-2-7b-hf',
            'instance-type': 'ml.g5.xlarge',
            'region': 'us-east-1',
            'build-target': 'codebuild',
            'include-benchmark': false,
            'server-env': ['SM_VLLM_KV_CACHE_DTYPE=fp8']
        });

        try {
            // --- Verify do/config ---
            result.assertFile('do/config');
            const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

            // The engine prefix resolver prepends VLLM_ to all --server-env keys for vllm engine.
            // So SM_VLLM_KV_CACHE_DTYPE becomes VLLM_SM_VLLM_KV_CACHE_DTYPE in the output.
            const expectedKey = 'VLLM_SM_VLLM_KV_CACHE_DTYPE';

            assert.ok(
                configContent.includes(`export ${expectedKey}=`),
                `do/config should contain 'export ${expectedKey}=' line.\n` +
                `Actual server-env lines: ${configContent.split('\n').filter(l => l.includes('VLLM_')).join('\n') || 'NONE FOUND'}`
            );

            // Verify the value fp8 is present in the export line
            assert.ok(
                configContent.includes('fp8'),
                'do/config should include value "fp8" in the export line'
            );

            // Verify the runtime-override pattern is used: ${KEY:-value}
            assert.ok(
                configContent.includes(`\${${expectedKey}:-fp8}`),
                `do/config should use runtime-override pattern: \${${expectedKey}:-fp8}`
            );

            // --- Verify do/deploy ---
            // The deploy template is a dispatcher that includes deploy.d/managed-inference.ejs
            // For realtime-inference (default), it renders managed-inference which has the
            // server env injection block
            const deployPath = result.file('do/deploy');
            assert.ok(
                fs.existsSync(deployPath),
                'do/deploy should exist in generated project'
            );

            const deployContent = fs.readFileSync(deployPath, 'utf8');

            // Verify the server env injection section exists
            assert.ok(
                deployContent.includes('Inject server environment variables into container Environment'),
                'do/deploy should contain server env injection section header'
            );

            // Verify the specific key is referenced in the deploy script
            assert.ok(
                deployContent.includes(expectedKey),
                `do/deploy should reference ${expectedKey} for injection into container Environment`
            );

            // Verify the injection pattern adds the var to CONTAINER_ENV_JSON
            assert.ok(
                deployContent.includes('CONTAINER_ENV_JSON'),
                'do/deploy should build CONTAINER_ENV_JSON with server env vars'
            );

        } finally {
            result.cleanup();
        }
    });

    it('multiple --server-env values all appear in do/config and do/deploy', function () {
        const result = runGenerator({
            'project-name': 'test-multi-server-env',
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-2-7b-hf',
            'instance-type': 'ml.g5.xlarge',
            'region': 'us-east-1',
            'build-target': 'codebuild',
            'include-benchmark': false,
            'server-env': [
                'SM_VLLM_KV_CACHE_DTYPE=fp8',
                'SM_VLLM_MAX_MODEL_LEN=32768',
                'SM_VLLM_GPU_MEMORY_UTILIZATION=0.95'
            ]
        });

        try {
            result.assertFile('do/config');
            const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

            // All vars get VLLM_ prefix prepended by the engine prefix resolver
            const expectedKeys = [
                'VLLM_SM_VLLM_KV_CACHE_DTYPE',
                'VLLM_SM_VLLM_MAX_MODEL_LEN',
                'VLLM_SM_VLLM_GPU_MEMORY_UTILIZATION'
            ];

            for (const key of expectedKeys) {
                assert.ok(
                    configContent.includes(`export ${key}=`),
                    `do/config should contain 'export ${key}='\n` +
                    `Actual content snippet: ${configContent.split('\n').filter(l => l.includes('VLLM_')).join('\n')}`
                );
            }

            // Verify do/deploy references all keys
            const deployContent = fs.readFileSync(result.file('do/deploy'), 'utf8');
            for (const key of expectedKeys) {
                assert.ok(
                    deployContent.includes(key),
                    `do/deploy should reference ${key} for container injection`
                );
            }

        } finally {
            result.cleanup();
        }
    });

    it('do/config server-env section has correct comment header', function () {
        const result = runGenerator({
            'project-name': 'test-server-env-header',
            'deployment-config': 'transformers-vllm',
            'model-name': 'meta-llama/Llama-2-7b-hf',
            'instance-type': 'ml.g5.xlarge',
            'region': 'us-east-1',
            'build-target': 'codebuild',
            'include-benchmark': false,
            'server-env': ['SM_VLLM_KV_CACHE_DTYPE=fp8']
        });

        try {
            const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

            assert.ok(
                configContent.includes('# Server environment variables'),
                'do/config should have "# Server environment variables" section header'
            );
        } finally {
            result.cleanup();
        }
    });
});

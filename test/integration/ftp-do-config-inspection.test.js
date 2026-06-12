// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Test: FTP do/config Inspection (Task 4.3)
 *
 * Generates a project with the customer FTP benchmark config and performs
 * detailed inspection of the generated do/config file to verify:
 *   1. MODEL_NAME is set to the full S3 URI
 *   2. CAPACITY_RESERVATION_ARN is set to the FTP ARN
 *   3. Server env exports are present (with VLLM_ engine prefix applied)
 *   4. No benchmark export statements exist
 *
 * Config used:
 *   --model-name s3://bucket/models/gemma-4-31b-vllm/
 *   --instance-type ml.p6-b200.48xlarge
 *   --capacity-reservation-arn arn:aws:sagemaker:us-east-2:123456789012:training-plan/tp-xxx
 *   --server-env SM_VLLM_TENSOR_PARALLEL_SIZE=8
 *   --server-env SM_VLLM_MAX_MODEL_LEN=32768
 *   --server-env SM_VLLM_GPU_MEMORY_UTILIZATION=0.95
 *
 * Requirements: FTP-2, FTP-3, FTP-4
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

const S3_MODEL_URI = 's3://bucket/models/gemma-4-31b-vllm/';
const CAPACITY_ARN = 'arn:aws:sagemaker:us-east-2:123456789012:training-plan/tp-xxx';
const SERVER_ENV_PAIRS = [
    'SM_VLLM_TENSOR_PARALLEL_SIZE=8',
    'SM_VLLM_MAX_MODEL_LEN=32768',
    'SM_VLLM_GPU_MEMORY_UTILIZATION=0.95'
];

describe('FTP do/config Inspection (Task 4.3, FTP-2, FTP-3, FTP-4)', function () {
    this.timeout(60000);

    let result;
    let configContent;

    before(function () {
        result = runGenerator({
            'project-name': 'ftp-config-inspect',
            'deployment-config': 'transformers-vllm',
            'model-name': S3_MODEL_URI,
            'instance-type': 'ml.p6-b200.48xlarge',
            'capacity-reservation-arn': CAPACITY_ARN,
            'server-env': SERVER_ENV_PAIRS,
            'region': 'us-east-2',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        result.assertFile('do/config');
        configContent = fs.readFileSync(result.file('do/config'), 'utf8');
    });

    after(function () {
        if (result) {
            result.cleanup();
        }
    });

    it('MODEL_NAME export contains the full S3 URI', function () {
        // The template renders: export MODEL_NAME="s3://bucket/models/gemma-4-31b-vllm/"
        assert.ok(
            configContent.includes(`export MODEL_NAME="${S3_MODEL_URI}"`),
            `Expected 'export MODEL_NAME="${S3_MODEL_URI}"' in do/config.\n` +
            `Actual MODEL_NAME lines:\n${configContent.split('\n').filter(l => l.includes('MODEL_NAME')).join('\n')}`
        );
    });

    it('CAPACITY_RESERVATION_ARN export contains the FTP ARN', function () {
        // The template renders: export CAPACITY_RESERVATION_ARN="arn:aws:sagemaker:..."
        assert.ok(
            configContent.includes(`export CAPACITY_RESERVATION_ARN="${CAPACITY_ARN}"`),
            `Expected 'export CAPACITY_RESERVATION_ARN="${CAPACITY_ARN}"' in do/config.\n` +
            `Actual CAPACITY_RESERVATION lines:\n${configContent.split('\n').filter(l => l.includes('CAPACITY_RESERVATION')).join('\n')}`
        );
    });

    it('server env exports are present with VLLM_ engine prefix', function () {
        // Engine prefix resolver prepends VLLM_ to all keys for the vllm engine.
        // SM_VLLM_TENSOR_PARALLEL_SIZE → VLLM_SM_VLLM_TENSOR_PARALLEL_SIZE
        const expectedExports = [
            { key: 'VLLM_SM_VLLM_TENSOR_PARALLEL_SIZE', value: '8' },
            { key: 'VLLM_SM_VLLM_MAX_MODEL_LEN', value: '32768' },
            { key: 'VLLM_SM_VLLM_GPU_MEMORY_UTILIZATION', value: '0.95' }
        ];

        for (const { key, value } of expectedExports) {
            // Template renders: export KEY=${KEY:-value}
            assert.ok(
                configContent.includes(`export ${key}=`),
                `Expected 'export ${key}=' in do/config.\n` +
                `Actual server env lines:\n${configContent.split('\n').filter(l => l.includes('VLLM_SM_VLLM_')).join('\n')}`
            );

            // Also verify the value is present in the same line context
            assert.ok(
                configContent.includes(value),
                `Expected value '${value}' to be present in do/config for key ${key}`
            );
        }
    });

    it('no benchmark export statements exist in do/config', function () {
        // Scan all lines starting with 'export' for benchmark-related vars
        const lines = configContent.split('\n');
        const benchmarkExports = lines.filter(l =>
            l.trim().startsWith('export') && (
                l.includes('BENCHMARK_') ||
                l.includes('WORKLOAD_') ||
                l.includes('CONCURRENCY=') ||
                l.includes('DURATION=') ||
                l.includes('BENCHMARK_STREAMING')
            )
        );

        assert.equal(
            benchmarkExports.length, 0,
            `do/config must have zero benchmark-related export statements.\nFound:\n${benchmarkExports.join('\n')}`
        );
    });

    it('server env section has the correct header comment', function () {
        assert.ok(
            configContent.includes('# Server environment variables'),
            'do/config should contain "# Server environment variables" section header'
        );
    });

    it('INSTANCE_TYPE export contains ml.p6-b200.48xlarge', function () {
        assert.ok(
            configContent.includes('ml.p6-b200.48xlarge'),
            `do/config should contain instance type ml.p6-b200.48xlarge.\n` +
            `Actual INSTANCE_TYPE lines:\n${configContent.split('\n').filter(l => l.includes('INSTANCE_TYPE')).join('\n')}`
        );
    });
});

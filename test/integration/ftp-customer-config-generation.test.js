// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Test: FTP Customer Config Generation (Task 4.2)
 *
 * Generates a project matching the customer benchmark config:
 *   --model-name s3://bucket/models/gemma-4-31b-vllm/
 *   --deployment-config transformers-vllm
 *   --instance-type ml.p6-b200.48xlarge
 *   --capacity-reservation-arn arn:aws:sagemaker:us-east-2:ACCT:training-plan/tp-XXX
 *   --server-env SM_VLLM_TENSOR_PARALLEL_SIZE=8
 *   --server-env SM_VLLM_MAX_MODEL_LEN=32768
 *   --server-env SM_VLLM_GPU_MEMORY_UTILIZATION=0.95
 *
 * Verifies the generated project directory structure is correct and key files exist.
 *
 * Requirements: FTP-4 (4.1, 4.2, 4.3)
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import { runGenerator } from '../helpers/run-generator.js';

describe('FTP Customer Config Generation (Task 4.2, FTP-4: 4.1, 4.2, 4.3)', function () {
    this.timeout(60000);

    let result;

    afterEach(() => {
        if (result) {
            result.cleanup();
            result = null;
        }
    });

    it('generates a project with the full customer FTP benchmark config', () => {
        result = runGenerator({
            'project-name': 'gemma-4-31b-ftp-benchmark',
            'deployment-config': 'transformers-vllm',
            'model-name': 's3://bucket/models/gemma-4-31b-vllm/',
            'instance-type': 'ml.p6-b200.48xlarge',
            'capacity-reservation-arn': 'arn:aws:sagemaker:us-east-2:ACCT:training-plan/tp-XXX',
            'server-env': [
                'SM_VLLM_TENSOR_PARALLEL_SIZE=8',
                'SM_VLLM_MAX_MODEL_LEN=32768',
                'SM_VLLM_GPU_MEMORY_UTILIZATION=0.95'
            ],
            'region': 'us-east-2',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        // --- Verify directory structure and key files ---
        result.assertFile('do/config');
        result.assertFile('do/deploy');
        result.assertFile('code/serve');
        result.assertFile('Dockerfile');
    });

    it('generates all expected do/ lifecycle scripts', () => {
        result = runGenerator({
            'project-name': 'gemma-4-31b-ftp-lifecycle',
            'deployment-config': 'transformers-vllm',
            'model-name': 's3://bucket/models/gemma-4-31b-vllm/',
            'instance-type': 'ml.p6-b200.48xlarge',
            'capacity-reservation-arn': 'arn:aws:sagemaker:us-east-2:ACCT:training-plan/tp-XXX',
            'server-env': [
                'SM_VLLM_TENSOR_PARALLEL_SIZE=8',
                'SM_VLLM_MAX_MODEL_LEN=32768',
                'SM_VLLM_GPU_MEMORY_UTILIZATION=0.95'
            ],
            'region': 'us-east-2',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        result.assertFile('do/config');
        result.assertFile('do/build');
        result.assertFile('do/push');
        result.assertFile('do/deploy');
        result.assertFile('do/test');
        result.assertFile('do/clean');
        result.assertFile('do/run');
    });

    it('do/config contains S3 model URI, capacity reservation ARN, instance type, and server env vars', () => {
        result = runGenerator({
            'project-name': 'gemma-4-31b-ftp-config',
            'deployment-config': 'transformers-vllm',
            'model-name': 's3://bucket/models/gemma-4-31b-vllm/',
            'instance-type': 'ml.p6-b200.48xlarge',
            'capacity-reservation-arn': 'arn:aws:sagemaker:us-east-2:ACCT:training-plan/tp-XXX',
            'server-env': [
                'SM_VLLM_TENSOR_PARALLEL_SIZE=8',
                'SM_VLLM_MAX_MODEL_LEN=32768',
                'SM_VLLM_GPU_MEMORY_UTILIZATION=0.95'
            ],
            'region': 'us-east-2',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

        // S3 model URI should be preserved in MODEL_NAME
        assert.ok(
            configContent.includes('s3://bucket/models/gemma-4-31b-vllm/'),
            `do/config should contain the S3 model URI.\nActual MODEL_NAME lines: ${configContent.split('\n').filter(l => l.includes('MODEL_NAME')).join('\n')}`
        );

        // Capacity reservation ARN should be present
        assert.ok(
            configContent.includes('arn:aws:sagemaker:us-east-2:ACCT:training-plan/tp-XXX'),
            `do/config should contain the capacity reservation ARN.\nActual lines: ${configContent.split('\n').filter(l => l.includes('CAPACITY_RESERVATION')).join('\n')}`
        );

        // Instance type should be present
        assert.ok(
            configContent.includes('ml.p6-b200.48xlarge'),
            'do/config should contain the instance type ml.p6-b200.48xlarge'
        );

        // Server env vars should be present (with engine VLLM_ prefix)
        const serverEnvKeys = [
            'VLLM_SM_VLLM_TENSOR_PARALLEL_SIZE',
            'VLLM_SM_VLLM_MAX_MODEL_LEN',
            'VLLM_SM_VLLM_GPU_MEMORY_UTILIZATION'
        ];
        for (const key of serverEnvKeys) {
            assert.ok(
                configContent.includes(`export ${key}=`),
                `do/config should contain 'export ${key}='\nActual server-env lines: ${configContent.split('\n').filter(l => l.includes('VLLM_SM_')).join('\n')}`
            );
        }
    });

    it('do/config has no benchmark export statements (FTP-4, 4.1)', () => {
        result = runGenerator({
            'project-name': 'gemma-4-31b-ftp-nobench',
            'deployment-config': 'transformers-vllm',
            'model-name': 's3://bucket/models/gemma-4-31b-vllm/',
            'instance-type': 'ml.p6-b200.48xlarge',
            'capacity-reservation-arn': 'arn:aws:sagemaker:us-east-2:ACCT:training-plan/tp-XXX',
            'server-env': [
                'SM_VLLM_TENSOR_PARALLEL_SIZE=8',
                'SM_VLLM_MAX_MODEL_LEN=32768',
                'SM_VLLM_GPU_MEMORY_UTILIZATION=0.95'
            ],
            'region': 'us-east-2',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        const configContent = fs.readFileSync(result.file('do/config'), 'utf8');

        const benchmarkExports = configContent.split('\n').filter(l =>
            l.startsWith('export') && (
                l.includes('BENCHMARK_') ||
                l.includes('WORKLOAD_') ||
                l.includes('CONCURRENCY=') ||
                l.includes('DURATION=')
            )
        );
        assert.equal(
            benchmarkExports.length, 0,
            `do/config should have zero benchmark exports. Found: ${benchmarkExports.join('\n')}`
        );
    });

    it('code/serve contains model source resolution logic', () => {
        result = runGenerator({
            'project-name': 'gemma-4-31b-ftp-serve',
            'deployment-config': 'transformers-vllm',
            'model-name': 's3://bucket/models/gemma-4-31b-vllm/',
            'instance-type': 'ml.p6-b200.48xlarge',
            'capacity-reservation-arn': 'arn:aws:sagemaker:us-east-2:ACCT:training-plan/tp-XXX',
            'server-env': [
                'SM_VLLM_TENSOR_PARALLEL_SIZE=8',
                'SM_VLLM_MAX_MODEL_LEN=32768',
                'SM_VLLM_GPU_MEMORY_UTILIZATION=0.95'
            ],
            'region': 'us-east-2',
            'build-target': 'codebuild',
            'include-benchmark': false
        });

        const serveContent = fs.readFileSync(result.file('code/serve'), 'utf8');
        assert.ok(
            serveContent.includes('MODEL_SOURCE') || serveContent.includes('resolve_model'),
            'code/serve should have model source resolution logic'
        );
    });
});


// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for external endpoint wiring in do/config template.
 *
 * When existingEndpointName is set:
 *   - do/config emits ENDPOINT_NAME="${existingEndpointName}" and ENDPOINT_EXTERNAL=true
 *   - INSTANCE_TYPE is NOT emitted (inherited from existing endpoint)
 *   - INFERENCE_AMI_VERSION is NOT emitted (already set on endpoint)
 *
 * When existingEndpointName is not set:
 *   - Normal flow (INSTANCE_TYPE, INFERENCE_AMI_VERSION emitted as before)
 *
 * Validates: Requirements 3.3, 4.4
 */

import { describe, it, before } from 'mocha';
import assert from 'assert';
import ejs from 'ejs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatePath = path.join(__dirname, '../../templates/do/config');
const templateContent = readFileSync(templatePath, 'utf8');

/**
 * Render the do/config template with the given variables.
 */
function renderConfig(vars) {
    return ejs.render(templateContent, { orderedEnvVars: [], baseImage: '', ...vars });
}

/** Base config shared across tests */
const baseConfig = {
    projectName: 'test-project',
    deploymentConfig: 'transformers-vllm',
    framework: 'transformers',
    modelServer: 'vllm',
    awsRegion: 'us-east-1',
    buildTarget: 'codebuild',
    codebuildComputeType: 'BUILD_GENERAL1_MEDIUM',
    deploymentTarget: 'realtime-inference',
    modelName: 'meta-llama/Llama-3.2-3B-Instruct',
    hfToken: 'hf_testtoken123',
    modelFormat: undefined,
    roleArn: undefined,
    ngcApiKey: undefined
};

describe('do/config External Endpoint Wiring', () => {
    before(() => {
        console.log('\n🚀 Starting do/config External Endpoint Wiring Tests');
        console.log('📋 Testing: Requirements 3.3, 4.4');
        console.log('🔧 Configuration: EJS template rendering\n');
    });

    it('should emit ENDPOINT_NAME and ENDPOINT_EXTERNAL=true when existingEndpointName is set', () => {
        const vars = {
            ...baseConfig,
            existingEndpointName: 'my-shared-endpoint-12345',
            instanceType: undefined,
            inferenceAmiVersion: undefined
        };

        const output = renderConfig(vars);

        assert.ok(
            output.includes('export ENDPOINT_NAME="my-shared-endpoint-12345"'),
            'Output must contain ENDPOINT_NAME with the selected endpoint name'
        );
        assert.ok(
            output.includes('export ENDPOINT_EXTERNAL=true'),
            'Output must contain ENDPOINT_EXTERNAL=true'
        );
    });

    it('should NOT emit INSTANCE_TYPE when existingEndpointName is set', () => {
        const vars = {
            ...baseConfig,
            existingEndpointName: 'my-shared-endpoint-12345',
            instanceType: 'ml.g5.2xlarge',
            inferenceAmiVersion: '1.0.0'
        };

        const output = renderConfig(vars);

        // INSTANCE_TYPE should not appear in the realtime-inference section
        assert.ok(
            !output.includes('export INSTANCE_TYPE="ml.g5.2xlarge"'),
            'Output must NOT contain INSTANCE_TYPE when using external endpoint'
        );
    });

    it('should NOT emit INFERENCE_AMI_VERSION when existingEndpointName is set', () => {
        const vars = {
            ...baseConfig,
            existingEndpointName: 'my-shared-endpoint-12345',
            instanceType: 'ml.g5.2xlarge',
            inferenceAmiVersion: '1.0.0'
        };

        const output = renderConfig(vars);

        assert.ok(
            !output.includes('export INFERENCE_AMI_VERSION="1.0.0"'),
            'Output must NOT contain INFERENCE_AMI_VERSION when using external endpoint'
        );
    });

    it('should NOT emit INSTANCE_TYPE override at bottom when existingEndpointName is set', () => {
        const vars = {
            ...baseConfig,
            existingEndpointName: 'my-shared-endpoint-12345',
            instanceType: 'ml.g5.2xlarge',
            inferenceAmiVersion: undefined
        };

        const output = renderConfig(vars);

        // The "Allow environment variable overrides" section should not have INSTANCE_TYPE
        assert.ok(
            !output.includes('INSTANCE_TYPE=${INSTANCE_TYPE:-'),
            'Output must NOT contain INSTANCE_TYPE override when using external endpoint'
        );
    });

    it('should show endpoint name in summary when existingEndpointName is set', () => {
        const vars = {
            ...baseConfig,
            existingEndpointName: 'my-shared-endpoint-12345',
            instanceType: undefined,
            inferenceAmiVersion: undefined
        };

        const output = renderConfig(vars);

        assert.ok(
            output.includes('(external)'),
            'Summary must show (external) marker for external endpoints'
        );
        assert.ok(
            output.includes('${ENDPOINT_NAME}'),
            'Summary must reference ENDPOINT_NAME variable'
        );
    });

    it('should emit INSTANCE_TYPE normally when existingEndpointName is NOT set', () => {
        const vars = {
            ...baseConfig,
            existingEndpointName: null,
            instanceType: 'ml.g5.2xlarge',
            inferenceAmiVersion: '1.0.0'
        };

        const output = renderConfig(vars);

        assert.ok(
            output.includes('export INSTANCE_TYPE="ml.g5.2xlarge"'),
            'Output must contain INSTANCE_TYPE when not using external endpoint'
        );
        assert.ok(
            output.includes('export INFERENCE_AMI_VERSION="1.0.0"'),
            'Output must contain INFERENCE_AMI_VERSION when not using external endpoint'
        );
        assert.ok(
            !output.includes('ENDPOINT_EXTERNAL'),
            'Output must NOT contain ENDPOINT_EXTERNAL when not using external endpoint'
        );
        assert.ok(
            !output.includes('export ENDPOINT_NAME='),
            'Output must NOT contain ENDPOINT_NAME when not using external endpoint'
        );
    });

    it('should emit INSTANCE_TYPE normally when existingEndpointName is undefined', () => {
        const vars = {
            ...baseConfig,
            // existingEndpointName not set at all (undefined)
            instanceType: 'ml.m5.xlarge',
            inferenceAmiVersion: undefined
        };

        const output = renderConfig(vars);

        assert.ok(
            output.includes('export INSTANCE_TYPE="ml.m5.xlarge"'),
            'Output must contain INSTANCE_TYPE when existingEndpointName is undefined'
        );
        assert.ok(
            !output.includes('ENDPOINT_EXTERNAL'),
            'Output must NOT contain ENDPOINT_EXTERNAL when existingEndpointName is undefined'
        );
    });

    it('should NOT emit CAPACITY_RESERVATION_ARN when existingEndpointName is set', () => {
        const vars = {
            ...baseConfig,
            existingEndpointName: 'my-shared-endpoint-12345',
            instanceType: 'ml.g5.2xlarge',
            inferenceAmiVersion: undefined,
            capacityReservationArn: 'arn:aws:sagemaker:us-east-1:123456789012:capacity-reservation/cr-12345'
        };

        const output = renderConfig(vars);

        assert.ok(
            !output.includes('CAPACITY_RESERVATION_ARN'),
            'Output must NOT contain CAPACITY_RESERVATION_ARN when using external endpoint'
        );
    });
});

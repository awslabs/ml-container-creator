// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Endpoint-to-Answers Converter
 *
 * Converts SageMaker endpoint describe responses to a writeProject()-compatible
 * answers object. Used by `mcc import` to reconstruct project config from a
 * running endpoint.
 *
 * Requirements: US-1 AC-1.1 through AC-1.4
 */

import { SageMakerClient, DescribeEndpointCommand, DescribeEndpointConfigCommand,
    ListInferenceComponentsCommand, DescribeInferenceComponentCommand } from '@aws-sdk/client-sagemaker';

/**
 * Infer deployment configuration from a container image URI.
 * @param {string} imageUri - Container image URI from the inference component
 * @returns {string} Deployment config identifier
 */
export function inferDeploymentConfig(imageUri) {
    if (/vllm\/vllm-openai/.test(imageUri)) return 'transformers-vllm';
    if (/sglang/.test(imageUri)) return 'transformers-sglang';
    if (/lmi|djl/.test(imageUri)) return 'transformers-lmi';
    if (/triton/.test(imageUri)) return 'triton';
    if (/flask|gunicorn/.test(imageUri)) return 'http-flask';
    return 'transformers-vllm'; // safe default
}

/**
 * Extract model ID from environment variables map.
 * Checks IC_ENV_HF_MODEL_ID → HF_MODEL_ID → MODEL_NAME in priority order.
 * @param {object} envVars - Environment variables map
 * @returns {string} Model ID or 'unknown'
 */
export function extractModelId(envVars) {
    if (envVars.IC_ENV_HF_MODEL_ID) return envVars.IC_ENV_HF_MODEL_ID;
    if (envVars.HF_MODEL_ID) return envVars.HF_MODEL_ID;
    if (envVars.MODEL_NAME) return envVars.MODEL_NAME;
    return 'unknown';
}

/**
 * Convert a SageMaker endpoint to a writeProject()-compatible answers object.
 * Calls DescribeEndpoint, DescribeEndpointConfig, ListInferenceComponents,
 * and DescribeInferenceComponent for each IC.
 *
 * @param {string} endpointArn - Full ARN of the SageMaker endpoint
 * @param {string} region - AWS region
 * @returns {Promise<{ answers: object, icConfs: Array<object> }>}
 */
export async function endpointToAnswers(endpointArn, region) {
    // Parse endpoint name from ARN: arn:aws:sagemaker:<region>:<account>:endpoint/<name>
    const arnParts = endpointArn.match(/^arn:aws:sagemaker:([^:]+):([^:]+):endpoint\/(.+)$/);
    if (!arnParts) {
        throw new Error(`❌ Invalid endpoint ARN format: ${endpointArn}\n   Expected: arn:aws:sagemaker:<region>:<account>:endpoint/<name>`);
    }

    const endpointName = arnParts[3];
    const effectiveRegion = region || arnParts[1];

    const client = new SageMakerClient({ region: effectiveRegion });

    // 1. DescribeEndpoint
    let endpointResponse;
    try {
        endpointResponse = await client.send(new DescribeEndpointCommand({
            EndpointName: endpointName
        }));
    } catch (err) {
        if (err.name === 'ValidationException' || err.name === 'ResourceNotFound') {
            throw new Error(`❌ Endpoint not found or not accessible: ${endpointName}\n   ${err.message}`);
        }
        throw err;
    }

    const endpointStatus = endpointResponse.EndpointStatus;
    const endpointConfigName = endpointResponse.EndpointConfigName;

    // 2. DescribeEndpointConfig
    const configResponse = await client.send(new DescribeEndpointConfigCommand({
        EndpointConfigName: endpointConfigName
    }));

    const primaryVariant = configResponse.ProductionVariants[0];
    const instanceType = primaryVariant.InstanceType;
    const variantName = primaryVariant.VariantName;

    // 3. ListInferenceComponents
    const icListResponse = await client.send(new ListInferenceComponentsCommand({
        EndpointNameEquals: endpointName
    }));

    const icSummaries = icListResponse.InferenceComponents || [];

    // 4. DescribeInferenceComponent for each IC
    const icConfs = [];
    let firstImage = '';
    let firstEnvVars = {};

    for (const icSummary of icSummaries) {
        const icName = icSummary.InferenceComponentName;
        const icResponse = await client.send(new DescribeInferenceComponentCommand({
            InferenceComponentName: icName
        }));

        const container = icResponse.Specification?.Container || {};
        const runtime = icResponse.RuntimeConfig || {};
        const imageUri = container.Image || '';
        const environment = container.Environment || {};

        if (!firstImage && imageUri) {
            firstImage = imageUri;
            firstEnvVars = environment;
        }

        const gpuCount = runtime.NumberOfAcceleratorDevicesRequired || 0;
        const cpuCount = runtime.NumberOfCpuCoresRequired || 0;
        const memorySize = runtime.MinMemoryRequiredInMb || 0;

        // Build IC conf object
        const icConf = {
            name: icName,
            IC_GPU_COUNT: gpuCount,
            IC_CPU_COUNT: cpuCount,
            IC_MEMORY_SIZE: memorySize
        };

        // Add all environment variables as IC_ENV_* prefixed
        for (const [key, value] of Object.entries(environment)) {
            icConf[`IC_ENV_${key}`] = value;
        }

        icConfs.push(icConf);
    }

    // 5. Build answers object
    const deploymentConfig = inferDeploymentConfig(firstImage);
    const modelName = extractModelId(firstEnvVars);

    // Slugify endpoint name for project name (lowercase, replace non-alphanumeric with dashes, max 50)
    const projectName = endpointName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50);

    const answers = {
        projectName,
        deploymentConfig,
        deploymentTarget: 'realtime-inference',
        instanceType,
        modelName,
        baseImage: firstImage,
        region: effectiveRegion,
        deployMode: 'imported',
        endpointName,
        endpointStatus,
        variantName,
        no_build: true,
        container_image_uri: firstImage,
        deploy_mode: 'imported',
        // Ensure operational scripts are included
        includeBenchmark: true,
        enableLora: false,
        testTypes: ['hosted-model-endpoint']
    };

    return { answers, icConfs };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-Prompt Builder — generates targeted prompts for missing required parameters.
 * 
 * Used by --auto-prompt mode to ask only for values that cannot be inferred
 * or defaulted from the provided CLI flags.
 */

/**
 * Builds a minimal set of prompts for the given missing parameters.
 * Each prompt is self-contained and doesn't depend on multi-phase wizard state.
 *
 * @param {string[]} missingParams - Parameter names that need values
 * @param {object} currentConfig - Current configuration (with defaults filled)
 * @returns {Array} Array of prompt objects compatible with runPrompts()
 */
export function buildAutoPrompts(missingParams, currentConfig) {
    const prompts = [];

    for (const param of missingParams) {
        const builder = PROMPT_BUILDERS[param];
        if (builder) {
            const prompt = builder(currentConfig);
            if (prompt) {
                prompts.push(prompt);
            }
        } else {
            // Fallback: generic text input for unknown parameters
            prompts.push({
                type: 'input',
                name: param,
                message: `Enter value for ${param}:`
            });
        }
    }

    return prompts;
}

/**
 * Map of parameter names to prompt builder functions.
 * Each builder receives the current config and returns a prompt object.
 */
const PROMPT_BUILDERS = {
    deploymentConfig: (_config) => ({
        type: 'list',
        name: 'deploymentConfig',
        message: 'Select deployment configuration:',
        choices: [
            { type: 'separator', separator: '── Large Language Models ──' },
            { name: 'Transformers with vLLM', value: 'transformers-vllm' },
            { name: 'Transformers with SGLang', value: 'transformers-sglang' },
            { name: 'Transformers with TensorRT-LLM', value: 'transformers-tensorrt-llm' },
            { name: 'Transformers with LMI', value: 'transformers-lmi' },
            { name: 'Transformers with DJL', value: 'transformers-djl' },
            { type: 'separator', separator: '── HTTP Serving ──' },
            { name: 'HTTP with Flask', value: 'http-flask' },
            { name: 'HTTP with FastAPI', value: 'http-fastapi' },
            { type: 'separator', separator: '── NVIDIA Triton ──' },
            { name: 'Triton FIL (XGBoost, LightGBM)', value: 'triton-fil' },
            { name: 'Triton ONNX Runtime', value: 'triton-onnxruntime' },
            { name: 'Triton TensorFlow', value: 'triton-tensorflow' },
            { name: 'Triton PyTorch', value: 'triton-pytorch' },
            { name: 'Triton vLLM', value: 'triton-vllm' },
            { name: 'Triton TensorRT-LLM', value: 'triton-tensorrtllm' },
            { name: 'Triton Python Backend', value: 'triton-python' },
            { type: 'separator', separator: '── Diffusion Models ──' },
            { name: 'Diffusors with vLLM Omni', value: 'diffusors-vllm-omni' }
        ]
    }),

    instanceType: (config) => {
        const architecture = config.architecture || 'http';
        const isGpu = architecture === 'transformers' || architecture === 'triton' || architecture === 'diffusors';

        const gpuChoices = [
            { name: 'ml.g5.xlarge  (1× A10G 24GB — small LLMs)', value: 'ml.g5.xlarge' },
            { name: 'ml.g5.2xlarge (1× A10G 24GB — medium LLMs)', value: 'ml.g5.2xlarge' },
            { name: 'ml.g5.4xlarge (1× A10G 24GB — larger models)', value: 'ml.g5.4xlarge' },
            { name: 'ml.g5.12xlarge (4× A10G 96GB — large LLMs)', value: 'ml.g5.12xlarge' },
            { name: 'ml.g5.48xlarge (8× A10G 192GB — very large)', value: 'ml.g5.48xlarge' },
            { name: 'ml.g6.xlarge  (1× L4 24GB)', value: 'ml.g6.xlarge' },
            { name: 'ml.g6.2xlarge (1× L4 24GB)', value: 'ml.g6.2xlarge' },
            { name: 'ml.p4d.24xlarge (8× A100 320GB)', value: 'ml.p4d.24xlarge' },
            { name: 'ml.p5.48xlarge (8× H100 640GB)', value: 'ml.p5.48xlarge' },
            { name: 'Custom (enter manually)', value: '_custom' }
        ];

        const cpuChoices = [
            { name: 'ml.m5.large   (2 vCPU, 8GB — lightweight)', value: 'ml.m5.large' },
            { name: 'ml.m5.xlarge  (4 vCPU, 16GB — small models)', value: 'ml.m5.xlarge' },
            { name: 'ml.m5.2xlarge (8 vCPU, 32GB — medium models)', value: 'ml.m5.2xlarge' },
            { name: 'ml.m5.4xlarge (16 vCPU, 64GB — large models)', value: 'ml.m5.4xlarge' },
            { name: 'ml.c5.xlarge  (4 vCPU, 8GB — compute-heavy)', value: 'ml.c5.xlarge' },
            { name: 'ml.c5.2xlarge (8 vCPU, 16GB — compute-heavy)', value: 'ml.c5.2xlarge' },
            { name: 'Custom (enter manually)', value: '_custom' }
        ];

        return {
            type: 'list',
            name: 'instanceType',
            message: `Select instance type${isGpu ? ' (GPU recommended for this architecture)' : ''}:`,
            choices: isGpu ? gpuChoices : cpuChoices
        };
    },

    deploymentTarget: (_config) => ({
        type: 'list',
        name: 'deploymentTarget',
        message: 'Select deployment target:',
        choices: [
            { name: 'Real-Time Inference', value: 'realtime-inference' },
            { name: 'Async Inference', value: 'async-inference' },
            { name: 'Batch Transform', value: 'batch-transform' },
            { name: 'HyperPod EKS', value: 'hyperpod-eks' }
        ]
    }),

    modelFormat: (config) => {
        const engine = config.engine || 'sklearn';
        const formatMap = {
            sklearn: [
                { name: 'pkl (pickle)', value: 'pkl' },
                { name: 'joblib', value: 'joblib' }
            ],
            xgboost: [
                { name: 'json', value: 'json' },
                { name: 'model (binary)', value: 'model' },
                { name: 'ubj (universal binary JSON)', value: 'ubj' }
            ],
            tensorflow: [
                { name: 'keras', value: 'keras' },
                { name: 'h5', value: 'h5' },
                { name: 'SavedModel', value: 'SavedModel' }
            ]
        };

        const choices = formatMap[engine] || formatMap.sklearn;

        return {
            type: 'list',
            name: 'modelFormat',
            message: `Select model format for ${engine}:`,
            choices
        };
    },

    awsRegion: (_config) => ({
        type: 'list',
        name: 'awsRegion',
        message: 'Select AWS region:',
        choices: [
            { name: 'us-east-1 (N. Virginia)', value: 'us-east-1' },
            { name: 'us-west-2 (Oregon)', value: 'us-west-2' },
            { name: 'eu-west-1 (Ireland)', value: 'eu-west-1' },
            { name: 'ap-northeast-1 (Tokyo)', value: 'ap-northeast-1' },
            { name: 'ap-southeast-1 (Singapore)', value: 'ap-southeast-1' },
            { name: 'Custom (enter manually)', value: '_custom' }
        ]
    }),

    buildTarget: (_config) => ({
        type: 'list',
        name: 'buildTarget',
        message: 'Select build target:',
        choices: [
            { name: 'CodeBuild (recommended)', value: 'codebuild' }
        ]
    })
};

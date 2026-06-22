// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Feature prompt definitions.
 * Covers: module prompts (sample model, test types), LoRA, benchmark.
 */

const modulePrompts = [
    {
        type: 'confirm',
        name: 'includeSampleModel',
        message: 'Include sample Abalone classifier?',
        default: true,
        when: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            // Never for transformers
            if (architecture === 'transformers') {
                return false;
            }
            
            // Never for diffusors (diffusion models cannot be trained inline)
            if (architecture === 'diffusors') {
                return false;
            }
            
            // For Triton, check if backend supports sample model
            if (architecture === 'triton') {
                // Triton LLM backends don't support sample model
                if (backend === 'vllm' || backend === 'tensorrtllm' || backend === 'pytorch') {
                    return false;
                }
                // Other Triton backends support sample model
                return true;
            }
            
            // For http architecture, always show
            return true;
        }
    },
    {
        type: 'checkbox',
        name: 'testTypes',
        message: 'Test type?',
        choices: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            // Transformers and Triton LLM backends only support hosted endpoint tests
            if (architecture === 'transformers') {
                return ['hosted-model-endpoint', 'sagemaker-ai-automated-benchmarking'];
            }
            if (architecture === 'diffusors') {
                return ['hosted-model-endpoint', 'sagemaker-ai-automated-benchmarking'];
            }
            if (architecture === 'triton' && (backend === 'vllm' || backend === 'tensorrtllm')) {
                return ['hosted-model-endpoint'];
            }
            
            return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
        },
        default: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            if (architecture === 'transformers') {
                return ['hosted-model-endpoint', 'sagemaker-ai-automated-benchmarking'];
            }
            if (architecture === 'diffusors') {
                return ['hosted-model-endpoint', 'sagemaker-ai-automated-benchmarking'];
            }
            if (architecture === 'triton' && (backend === 'vllm' || backend === 'tensorrtllm')) {
                return ['hosted-model-endpoint'];
            }
            
            return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
        }
    }
];

/**
 * LoRA adapter prompts for multi-adapter serving configuration.
 * Only shown when architecture is transformers AND model server is vllm, sglang, or djl-lmi.
 * Requirements: 1.1, 1.2, 1.4
 */
const loraPrompts = [
    {
        type: 'confirm',
        name: 'enableLora',
        message: 'Enable LoRA adapter serving?',
        default: true,
        when: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            if (architecture !== 'transformers') return false;
            const loraCapableServers = ['vllm', 'sglang', 'djl-lmi', 'lmi', 'djl'];
            return loraCapableServers.includes(backend);
        }
    },
    {
        type: 'number',
        name: 'maxLoras',
        message: 'Maximum concurrent LoRA adapters in GPU memory:',
        default: 30,
        when: (answers) => answers.enableLora === true
    },
    {
        type: 'number',
        name: 'maxLoraRank',
        message: 'Maximum LoRA rank:',
        default: 64,
        when: (answers) => answers.enableLora === true
    }
];

/**
 * Benchmark prompts for SageMaker AI Benchmarking (NVIDIA AIPerf)
 * Sub-prompts shown when 'sagemaker-ai-automated-benchmarking' is selected in testTypes.
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */
const benchmarkPrompts = [
    {
        type: 'number',
        name: 'benchmarkConcurrency',
        message: 'Concurrent requests for benchmark:',
        default: 10,
        when: (answers) => answers.includeBenchmark === true
    },
    {
        type: 'number',
        name: 'benchmarkInputTokensMean',
        message: 'Mean input tokens per request:',
        default: 550,
        when: (answers) => answers.includeBenchmark === true
    },
    {
        type: 'number',
        name: 'benchmarkOutputTokensMean',
        message: 'Mean output tokens per request:',
        default: 150,
        when: (answers) => answers.includeBenchmark === true
    },
    {
        type: 'confirm',
        name: 'benchmarkStreaming',
        message: 'Enable streaming for benchmark?',
        default: true,
        when: (answers) => answers.includeBenchmark === true
    },
    {
        type: 'input',
        name: 'benchmarkRequestCount',
        message: 'Total request count (leave empty for service default):',
        default: '',
        when: (answers) => answers.includeBenchmark === true
    },
    {
        type: 'input',
        name: 'benchmarkS3OutputPath',
        message: 'Benchmark results S3 path (leave empty for auto-created bucket):',
        default: '',
        when: (answers) => answers.includeBenchmark === true
    }
];

export {
    modulePrompts,
    loraPrompts,
    benchmarkPrompts
};

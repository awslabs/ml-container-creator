// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model & Framework prompt definitions.
 * Covers: deployment config, framework, engine, version, profile, format,
 * model server, model load strategy, model profile, HF token, NGC API key.
 */

/**
 * Phase 1: Core ML configuration (moved to first)
 * Flattened deployment configuration combining architecture + backend
 * Requirements: 3.1, 3.2, 16.1, 16.2, 16.3, 16.4, 16.8, 16.9
 */
const deploymentConfigPrompts = [
    {
        type: 'list',
        name: 'deploymentConfig',
        message: 'Select deployment configuration:',
        choices: [
            { type: 'separator', separator: '── Large Language Models ──' },
            {
                name: 'Transformers with vLLM',
                value: 'transformers-vllm',
                short: 'transformers-vllm'
            },
            {
                name: 'Transformers with SGLang',
                value: 'transformers-sglang',
                short: 'transformers-sglang'
            },
            {
                name: 'Transformers with TensorRT-LLM',
                value: 'transformers-tensorrt-llm',
                short: 'transformers-tensorrt-llm'
            },
            {
                name: 'Transformers with LMI (Large Model Inference)',
                value: 'transformers-lmi',
                short: 'transformers-lmi'
            },
            {
                name: 'Transformers with DJL (Deep Java Library)',
                value: 'transformers-djl',
                short: 'transformers-djl'
            },
            { type: 'separator', separator: '── HTTP Serving ──' },
            {
                name: 'HTTP with Flask',
                value: 'http-flask',
                short: 'http-flask'
            },
            {
                name: 'HTTP with FastAPI',
                value: 'http-fastapi',
                short: 'http-fastapi'
            },
            { type: 'separator', separator: '── NVIDIA Triton Inference Server ──' },
            {
                name: 'Triton FIL (XGBoost, LightGBM)',
                value: 'triton-fil',
                short: 'triton-fil'
            },
            {
                name: 'Triton ONNX Runtime',
                value: 'triton-onnxruntime',
                short: 'triton-onnxruntime'
            },
            {
                name: 'Triton TensorFlow',
                value: 'triton-tensorflow',
                short: 'triton-tensorflow'
            },
            {
                name: 'Triton PyTorch',
                value: 'triton-pytorch',
                short: 'triton-pytorch'
            },
            {
                name: 'Triton vLLM',
                value: 'triton-vllm',
                short: 'triton-vllm'
            },
            {
                name: 'Triton TensorRT-LLM',
                value: 'triton-tensorrtllm',
                short: 'triton-tensorrtllm'
            },
            {
                name: 'Triton Python Backend',
                value: 'triton-python',
                short: 'triton-python'
            },
            { type: 'separator', separator: '── Diffusion Models ──' },
            {
                name: 'Diffusors with vLLM Omni',
                value: 'diffusors-vllm-omni',
                short: 'diffusors-vllm-omni'
            },
            { type: 'separator', separator: '── AWS Marketplace ──' },
            {
                name: 'Marketplace Model Package',
                value: 'marketplace',
                short: 'marketplace'
            }
        ]
    }
];

// Keep legacy frameworkPrompts for backward compatibility (deprecated)
const frameworkPrompts = deploymentConfigPrompts;

/**
 * Engine selection prompt for http architecture
 * Requirements: 3.7
 */
const enginePrompts = [
    {
        type: 'list',
        name: 'engine',
        message: 'Select ML engine:',
        choices: [
            { name: 'scikit-learn', value: 'sklearn' },
            { name: 'XGBoost', value: 'xgboost' },
            { name: 'TensorFlow', value: 'tensorflow' }
        ],
        when: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            return architecture === 'http';
        }
    }
];

/**
 * Framework version selection prompts (for registry system)
 * Requirements: 2.1, 2.6, 8.2, 8.3
 */
const frameworkVersionPrompts = [
    {
        type: 'list',
        name: 'frameworkVersion',
        message: (answers) => `Which version of ${answers.framework} are you using?`,
        choices: (answers) => {
            // Choices will be populated by PromptRunner with registry data
            return answers._frameworkVersionChoices || [];
        },
        when: (answers) => {
            // Only show if we have version choices available
            return answers._frameworkVersionChoices && answers._frameworkVersionChoices.length > 0;
        }
    }
];

/**
 * Framework profile selection prompts (for registry system)
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.10
 */
const frameworkProfilePrompts = [
    {
        type: 'list',
        name: 'frameworkProfile',
        message: 'Select a framework configuration profile:',
        choices: (answers) => {
            // Choices will be populated by PromptRunner with registry data
            return answers._frameworkProfileChoices || [];
        },
        when: (answers) => {
            // Only show if we have profile choices available
            return answers._frameworkProfileChoices && answers._frameworkProfileChoices.length > 0;
        }
    }
];

const modelFormatPrompts = [
    {
        type: 'list',
        name: 'modelFormat',
        message: 'In which format is your model serialized?',
        choices: (answers) => {
            // Derive architecture from deploymentConfig
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            // For http architecture, use engine to determine formats
            if (architecture === 'http') {
                const engine = answers.engine;
                const formatMap = {
                    'xgboost': ['json', 'model', 'ubj'],
                    'sklearn': ['pkl', 'joblib'],
                    'tensorflow': ['keras', 'h5', 'SavedModel']
                };
                return formatMap[engine] || [];
            }
            
            // For triton architecture, use backend-specific formats
            if (architecture === 'triton') {
                // FIL backend has multiple format choices
                if (backend === 'fil') {
                    return ['xgboost_json', 'xgboost_ubj', 'lightgbm_txt'];
                }
                // Python backend has multiple format choices
                if (backend === 'python') {
                    return ['pkl', 'joblib', 'custom'];
                }
                // Other Triton backends have auto-set formats (handled in when clause)
                return [];
            }
            
            // Legacy support for old format (should not be reached with new configs)
            const framework = answers.framework || architecture;
            const formatMap = {
                'xgboost': ['json', 'model', 'ubj'],
                'sklearn': ['pkl', 'joblib'],
                'tensorflow': ['keras', 'h5', 'SavedModel']
            };
            return formatMap[framework] || [];
        },
        when: answers => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            // Skip for transformers (they use HF Hub)
            if (architecture === 'transformers') {
                return false;
            }
            
            // Skip for diffusors (they use HF Hub)
            if (architecture === 'diffusors') {
                return false;
            }
            
            // For http architecture, always show
            if (architecture === 'http') {
                return true;
            }
            
            // For triton architecture, only show for backends with multiple format choices
            if (architecture === 'triton') {
                // FIL and Python backends have multiple format choices
                if (backend === 'fil' || backend === 'python') {
                    return true;
                }
                // Other backends have auto-set formats
                return false;
            }
            
            // Legacy support
            const framework = answers.framework || architecture;
            return framework !== 'transformers';
        }
    },
    {
        type: 'list',
        name: 'modelName',
        message: 'Which model do you want to use?',
        choices: (answers) => {
            // Use MCP model-picker choices when available
            if (answers._mcpModelChoices && answers._mcpModelChoices.length > 0) {
                return [...answers._mcpModelChoices, 'Custom (enter manually)'];
            }
            // Fallback to hardcoded defaults based on architecture
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            if (architecture === 'diffusors') {
                return [
                    'stabilityai/stable-diffusion-3.5-medium',
                    'black-forest-labs/FLUX.1-schnell',
                    'black-forest-labs/FLUX.1-dev',
                    'Custom (enter manually)'
                ];
            }
            return [
                { type: 'separator', separator: '── Meta Llama ──' },
                'meta-llama/Llama-3.2-1B-Instruct',
                'meta-llama/Llama-3.2-3B-Instruct',
                'meta-llama/Llama-3.1-8B-Instruct',
                'meta-llama/Llama-3.3-70B-Instruct',
                { type: 'separator', separator: '── Qwen (Alibaba) ──' },
                'Qwen/Qwen3-0.6B',
                'Qwen/Qwen3-1.7B',
                'Qwen/Qwen3-4B',
                'Qwen/Qwen3-8B',
                'Qwen/Qwen3-14B',
                'Qwen/Qwen3-32B',
                'Qwen/Qwen2.5-7B-Instruct',
                'Qwen/Qwen2.5-14B-Instruct',
                'Qwen/Qwen2.5-32B-Instruct',
                'Qwen/Qwen2.5-72B-Instruct',
                { type: 'separator', separator: '── DeepSeek ──' },
                'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B',
                'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
                'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',
                'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
                'deepseek-ai/DeepSeek-R1-Distill-Llama-8B',
                'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
                { type: 'separator', separator: '── OpenAI ──' },
                'openai/gpt-oss-20b',
                'openai/gpt-oss-120b',
                { type: 'separator', separator: '──────────────' },
                'Custom (enter manually)'
            ];
        },
        default: (answers) => {
            if (answers._mcpModelChoices && answers._mcpModelChoices.length > 0) {
                return answers._mcpModelChoices[0];
            }
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            if (architecture === 'diffusors') {
                return 'stabilityai/stable-diffusion-3.5-medium';
            }
            return 'meta-llama/Llama-3.1-8B-Instruct';
        },
        when: answers => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            // Show for transformers architecture
            if (architecture === 'transformers') {
                return true;
            }
            
            // Show for diffusors architecture (reuse HuggingFace model selection)
            if (architecture === 'diffusors') {
                return true;
            }
            
            // Show for Triton LLM backends (vllm, tensorrtllm)
            if (architecture === 'triton' && (backend === 'vllm' || backend === 'tensorrtllm')) {
                return true;
            }
            
            return false;
        }
    },
    {
        type: 'input',
        name: 'customModelName',
        message: 'Enter the model path:',
        validate: (input) => {
            if (!input || input.trim() === '') {
                return 'Model name is required';
            }
            // Basic validation - must contain a slash (org/model, s3://path, etc.)
            if (!input.includes('/')) {
                return 'Please use the full model path (e.g., microsoft/DialoGPT-medium, s3://bucket/model, registry://my-package)';
            }
            return true;
        },
        when: answers => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            // Show for transformers with custom model selection
            if (architecture === 'transformers' && answers.modelName === 'Custom (enter manually)') {
                return true;
            }
            
            // Show for diffusors with custom model selection
            if (architecture === 'diffusors' && answers.modelName === 'Custom (enter manually)') {
                return true;
            }
            
            // Show for Triton LLM backends with custom model selection
            if (architecture === 'triton' && (backend === 'vllm' || backend === 'tensorrtllm') && answers.modelName === 'Custom (enter manually)') {
                return true;
            }
            
            return false;
        }
    }
];

// Model server prompts are now deprecated - modelServer is derived from deploymentConfig
const modelServerPrompts = [];

/**
 * Model loading strategy prompt
 * Asks user whether to bake model into image at build time or download at container startup.
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */
const modelLoadStrategyPrompts = [
    {
        type: 'list',
        name: 'modelLoadStrategy',
        message: 'How should the model be loaded?\n'
            + '  Build-time: Bakes model into image (larger image, faster startup)\n'
            + '  Runtime: Downloads at container startup (smaller image, slower startup)',
        choices: [
            { name: 'Runtime (download at startup)', value: 'runtime' },
            { name: 'Build-time (bake into image) [EXPERIMENTAL]', value: 'build-time' }
        ],
        default: 'runtime',
        when: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            return architecture === 'transformers' || architecture === 'diffusors';
        }
    }
];

/**
 * Model profile selection prompts (for registry system)
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.10
 */
const modelProfilePrompts = [
    {
        type: 'list',
        name: 'modelProfile',
        message: 'Select a model configuration profile:',
        choices: (answers) => {
            // Choices will be populated by PromptRunner with registry data
            return answers._modelProfileChoices || [];
        },
        when: (answers) => {
            // Only show if we have profile choices available
            return answers._modelProfileChoices && answers._modelProfileChoices.length > 0;
        }
    }
];

/**
 * List of example model IDs that don't require HF_TOKEN prompts
 * These are public models that don't need authentication
 */
// eslint-disable-next-line no-unused-vars -- reference list for future use
const EXAMPLE_MODEL_IDS = [
    'meta-llama/Llama-3.1-8B-Instruct',
    'meta-llama/Llama-3.2-3B-Instruct',
    'Qwen/Qwen3-8B',
    'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    'openai/gpt-oss-20b'
];

const hfTokenPrompts = [
    {
        type: 'input',
        name: 'hfToken',
        message: 'HuggingFace token (enter token, "$HF_TOKEN" for env var, or leave empty):',
        when: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            // Prompt for transformers architecture
            const isTransformers = architecture === 'transformers';
            
            // Prompt for diffusors architecture (uses HuggingFace Hub)
            const isDiffusors = architecture === 'diffusors';
            
            // Prompt for Triton LLM backends (vllm, tensorrtllm)
            // Requirements: 9.1, 9.2
            const isTritonLlm = architecture === 'triton' && (backend === 'vllm' || backend === 'tensorrtllm');
            
            if (!isTransformers && !isDiffusors && !isTritonLlm) {
                return false;
            }
            
            // Skip HF token prompt for non-HuggingFace model sources
            // (S3, Registry models don't need HF auth)
            const modelSource = answers.modelSource;
            if (modelSource && modelSource !== 'huggingface') {
                return false;
            }
            
            // Display security warning before prompting
            console.log('\n🔐 HuggingFace Authentication');
            console.log('   Many models (e.g. Llama, Mistral) are gated and require a token.');
            console.log('⚠️  Security Note: The token will be baked into the Docker image.');
            console.log('   Anyone with access to the image can extract the token using \'docker inspect\'.');
            console.log('   For CI/CD pipelines, use "$HF_TOKEN" to reference an environment variable.');
            console.log('   This keeps the token out of the image and allows rotation without rebuilding.\n');
            
            return true;
        },
        validate: (input) => {
            // Empty is valid (not all models require auth)
            if (!input || input.trim() === '') {
                return true;
            }
            
            // $HF_TOKEN reference is valid
            if (input.trim() === '$HF_TOKEN') {
                return true;
            }
            
            // Direct token should start with hf_ (warning only, not blocking)
            if (!input.startsWith('hf_')) {
                console.warn('\n⚠️  Warning: HuggingFace tokens typically start with "hf_"');
                console.warn('   If this is intentional, you can ignore this warning.');
            }
            
            return true; // Always return true (non-blocking validation)
        }
    }
];

const ngcApiKeyPrompts = [
    {
        type: 'input',
        name: 'ngcApiKey',
        message: 'NVIDIA NGC API key (enter key, "$NGC_API_KEY" for env var, or leave empty):',
        when: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            // Never prompt for NGC key for Triton configs (public images)
            // Requirements: 9.2
            if (architecture === 'triton') {
                return false;
            }
            
            // Never prompt for NGC key for diffusors configs (public Docker Hub images)
            if (architecture === 'diffusors') {
                return false;
            }
            
            // Only prompt for transformers-tensorrt-llm
            if (architecture === 'transformers' && backend === 'tensorrt-llm') {
                console.log('\n🔐 NVIDIA NGC Authentication');
                console.log('   TensorRT-LLM base images are hosted on NVIDIA NGC and require an API key.');
                console.log('   1. Create account at: https://ngc.nvidia.com/');
                console.log('   2. Generate API key in account settings');
                console.log('   For CI/CD pipelines, use "$NGC_API_KEY" to reference an environment variable.\n');
                return true;
            }
            
            return false;
        },
        validate: (input) => {
            if (!input || input.trim() === '') {
                return true;
            }
            
            if (input.trim() === '$NGC_API_KEY') {
                return true;
            }
            
            return true;
        }
    }
];

export {
    deploymentConfigPrompts,
    frameworkPrompts,
    enginePrompts,
    frameworkVersionPrompts,
    frameworkProfilePrompts,
    modelFormatPrompts,
    modelServerPrompts,
    modelLoadStrategyPrompts,
    modelProfilePrompts,
    hfTokenPrompts,
    ngcApiKeyPrompts
};

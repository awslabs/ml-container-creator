// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt definitions organized by phase for better maintainability.
 * Each phase handles a specific aspect of project configuration.
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __promptsFilename = fileURLToPath(import.meta.url);
const __promptsDir = dirname(__promptsFilename);
const instancesCatalogPath = resolve(__promptsDir, '../../servers/lib/catalogs/instances.json');

/**
 * Load instance types from the instances.json catalog and transform
 * into the display shape expected by prompts (type, vcpus, memory, accelerator, useCase, category).
 */
function loadInstanceTypeRegistry() {
    try {
        const raw = readFileSync(instancesCatalogPath, 'utf8');
        const catalog = JSON.parse(raw);
        const entries = catalog?.catalog || {};
        const registry = {};
        for (const [instanceType, entry] of Object.entries(entries)) {
            registry[instanceType] = {
                type: instanceType,
                vcpus: entry.vcpus || 0,
                memory: entry.memGb ? `${entry.memGb} GB` : '0 GB',
                accelerator: entry.hardware && entry.hardware !== 'None'
                    ? entry.accelerator || entry.hardware
                    : 'None',
                useCase: entry.notes || entry.tags?.join(', ') || '',
                category: entry.category || 'cpu'
            };
        }
        return registry;
    } catch (error) {
        console.warn(`Failed to load instance type registry from catalog: ${error.message}`);
        return {};
    }
}

const instanceTypeRegistry = loadInstanceTypeRegistry();

/**
 * Load the raw instance catalog for GPU/CUDA generation lookups.
 * Returns the full catalog entries keyed by instance type.
 */
function loadInstanceCatalogRaw() {
    try {
        const raw = readFileSync(instancesCatalogPath, 'utf8');
        const catalog = JSON.parse(raw);
        return catalog?.catalog || {};
    } catch (error) {
        return {};
    }
}

const instanceCatalogRaw = loadInstanceCatalogRaw();

/**
 * Get the CUDA generation key for an instance type.
 * Uses gpuArchitecture as the generation grouping (e.g., "Turing", "Ampere", "Hopper").
 * Instances in the same generation share AMI compatibility.
 * @param {string} instanceType - e.g., "ml.g5.xlarge"
 * @returns {string|null} Generation key or null if not found/not GPU
 */
function getInstanceCudaGeneration(instanceType) {
    const entry = instanceCatalogRaw[instanceType];
    if (!entry) return null;
    if (entry.acceleratorType !== 'cuda') return null;
    return entry.gpuArchitecture || null;
}

/**
 * Filter instance choices to only include instances from the same CUDA generation
 * as the first (highest-priority) instance in the list.
 * @param {string[]} instanceTypes - Array of instance type strings
 * @returns {{ filtered: string[], generation: string|null, removed: string[] }}
 */
function filterByCudaGeneration(instanceTypes) {
    if (!instanceTypes || instanceTypes.length === 0) {
        return { filtered: [], generation: null, removed: [] };
    }

    // Find the generation of the first instance
    const firstGen = getInstanceCudaGeneration(instanceTypes[0]);
    if (!firstGen) {
        // First instance not in catalog or not CUDA — return all (can't filter)
        return { filtered: instanceTypes, generation: null, removed: [] };
    }

    const filtered = [];
    const removed = [];
    for (const it of instanceTypes) {
        const gen = getInstanceCudaGeneration(it);
        // Keep if same generation, or if not in catalog (don't block unknown types)
        if (gen === firstGen || gen === null) {
            filtered.push(it);
        } else {
            removed.push(it);
        }
    }

    return { filtered, generation: firstGen, removed };
}

/**
 * Generate pseudo-randomized project name based on framework
 * @param {string} framework - The ML framework
 * @returns {string} Generated project name
 */
function generateProjectName(framework) {
    const adjectives = [
        'smart', 'fast', 'clever', 'bright', 'swift', 'agile', 'sharp', 'quick',
        'wise', 'keen', 'bold', 'sleek', 'neat', 'cool', 'fresh', 'prime'
    ];
    
    const frameworkNames = {
        'sklearn': ['sklearn', 'scikit', 'sk'],
        'xgboost': ['xgb', 'xgboost', 'boost'],
        'tensorflow': ['tf', 'tensorflow', 'tensor'],
        'transformers': ['llm', 'transformer', 'gpt', 'bert', 'ai']
    };
    
    const suffixes = [
        'model', 'predictor', 'classifier', 'engine', 'service', 'api',
        'container', 'deployment', 'inference', 'ml', 'ai', 'bot'
    ];
    
    // Get random elements
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const frameworkName = frameworkNames[framework] ? 
        frameworkNames[framework][Math.floor(Math.random() * frameworkNames[framework].length)] :
        'ml';
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    
    return `${adjective}-${frameworkName}-${suffix}`;
}

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
                'openai/gpt-oss-20b',
                'meta-llama/Llama-3.2-3B-Instruct',
                'meta-llama/Llama-3.2-1B-Instruct',
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
            return 'openai/gpt-oss-20b';
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
            // Basic validation - must contain a slash (org/model, hub/model, s3://path, etc.)
            if (!input.includes('/')) {
                return 'Please use the full model path (e.g., microsoft/DialoGPT-medium, jumpstart-hub://my-hub/my-model)';
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
    'openai/gpt-oss-20b',
    'meta-llama/Llama-3.2-3B-Instruct',
    'meta-llama/Llama-3.2-1B-Instruct'
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
            // (S3, JumpStart, Private Hub, Registry models don't need HF auth)
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
 * Infrastructure prompts split into sub-phases so the prompt runner can
 * interleave MCP queries between them (e.g. query instance-recommender
 * only after we know the deployment target is realtime-inference).
 *
 * Ordering: Region → Deployment Target → Instance/HyperPod → Build Target → Role
 */

// Sub-phase A: Region + Deployment Target (always asked first)
const infraRegionAndTargetPrompts = [
    {
        type: 'list',
        name: 'awsRegion',
        message: 'Target AWS region?',
        choices: (answers) => {
            // If a bootstrap profile set a region, include it in choices
            const bootstrapRegion = answers._bootstrapRegion;
            const choices = ['us-east-1'];
            if (bootstrapRegion && bootstrapRegion !== 'us-east-1') {
                choices.unshift({ name: `${bootstrapRegion} (from bootstrap profile)`, value: bootstrapRegion });
            }
            choices.push({ name: 'Custom...', value: 'custom' });
            return choices;
        },
        default: (answers) => answers._bootstrapRegion || 'us-east-1'
    },
    {
        type: 'input',
        name: 'customAwsRegion',
        message: 'Enter AWS region (e.g., us-west-2, eu-west-1):',
        when: answers => answers.awsRegion === 'custom'
    },
    {
        type: 'list',
        name: 'deploymentTarget',
        message: 'Deployment target?',
        choices: [
            { name: 'SageMaker Real-Time Inference', value: 'realtime-inference' },
            { name: 'SageMaker Async Inference', value: 'async-inference' },
            { name: 'SageMaker Batch Transform', value: 'batch-transform' },
            { name: 'SageMaker HyperPod - EKS', value: 'hyperpod-eks' }
        ],
        default: 'realtime-inference'
    }
];

// Sub-phase A2: Existing endpoint prompt (only when deploymentTarget === 'realtime-inference')
const infraExistingEndpointPrompts = [
    {
        type: 'list',
        name: 'useExistingEndpoint',
        message: 'Deploy to an existing endpoint? (attach IC to running endpoint)',
        choices: [
            { name: 'No — create a new endpoint', value: 'no' },
            { name: 'Yes — attach to an existing endpoint', value: 'yes' }
        ],
        default: 'no',
        when: answers => answers.deploymentTarget === 'realtime-inference'
    },
    {
        type: 'list',
        name: 'existingEndpointName',
        message: 'Select endpoint:',
        choices: (answers) => {
            const mcpChoices = answers._mcpEndpointChoices || [];
            if (mcpChoices.length > 0) {
                return [...mcpChoices, { name: 'Custom (enter manually)', value: 'custom' }];
            }
            return [{ name: 'Enter endpoint name manually', value: 'custom' }];
        },
        when: answers => answers.useExistingEndpoint === 'yes'
    },
    {
        type: 'input',
        name: 'customExistingEndpointName',
        message: 'Enter existing endpoint name:',
        validate: (input) => {
            if (!input || input.trim() === '') {
                return 'Endpoint name is required';
            }
            return true;
        },
        when: answers => answers.useExistingEndpoint === 'yes' && answers.existingEndpointName === 'custom'
    }
];

// Sub-phase B: Instance type (only when deploymentTarget === 'realtime-inference')
const infraInstancePrompts = [
    // Multi-select prompt: shown when MCP sizer has choices AND deployment target is realtime-inference
    // User can select 1-5 instances; selection count determines single-type vs instance-pools behavior
    // Requirements: 6.4
    {
        type: 'checkbox',
        name: 'instanceTypeSelections',
        when: answers => answers.deploymentTarget === 'realtime-inference' &&
            answers._mcpInstanceChoices && answers._mcpInstanceChoices.length > 1,
        message: 'Select instance type(s) — select multiple for instance pools (priority = selection order, max 5):',
        choices: (answers) => {
            const mcpChoices = answers._mcpInstanceChoices || [];
            // Show all compatible instances — CUDA generation filtering happens
            // after selection to allow users to see all options and make informed choices.
            // If they select instances from different generations, the post-selection
            // filter (filterByCudaGeneration in prompt-runner.js) will warn and remove incompatible ones.
            const choices = mcpChoices.map(instanceType => {
                const entry = instanceCatalogRaw[instanceType];
                const gpuInfo = entry ? `${entry.gpus} GPU${entry.gpus > 1 ? 's' : ''}, ${entry.gpuMemoryGb || '?'}GB` : '';
                return {
                    name: gpuInfo ? `${instanceType} (${gpuInfo})` : instanceType,
                    value: instanceType,
                    short: instanceType
                };
            });
            // Always include a "Custom Input" option at the end
            choices.push({
                name: 'Custom Input (enter one or comma-separated list)',
                value: '__custom_input__',
                short: 'Custom'
            });
            return choices;
        },
        validate: (input) => {
            if (!input || input.length === 0) {
                return 'Select at least one instance type';
            }
            if (input.length > 5) {
                return 'Maximum 5 instance types allowed (API limit). Please deselect some.';
            }
            return true;
        }
    },
    // Custom input prompt for multi-select: shown when user selects "Custom Input" in instanceTypeSelections
    {
        type: 'input',
        name: 'customInstanceTypeSelections',
        message: 'Enter instance type(s) — single for homogeneous, comma-separated for heterogeneous (e.g., ml.g5.xlarge or ml.g5.xlarge,ml.g5.2xlarge):',
        when: answers => Array.isArray(answers.instanceTypeSelections) &&
            answers.instanceTypeSelections.includes('__custom_input__'),
        validate: (input) => {
            if (!input || input.trim() === '') {
                return 'At least one instance type is required';
            }
            const instancePattern = /^ml\.[a-z0-9]+\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/;
            const instances = input.split(',').map(s => s.trim()).filter(s => s.length > 0);
            if (instances.length === 0) {
                return 'At least one instance type is required';
            }
            if (instances.length > 5) {
                return 'Maximum 5 instance types allowed (API limit).';
            }
            for (const inst of instances) {
                if (!instancePattern.test(inst)) {
                    return `Invalid instance type format: "${inst}". Expected format: ml.{family}.{size} (e.g., ml.g5.xlarge)`;
                }
            }
            return true;
        }
    },
    // Single-select prompt: shown when no MCP choices, or for non-realtime targets, or only 1 MCP choice
    {
        type: 'list',
        name: 'instanceType',
        when: answers => {
            // Skip if multi-select was shown (realtime with multiple MCP choices)
            if (answers.deploymentTarget === 'realtime-inference' &&
                answers._mcpInstanceChoices && answers._mcpInstanceChoices.length > 1) {
                return false;
            }
            return answers.deploymentTarget === 'realtime-inference' || answers.deploymentTarget === 'async-inference' || answers.deploymentTarget === 'batch-transform' || answers.deploymentTarget === 'hyperpod-eks';
        },
        message: (answers) => {
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];

            // Skip table when MCP sizer already displayed annotated results
            if (answers._mcpInstanceChoices && answers._mcpInstanceChoices.length > 0) {
                return 'Select instance type:';
            }

            const table = new Table({
                head: [
                    chalk.cyan('Instance Type'),
                    chalk.cyan('vCPUs'),
                    chalk.cyan('Memory'),
                    chalk.cyan('Accelerator'),
                    chalk.cyan('Use Case')
                ],
                colWidths: [20, 8, 12, 20, 25]
            });
            
            const instances = Object.values(instanceTypeRegistry);
            let filteredInstances = framework === 'transformers' 
                ? instances.filter(i => i.category === 'gpu')
                : instances;
            
            const mcpChoices = answers._mcpInstanceChoices;
            if (mcpChoices && mcpChoices.length > 0) {
                const mcpSet = new Set(mcpChoices);
                filteredInstances = filteredInstances.filter(i => mcpSet.has(i.type));
            }
            
            filteredInstances.forEach(instance => {
                table.push([
                    instance.type,
                    instance.vcpus.toString(),
                    instance.memory,
                    instance.accelerator,
                    instance.useCase
                ]);
            });
            
            table.push([
                chalk.yellow('Custom...'),
                '-',
                '-',
                '-',
                'Specify your own'
            ]);
            
            const header = mcpChoices && mcpChoices.length > 0
                ? 'Available Instance Types (filtered by MCP):'
                : 'Available Instance Types:';
            console.log(`\n${  chalk.bold(header)}`);
            console.log(table.toString());
            console.log('');
            
            return 'Select instance type:';
        },
        choices: (answers) => {
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            
            const instances = Object.values(instanceTypeRegistry);
            let filteredInstances = framework === 'transformers' 
                ? instances.filter(i => i.category === 'gpu')
                : instances;
            
            const mcpChoices = answers._mcpInstanceChoices;
            if (mcpChoices && mcpChoices.length > 0) {
                const mcpSet = new Set(mcpChoices);
                filteredInstances = filteredInstances.filter(i => mcpSet.has(i.type));
            }
            
            const choices = filteredInstances.map(instance => ({
                name: instance.type,
                value: instance.type
            }));
            
            choices.push({
                name: 'Custom...',
                value: 'custom'
            });
            
            return choices;
        },
        default: (answers) => {
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            const modelServer = answers.modelServer || answers.deploymentConfig?.split('-')[1];
            
            if (framework === 'transformers') {
                if (modelServer === 'tensorrt-llm') {
                    return 'ml.g5.12xlarge';
                }
                return 'ml.g5.2xlarge';
            }
            return 'ml.m5.xlarge';
        }
    },
    {
        type: 'input',
        name: 'customInstanceType',
        message: 'Enter AWS SageMaker instance type (e.g., ml.t3.medium, ml.g4dn.xlarge):',
        validate: (input) => {
            if (!input || input.trim() === '') {
                return 'Instance type is required';
            }
            const instancePattern = /^ml\.[a-z0-9]+\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/;
            if (!instancePattern.test(input.trim())) {
                return 'Invalid instance type format. Expected format: ml.{family}.{size} (e.g., ml.m5.large, ml.g4dn.xlarge)';
            }
            return true;
        },
        when: answers => answers.instanceType === 'custom'
    }
];

// Sub-phase C: HyperPod EKS-specific prompts (only when deploymentTarget === 'hyperpod-eks')
const infraHyperPodPrompts = [
    {
        type: 'list',
        name: 'hyperPodCluster',
        message: 'Select HyperPod EKS cluster:',
        choices: (answers) => {
            const mcpChoices = answers._mcpHyperPodChoices || [];
            if (mcpChoices.length > 0) {
                return [...mcpChoices, { name: 'Custom (enter manually)', value: 'custom' }];
            }
            // No MCP results — offer manual entry as the only option
            return [{ name: 'Enter cluster name manually', value: 'custom' }];
        },
        when: answers => answers.deploymentTarget === 'hyperpod-eks'
    },
    {
        type: 'input',
        name: 'customHyperPodCluster',
        message: 'Enter HyperPod EKS cluster name:',
        validate: (input) => {
            if (!input || input.trim() === '') {
                return 'Cluster name is required';
            }
            return true;
        },
        when: answers => answers.deploymentTarget === 'hyperpod-eks' && answers.hyperPodCluster === 'custom'
    },
    {
        type: 'input',
        name: 'hyperPodNamespace',
        message: 'Kubernetes namespace?',
        default: 'default',
        when: answers => answers.deploymentTarget === 'hyperpod-eks'
    },
    {
        type: 'number',
        name: 'hyperPodReplicas',
        message: 'Number of pod replicas?',
        default: 1,
        when: answers => answers.deploymentTarget === 'hyperpod-eks'
    },
    {
        type: 'input',
        name: 'fsxVolumeHandle',
        message: 'FSx for Lustre volume handle (optional, press Enter to skip):',
        when: answers => answers.deploymentTarget === 'hyperpod-eks'
    }
];

// Sub-phase D: Build target + role ARN (always asked last)
const infraBuildPrompts = [
    {
        type: 'list',
        name: 'buildTarget',
        message: 'Build target?',
        choices: [
            { name: 'CodeBuild (recommended)', value: 'codebuild' }
        ],
        default: 'codebuild'
    },
    {
        type: 'list',
        name: 'codebuildComputeType',
        message: 'CodeBuild compute type?',
        choices: [
            'BUILD_GENERAL1_SMALL',
            'BUILD_GENERAL1_MEDIUM',
            'BUILD_GENERAL1_LARGE'
        ],
        default: 'BUILD_GENERAL1_MEDIUM',
        when: answers => answers.buildTarget === 'codebuild'
    },
    {
        type: 'input',
        name: 'awsRoleArn',
        message: 'AWS IAM Role ARN for SageMaker execution (optional)?',
        validate: (input) => {
            if (!input || input.trim() === '') {
                return true;
            }
            const arnPattern = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
            if (!arnPattern.test(input)) {
                return 'Invalid ARN format. Expected: arn:aws:iam::123456789012:role/RoleName';
            }
            return true;
        }
    }
];

/**
 * Sub-phase: Async-specific prompts (only when deploymentTarget === 'async-inference')
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */
const infraAsyncPrompts = [
    {
        type: 'input',
        name: 'asyncS3OutputPath',
        message: 'S3 output path for async results (leave empty for default: s3://ml-container-creator-async-{region}-{account-id}/{project-name}/output/):',
        when: answers => answers.deploymentTarget === 'async-inference'
    },
    {
        type: 'input',
        name: 'asyncSnsSuccessTopic',
        message: 'SNS success topic ARN (leave empty for auto-created per-project topic):',
        when: answers => answers.deploymentTarget === 'async-inference'
    },
    {
        type: 'input',
        name: 'asyncSnsErrorTopic',
        message: 'SNS error topic ARN (leave empty for auto-created per-project topic):',
        when: answers => answers.deploymentTarget === 'async-inference'
    },
    {
        type: 'number',
        name: 'asyncMaxConcurrentInvocations',
        message: 'Max concurrent invocations per instance?',
        default: 1,
        when: answers => answers.deploymentTarget === 'async-inference'
    }
];

/**
 * Sub-phase: Batch transform-specific prompts (only when deploymentTarget === 'batch-transform')
 * Requirements: 2.1, 2.2, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9
 */
const infraBatchTransformPrompts = [
    {
        type: 'input',
        name: 'batchInputPath',
        message: 'S3 input path for batch transform data (leave empty for default: s3://ml-container-creator-batch-{region}-{account-id}/{project-name}/input/):',
        when: answers => answers.deploymentTarget === 'batch-transform'
    },
    {
        type: 'input',
        name: 'batchOutputPath',
        message: 'S3 output path for batch transform results (leave empty for default: s3://ml-container-creator-batch-{region}-{account-id}/{project-name}/output/):',
        when: answers => answers.deploymentTarget === 'batch-transform'
    },
    {
        type: 'number',
        name: 'batchInstanceCount',
        message: 'How many instances should run the batch job in parallel?',
        default: 1,
        when: answers => answers.deploymentTarget === 'batch-transform'
    },
    {
        type: 'list',
        name: 'batchSplitType',
        message: 'Input file format — how should SageMaker read your input files?',
        choices: [
            { name: 'Line — one record per line (JSON lines, CSV)', value: 'Line' },
            { name: 'RecordIO — Amazon RecordIO format', value: 'RecordIO' },
            { name: 'None — send each file as a single request', value: 'None' }
        ],
        default: 'Line',
        when: answers => answers.deploymentTarget === 'batch-transform'
    },
    {
        type: 'list',
        name: 'batchStrategy',
        message: 'How many records should be sent per inference request?',
        choices: [
            { name: 'MultiRecord — batch multiple records per request (higher throughput)', value: 'MultiRecord' },
            { name: 'SingleRecord — one record per request (simpler, more predictable)', value: 'SingleRecord' }
        ],
        default: 'MultiRecord',
        when: answers => answers.deploymentTarget === 'batch-transform'
    },
    {
        type: 'list',
        name: 'batchJoinSource',
        message: 'Include original input data alongside predictions in the output?',
        choices: [
            { name: 'No — output predictions only', value: 'None' },
            { name: 'Yes — merge input with predictions (useful for traceability)', value: 'Input' }
        ],
        default: 'None',
        when: answers => answers.deploymentTarget === 'batch-transform'
    },
    {
        type: 'number',
        name: 'batchMaxConcurrentTransforms',
        message: 'Max concurrent inference requests per instance?',
        default: 1,
        when: answers => answers.deploymentTarget === 'batch-transform'
    },
    {
        type: 'number',
        name: 'batchMaxPayloadInMB',
        message: 'Max request payload size in MB (0-100)?',
        default: 6,
        when: answers => answers.deploymentTarget === 'batch-transform'
    }
];

// Combined view for tests and backward compatibility
const infrastructurePrompts = [
    ...infraRegionAndTargetPrompts,
    ...infraInstancePrompts,
    ...infraHyperPodPrompts,
    ...infraBuildPrompts
];

const projectPrompts = [
    {
        type: 'input',
        name: 'projectName',
        message: 'What is the Project Name?',
        default: (answers) => {
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            return generateProjectName(framework);
        }
    }
];

const destinationPrompts = [
    {
        type: 'input',
        name: 'destinationDir',
        message: 'Where will the output directory be?',
        default: (answers) => {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            return `./${answers.projectName}-${timestamp}`;
        }
    }
];

/**
 * Format ImageEntry[] into Inquirer list choices with tabular display.
 *
 * @param {ImageEntry[]} entries - Image entries from the resolver
 * @param {boolean} isTransformer - Whether to show CUDA column
 * @returns {Array<{name: string, value: string}>} Inquirer choices
 */
function formatImageChoices(entries, isTransformer) {
    return entries.map(entry => {
        const cuda = entry.labels.cuda_version || '-';
        const python = entry.labels.python_version || '-';
        const date = entry.created.slice(0, 10);

        const name = isTransformer
            ? `${entry.repository.padEnd(30)} ${entry.tag.padEnd(16)} ${entry.architecture.padEnd(7)} ${cuda.padEnd(6)} ${python.padEnd(8)} ${date}`
            : `${entry.repository.padEnd(30)} ${entry.tag.padEnd(16)} ${entry.architecture.padEnd(7)} ${python.padEnd(8)} ${date}`;

        return { name, value: entry.image, _meta: { labels: entry.labels, accelerator: entry.accelerator } };
    });
}

/**
 * Base image search prompt (non-transformer only)
 * Requirements: 5.2, 5.4
 */
const baseImageSearchPrompts = [
    {
        type: 'input',
        name: 'baseImageSearch',
        message: '🔌 Search for a Python base image (e.g. "3.11", "3.10", or leave empty for all):',
        default: '',
        when: (answers) => {
            const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
            // Skip for transformers (uses model-server images) and triton (uses NGC images)
            return architecture !== 'transformers' && architecture !== 'triton';
        }
    }
];

/**
 * Base image selection prompt (all frameworks)
 * Requirements: 5.2, 5.4, 10.1, 10.2, 10.3
 */
const baseImagePrompts = [
    {
        type: 'list',
        name: 'baseImage',
        message: 'Select base container image:',
        choices: (answers) => {
            const mcpChoices = answers._mcpBaseImageChoices || [];
            return [...mcpChoices, { name: 'Custom (enter your own)', value: 'custom' }];
        },
        when: (answers) => {
            return answers._mcpBaseImageChoices && answers._mcpBaseImageChoices.length > 0;
        }
    },
    {
        type: 'input',
        name: 'customBaseImage',
        message: 'Enter custom base container image (e.g. myrepo/myimage:v1):',
        validate: (input) => {
            if (!input || input.trim() === '') {
                return 'Base image is required';
            }
            const pattern = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*(:[a-zA-Z0-9._-]+)?$/;
            if (!pattern.test(input.trim())) {
                return 'Invalid image format. Expected: [registry/]repository[:tag]';
            }
            return true;
        },
        when: (answers) => answers.baseImage === 'custom'
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
        default: false,
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
    deploymentConfigPrompts,
    frameworkPrompts, // Deprecated: kept for backward compatibility
    enginePrompts,
    frameworkVersionPrompts,
    frameworkProfilePrompts,
    modelFormatPrompts,
    modelServerPrompts, // Deprecated: now empty, modelServer derived from deploymentConfig
    modelLoadStrategyPrompts,
    modelProfilePrompts,
    hfTokenPrompts,
    ngcApiKeyPrompts,
    modulePrompts,
    loraPrompts,
    benchmarkPrompts,
    infrastructurePrompts,
    infraRegionAndTargetPrompts,
    infraExistingEndpointPrompts,
    infraInstancePrompts,
    infraAsyncPrompts,
    infraBatchTransformPrompts,
    infraHyperPodPrompts,
    infraBuildPrompts,
    projectPrompts,
    destinationPrompts,
    baseImageSearchPrompts,
    baseImagePrompts,
    formatImageChoices,
    filterByCudaGeneration,
    getInstanceCudaGeneration,
    instanceCatalogRaw
};
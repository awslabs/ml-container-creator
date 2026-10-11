// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model & Framework prompt definitions.
 * Covers: deployment config, framework, engine, version, profile, format,
 * model server, model load strategy, model profile, HF token, NGC API key.
 */

import { discoverSecrets } from './secrets-discovery.js';
import { listServeEngines, engineFeatures } from '../serve-manifest-reader.js';
// HTTP predictor engine choices and per-engine model-format sets are derived
// from the predictors.d descriptors (single source of truth), not hardcoded.
import {
    listPredictorFrameworks,
    displayName as predictorDisplayName,
    modelFormats as predictorModelFormats
} from '../predictor-manifest-reader.js';
// Triton per-backend facts (formats, isLlm) derive from triton-backends.json via
// the reader, not hardcoded name lists (BL119 / ADR-008).
import {
    isKnownBackend as isTritonBackend,
    isLlm as tritonIsLlm,
    modelFormats as tritonModelFormats
} from '../triton-backend-reader.js';

/**
 * Engine-specific feature prompts (ADR-004 §c), built from the serve-plugin
 * manifests. One prompt per (engine, feature) pair, each gated to appear only
 * when that engine is selected — so a vLLM project is never asked about SGLang's
 * RadixAttention. The widget is DERIVED from the feature's declared `type`
 * (boolean → confirm, enum → list of `values`, int/string → input). Each answer
 * is stored under a namespaced key `__engine_feature__<name>` that PromptRunner
 * normalizes into the `engineFeatureVars` map (same shape the --engine-feature
 * CLI flag produces). Reads the manifests as data — no engine-name branching.
 */
export const ENGINE_FEATURE_ANSWER_PREFIX = '__engine_feature__';

function buildEngineFeaturePrompts() {
    const prompts = [];
    for (const engine of listServeEngines()) {
        const features = engineFeatures(engine);
        for (const [name, decl] of Object.entries(features)) {
            const answerKey = `${ENGINE_FEATURE_ANSWER_PREFIX}${name}`;
            const base = {
                name: answerKey,
                // Only ask when THIS engine is the selected one.
                when: (answers) => {
                    const selected = answers.modelServer || answers.backend ||
                        answers.deploymentConfig?.split('-').slice(1).join('-');
                    return selected === engine;
                }
            };
            if (decl.type === 'boolean') {
                prompts.push({
                    ...base,
                    type: 'confirm',
                    message: `Enable ${name}? (${decl.description})`,
                    default: decl.default === 'true'
                });
            } else if (decl.type === 'enum') {
                prompts.push({
                    ...base,
                    type: 'list',
                    message: `${name}: ${decl.description}`,
                    choices: decl.values || [],
                    default: decl.default
                });
            } else {
                // int / string → free input
                prompts.push({
                    ...base,
                    type: 'input',
                    message: `${name}: ${decl.description}`,
                    default: decl.default
                });
            }
        }
    }
    return prompts;
}

const engineFeaturePrompts = buildEngineFeaturePrompts();

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
            // AWS Marketplace deployment config is deprecated and hard-refused
            // (see src/lib/marketplace-refusal.js). The menu choice is removed so
            // users cannot select a dead option; the generation surface was removed
            // in BL120, leaving only the hard-refusal.
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
        // Derived from predictors.d/<framework>/manifest.json (display_name) so
        // adding a framework surfaces its prompt choice with no code edit.
        choices: () => listPredictorFrameworks().map((fw) => ({
            name: predictorDisplayName(fw),
            value: fw
        })),
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
            
            // For http architecture, the engine's model formats come from its
            // predictor descriptor (single source of truth).
            if (architecture === 'http') {
                return predictorModelFormats(answers.engine);
            }
            
            // For triton architecture, the backend's valid formats come from the
            // catalog (BL119). LLM backends have modelFormats:null (served by name,
            // no format choice); file-artifact backends return their format list.
            if (architecture === 'triton') {
                if (!isTritonBackend(backend)) return [];
                return tritonModelFormats(backend) || [];
            }
            
            // Legacy support for old format (should not be reached with new
            // configs); derive from the descriptor rather than a stale literal.
            const framework = answers.framework || architecture;
            return predictorModelFormats(framework);
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
            
            // For triton architecture, only show when the backend has MORE THAN ONE
            // catalog format to choose between (BL119). Single-format backends are
            // auto-set; LLM backends (modelFormats:null) have no format choice.
            if (architecture === 'triton') {
                if (!isTritonBackend(backend)) return false;
                const formats = tritonModelFormats(backend);
                return Array.isArray(formats) && formats.length > 1;
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
            
            // Show for Triton LLM backends (derived from the catalog — BL119)
            if (architecture === 'triton' && isTritonBackend(backend) && tritonIsLlm(backend)) {
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
            
            // Show for Triton LLM backends with custom model selection (derived — BL119)
            if (architecture === 'triton' && isTritonBackend(backend) && tritonIsLlm(backend) && answers.modelName === 'Custom (enter manually)') {
                return true;
            }
            
            return false;
        }
    }
];

// Model server prompts are now deprecated - modelServer is derived from deploymentConfig
const modelServerPrompts = [];

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
            
            // Prompt for Triton LLM backends (derived from the catalog — BL119)
            // Requirements: 9.1, 9.2
            const isTritonLlm = architecture === 'triton' && isTritonBackend(backend) && tritonIsLlm(backend);
            
            if (!isTransformers && !isDiffusors && !isTritonLlm) {
                return false;
            }
            
            // Skip HF token prompt for non-HuggingFace model sources
            // (S3, Registry models don't need HF auth)
            const modelSource = answers.modelSource;
            if (modelSource && modelSource !== 'huggingface') {
                return false;
            }
            
            // Skip HF token when model name is an S3 URI (no HF download needed)
            const modelName = answers.customModelName || answers.modelName;
            if (modelName && modelName.startsWith('s3://')) {
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

/**
 * BL067: Async factory that builds HF token prompts with Secrets Manager discovery.
 * 
 * Queries Secrets Manager for existing secrets matching HuggingFace naming patterns,
 * and returns either a list-type prompt (if secrets found) or the existing input-type
 * prompt (fallback).
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 6.1
 *
 * @param {object} answers - Current answers object (must include awsProfile, awsRegion)
 * @param {object} [deps] - Optional dependency injection seam (tests only).
 * @param {Function} [deps.discoverSecrets] - Override for Secrets Manager discovery.
 *   Defaults to the real SDK-backed discoverSecrets. Injecting a stub lets tests
 *   exercise this factory (including the error-fallback path) without making any
 *   AWS calls (BL091 / Option B).
 * @returns {Promise<Array>} Array of prompt definitions
 */
async function buildHfTokenPrompts(answers, deps = {}) {
    const discover = deps.discoverSecrets || discoverSecrets;
    try {
        const awsProfile = answers.awsProfile || '';
        const awsRegion = answers.awsRegion || '';

        if (!awsRegion) {
            return hfTokenPrompts;
        }

        // Query multiple naming patterns (Requirement 1.1)
        const [hfSecrets, hfTokenSecrets, hfUnderscoreSecrets] = await Promise.all([
            discover('huggingface', awsProfile, awsRegion),
            discover('hf-token', awsProfile, awsRegion),
            discover('hf_token', awsProfile, awsRegion)
        ]);

        // Deduplicate by ARN
        const arnSet = new Set();
        const allSecrets = [];
        for (const secret of [...hfSecrets, ...hfTokenSecrets, ...hfUnderscoreSecrets]) {
            if (!arnSet.has(secret.arn)) {
                arnSet.add(secret.arn);
                allSecrets.push(secret);
            }
        }

        if (allSecrets.length > 0) {
            // Requirement 1.2: list-type prompt with discovered secrets
            return [{
                type: 'list',
                name: 'hfToken',
                message: 'Select HuggingFace token source:',
                choices: [
                    ...allSecrets.map(secret => {
                        const truncatedArn = secret.arn.length > 60
                            ? `${secret.arn.slice(0, 57)}...`
                            : secret.arn;
                        return {
                            name: `🔒 ${secret.name} (${truncatedArn})`,
                            value: { arn: secret.arn },
                            short: secret.name
                        };
                    }),
                    { name: '✨ Create a new secret', value: { createNew: true }, short: 'Create new' },
                    { name: '⏭️  Skip / configure later', value: { skip: true }, short: 'Skip' }
                ],
                when: (promptAnswers) => {
                    const architecture = promptAnswers.architecture || promptAnswers.deploymentConfig?.split('-')[0];
                    const backend = promptAnswers.backend || promptAnswers.deploymentConfig?.split('-').slice(1).join('-');
                    const isTransformers = architecture === 'transformers';
                    const isDiffusors = architecture === 'diffusors';
                    const isTritonLlm = architecture === 'triton' && isTritonBackend(backend) && tritonIsLlm(backend);
                    if (!isTransformers && !isDiffusors && !isTritonLlm) return false;
                    const modelSource = promptAnswers.modelSource;
                    if (modelSource && modelSource !== 'huggingface') return false;
                    const modelName = promptAnswers.customModelName || promptAnswers.modelName;
                    if (modelName && modelName.startsWith('s3://')) return false;
                    return true;
                }
            }];
        }

        // Requirement 1.3: no secrets found — return existing input prompt
        return hfTokenPrompts;
    } catch {
        // Requirement 1.4: fallback on any error
        return hfTokenPrompts;
    }
}

export {
    deploymentConfigPrompts,
    frameworkPrompts,
    enginePrompts,
    frameworkVersionPrompts,
    frameworkProfilePrompts,
    modelFormatPrompts,
    modelServerPrompts,
    modelProfilePrompts,
    hfTokenPrompts,
    buildHfTokenPrompts,
    ngcApiKeyPrompts,
    engineFeaturePrompts
};

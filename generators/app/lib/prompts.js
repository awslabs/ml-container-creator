// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt definitions organized by phase for better maintainability.
 * Each phase handles a specific aspect of project configuration.
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import instanceTypeRegistry from '../config/registries/instance-types.js';

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
 * Flattened deployment configuration combining framework + model server
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.8, 16.9
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
            { type: 'separator', separator: '── Traditional ML ──' },
            {
                name: 'scikit-learn with Flask',
                value: 'sklearn-flask',
                short: 'sklearn-flask'
            },
            {
                name: 'scikit-learn with FastAPI',
                value: 'sklearn-fastapi',
                short: 'sklearn-fastapi'
            },
            {
                name: 'XGBoost with Flask',
                value: 'xgboost-flask',
                short: 'xgboost-flask'
            },
            {
                name: 'XGBoost with FastAPI',
                value: 'xgboost-fastapi',
                short: 'xgboost-fastapi'
            },
            {
                name: 'TensorFlow with Flask',
                value: 'tensorflow-flask',
                short: 'tensorflow-flask'
            },
            {
                name: 'TensorFlow with FastAPI',
                value: 'tensorflow-fastapi',
                short: 'tensorflow-fastapi'
            }
        ]
    }
];

// Keep legacy frameworkPrompts for backward compatibility (deprecated)
const frameworkPrompts = deploymentConfigPrompts;

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
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            const formatMap = {
                'xgboost': ['json', 'model', 'ubj'],
                'sklearn': ['pkl', 'joblib'],
                'tensorflow': ['keras', 'h5', 'SavedModel']
            };
            return formatMap[framework] || [];
        },
        when: answers => {
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            return framework !== 'transformers';
        }
    },
    {
        type: 'list',
        name: 'modelName',
        message: 'Which model do you want to use?',
        choices: [
            'openai/gpt-oss-20b',
            'meta-llama/Llama-3.2-3B-Instruct',
            'meta-llama/Llama-3.2-1B-Instruct',
            'Custom (enter manually)'
        ],
        default: 'openai/gpt-oss-20b',
        when: answers => {
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            return framework === 'transformers';
        }
    },
    {
        type: 'input',
        name: 'customModelName',
        message: 'Enter the Hugging Face model path:',
        validate: (input) => {
            if (!input || input.trim() === '') {
                return 'Model name is required for transformers';
            }
            // Basic validation for Hugging Face model format (org/model-name)
            if (!input.includes('/')) {
                return 'Please use the full Hugging Face model path (e.g., microsoft/DialoGPT-medium)';
            }
            return true;
        },
        when: answers => {
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            return framework === 'transformers' && answers.modelName === 'Custom (enter manually)';
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
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            
            // Only prompt for transformers framework
            if (framework !== 'transformers') {
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
            const modelServer = answers.modelServer || answers.deploymentConfig?.split('-').slice(1).join('-');
            
            if (modelServer !== 'tensorrt-llm') {
                return false;
            }
            
            console.log('\n🔐 NVIDIA NGC Authentication');
            console.log('   TensorRT-LLM base images are hosted on NVIDIA NGC and require an API key.');
            console.log('   1. Create account at: https://ngc.nvidia.com/');
            console.log('   2. Generate API key in account settings');
            console.log('   For CI/CD pipelines, use "$NGC_API_KEY" to reference an environment variable.\n');
            
            return true;
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
        default: false,
        when: (answers) => {
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            return framework !== 'transformers';
        }
    },
    {
        type: 'checkbox',
        name: 'testTypes',
        message: 'Test type?',
        choices: (answers) => {
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            if (framework === 'transformers') {
                return ['hosted-model-endpoint'];
            }
            return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
        },
        default: (answers) => {
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            if (framework === 'transformers') {
                return ['hosted-model-endpoint'];
            }
            return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
        }
    }
];

/**
 * Infrastructure prompts split into sub-phases so the prompt runner can
 * interleave MCP queries between them (e.g. query instance-recommender
 * only after we know the deployment target is managed-inference).
 *
 * Ordering: Region → Deployment Target → Instance/HyperPod → Build Target → Role
 */

// Sub-phase A: Region + Deployment Target (always asked first)
const infraRegionAndTargetPrompts = [
    {
        type: 'list',
        name: 'awsRegion',
        message: 'Target AWS region?',
        choices: [
            'us-east-1',
            { name: 'Custom...', value: 'custom' }
        ],
        default: 'us-east-1'
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
            { name: 'SageMaker Managed Inference - Real Time', value: 'managed-inference' },
            { name: 'SageMaker HyperPod - EKS', value: 'hyperpod-eks' }
        ],
        default: 'managed-inference'
    }
];

// Sub-phase B: Instance type (only when deploymentTarget === 'managed-inference')
const infraInstancePrompts = [
    {
        type: 'list',
        name: 'instanceType',
        when: answers => answers.deploymentTarget === 'managed-inference' || answers.deploymentTarget === 'hyperpod-eks',
        message: (answers) => {
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            
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
        const cuda = entry.labels.cuda_version || '-'
        const python = entry.labels.python_version || '-'
        const date = entry.created.slice(0, 10)

        const name = isTransformer
            ? `${entry.repository.padEnd(30)} ${entry.tag.padEnd(16)} ${entry.architecture.padEnd(7)} ${cuda.padEnd(6)} ${python.padEnd(8)} ${date}`
            : `${entry.repository.padEnd(30)} ${entry.tag.padEnd(16)} ${entry.architecture.padEnd(7)} ${python.padEnd(8)} ${date}`

        return { name, value: entry.image }
    })
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
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0]
            return framework !== 'transformers'
        }
    }
]

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
            const mcpChoices = answers._mcpBaseImageChoices || []
            return [...mcpChoices, { name: 'Custom (enter your own)', value: 'custom' }]
        },
        when: (answers) => {
            return answers._mcpBaseImageChoices && answers._mcpBaseImageChoices.length > 0
        }
    },
    {
        type: 'input',
        name: 'customBaseImage',
        message: 'Enter custom base container image (e.g. myrepo/myimage:v1):',
        validate: (input) => {
            if (!input || input.trim() === '') {
                return 'Base image is required'
            }
            const pattern = /^[a-zA-Z0-9][a-zA-Z0-9._\-\/]*(:[a-zA-Z0-9._\-]+)?$/
            if (!pattern.test(input.trim())) {
                return 'Invalid image format. Expected: [registry/]repository[:tag]'
            }
            return true
        },
        when: (answers) => answers.baseImage === 'custom'
    }
]

export {
    deploymentConfigPrompts,
    frameworkPrompts, // Deprecated: kept for backward compatibility
    frameworkVersionPrompts,
    frameworkProfilePrompts,
    modelFormatPrompts,
    modelServerPrompts, // Deprecated: now empty, modelServer derived from deploymentConfig
    modelProfilePrompts,
    hfTokenPrompts,
    ngcApiKeyPrompts,
    modulePrompts,
    infrastructurePrompts,
    infraRegionAndTargetPrompts,
    infraInstancePrompts,
    infraHyperPodPrompts,
    infraBuildPrompts,
    projectPrompts,
    destinationPrompts,
    baseImageSearchPrompts,
    baseImagePrompts,
    formatImageChoices
};
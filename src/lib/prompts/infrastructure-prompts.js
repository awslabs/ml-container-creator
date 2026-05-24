// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Infrastructure prompt definitions.
 * Covers: all infra* prompts, base image prompts, and utilities
 * (formatImageChoices, filterByCudaGeneration, getInstanceCudaGeneration, instanceCatalogRaw).
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __promptsFilename = fileURLToPath(import.meta.url);
const __promptsDir = dirname(__promptsFilename);
const instancesCatalogPath = resolve(__promptsDir, '../../../servers/lib/catalogs/instances.json');

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

export {
    infrastructurePrompts,
    infraRegionAndTargetPrompts,
    infraExistingEndpointPrompts,
    infraInstancePrompts,
    infraAsyncPrompts,
    infraBatchTransformPrompts,
    infraHyperPodPrompts,
    infraBuildPrompts,
    baseImageSearchPrompts,
    baseImagePrompts,
    formatImageChoices,
    filterByCudaGeneration,
    getInstanceCudaGeneration,
    instanceCatalogRaw
};

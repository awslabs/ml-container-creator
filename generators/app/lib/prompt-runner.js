// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt Runner - Orchestrates the prompting phases with clear user feedback
 * 
 * This module handles running prompts in organized phases with console output
 * to guide users through the configuration process.
 */

import {
    deploymentConfigPrompts,
    enginePrompts,
    frameworkVersionPrompts,
    frameworkProfilePrompts,
    modelFormatPrompts,
    modelServerPrompts,
    modelProfilePrompts,
    hfTokenPrompts,
    ngcApiKeyPrompts,
    modulePrompts,
    infraRegionAndTargetPrompts,
    infraInstancePrompts,
    infraHyperPodPrompts,
    infraBuildPrompts,
    projectPrompts,
    destinationPrompts,
    baseImageSearchPrompts,
    baseImagePrompts,
    formatImageChoices
} from './prompts.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import instanceAcceleratorMapping from '../config/registries/instance-accelerator-mapping.js';
import tritonBackends from '../config/registries/triton-backends.js';

const __pr_filename = fileURLToPath(import.meta.url);
const __pr_dirname = path.dirname(__pr_filename);
const GENERATOR_ROOT = path.resolve(__pr_dirname, '..', '..', '..');

export default class PromptRunner {
    constructor(generator) {
        this.generator = generator;
        this.configManager = generator.configManager;
    }

    /**
     * Runs all prompting phases and returns combined answers
     * @returns {Promise<Object>} Combined answers from all phases
     */
    async run() {
        const buildTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        // Get existing configuration to use as defaults
        const existingConfig = this.generator.baseConfig || {};
        
        // Get only explicit configuration (not defaults) for prompt skipping
        const explicitConfig = this.configManager ? this.configManager.getExplicitConfiguration() : {};

        // Phase 1: Infrastructure & Deployment
        // Requirements: 3.1 — infrastructure prompts run first
        // Ordering: Region → Deployment Target → Instance (if managed) → HyperPod (if eks) → Build Target
        console.log('\n💪 Infrastructure & Deployment');

        // 1a. Query region MCP, then prompt for region + deployment target
        await this._queryMcpForRegion({}, explicitConfig);
        const regionAndTargetAnswers = await this._runPhase(infraRegionAndTargetPrompts, {}, explicitConfig, existingConfig);

        // 1b. Instance type — query MCP and prompt for managed-inference and hyperpod-eks
        let instanceAnswers = {};
        if (regionAndTargetAnswers.deploymentTarget === 'managed-inference' ||
            regionAndTargetAnswers.deploymentTarget === 'hyperpod-eks') {
            await this._queryMcpForInstance({}, explicitConfig);
            const mcpInstanceChoices = this.configManager?.mcpChoices?.instanceType;
            const instancePreviousAnswers = {
                ...regionAndTargetAnswers,
                ...(mcpInstanceChoices && mcpInstanceChoices.length > 0 ? { _mcpInstanceChoices: mcpInstanceChoices } : {})
            };
            instanceAnswers = await this._runPhase(infraInstancePrompts, instancePreviousAnswers, explicitConfig, existingConfig);
        }

        // 1c. HyperPod prompts — only query MCP and prompt when deployment target is hyperpod-eks
        let hyperPodAnswers = {};
        if (regionAndTargetAnswers.deploymentTarget === 'hyperpod-eks') {
            // Resolve the actual region (handle 'custom' selection)
            const resolvedRegion = regionAndTargetAnswers.customAwsRegion || regionAndTargetAnswers.awsRegion;
            await this._queryMcpForHyperPod({ ...regionAndTargetAnswers, awsRegion: resolvedRegion }, explicitConfig);
            hyperPodAnswers = await this._runPhase(infraHyperPodPrompts, { ...regionAndTargetAnswers }, explicitConfig, existingConfig);
        }

        // 1d. Build target + role ARN (always)
        const buildAnswers = await this._runPhase(infraBuildPrompts, { ...regionAndTargetAnswers, ...instanceAnswers, ...hyperPodAnswers }, explicitConfig, existingConfig);

        // Combine all infrastructure answers
        const infraAnswers = {
            ...regionAndTargetAnswers,
            ...instanceAnswers,
            ...hyperPodAnswers,
            ...buildAnswers
        };

        // Phase 2: Core ML Configuration
        // Requirements: 3.1, 3.2 — ML configuration prompts run after infrastructure
        console.log('\n🔧 Core ML Configuration');
        const deploymentConfigAnswers = await this._runPhase(deploymentConfigPrompts, { ...infraAnswers }, explicitConfig, existingConfig);
        
        // Derive architecture, backend, and legacy framework/modelServer from deploymentConfig
        // Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
        let architecture, backend, framework, modelServer;
        if (deploymentConfigAnswers.deploymentConfig) {
            const parts = deploymentConfigAnswers.deploymentConfig.split('-');
            architecture = parts[0];
            backend = parts.slice(1).join('-');
            // Legacy compatibility: derive framework and modelServer
            framework = architecture;
            modelServer = backend;
        }
        
        // Add derived values to answers
        const frameworkAnswers = {
            ...deploymentConfigAnswers,
            architecture: architecture || deploymentConfigAnswers.architecture,
            backend: backend || deploymentConfigAnswers.backend,
            framework: framework || deploymentConfigAnswers.framework,
            modelServer: modelServer || deploymentConfigAnswers.modelServer
        };
        
        // Engine prompt for http architecture
        // Requirements: 3.7
        const engineAnswers = await this._runPhase(enginePrompts, { ...frameworkAnswers }, explicitConfig, existingConfig);
        
        // Auto-set model format for Triton backends with single format
        // Requirements: 3.3, 3.4, 3.5
        const tritonAutoFormat = this._getTritonAutoModelFormat(architecture, backend);
        
        // Query base-image-picker MCP server for base image choices
        // Requirements: 5.1, 5.2, 5.3
        await this._queryMcpForBaseImage(frameworkAnswers, explicitConfig)
        const baseImagePreviousAnswers = {
            ...frameworkAnswers,
            ...engineAnswers,
            ...(this._mcpBaseImageChoices ? { _mcpBaseImageChoices: this._mcpBaseImageChoices } : {})
        }
        const baseImageAnswers = await this._runPhase(
            baseImagePrompts,
            baseImagePreviousAnswers,
            explicitConfig,
            existingConfig
        )

        // Populate framework version choices from registry
        const frameworkVersionChoices = this._getFrameworkVersionChoices(frameworkAnswers.framework);
        const frameworkVersionAnswers = await this._runPhase(
            frameworkVersionPrompts, 
            {...frameworkAnswers, ...engineAnswers, _frameworkVersionChoices: frameworkVersionChoices}, 
            explicitConfig, 
            existingConfig
        );
        
        // Display validation information if version was selected
        if (frameworkVersionAnswers.frameworkVersion) {
            this._displayFrameworkValidationInfo(frameworkAnswers.framework, frameworkVersionAnswers.frameworkVersion);
        }
        
        // Populate framework profile choices from registry
        const frameworkProfileChoices = this._getFrameworkProfileChoices(
            frameworkAnswers.framework, 
            frameworkVersionAnswers.frameworkVersion
        );
        const frameworkProfileAnswers = await this._runPhase(
            frameworkProfilePrompts,
            {...frameworkAnswers, ...engineAnswers, ...frameworkVersionAnswers, _frameworkProfileChoices: frameworkProfileChoices},
            explicitConfig,
            existingConfig
        );
        
        // Query model-picker MCP server for model choices
        this._queryMcpForModels(frameworkAnswers.architecture)
        if (this._mcpModelChoices) {
            console.log(`   🔍 Querying model-picker...`)
            console.log(`   ✓ ${this._mcpModelChoices.length} model(s) available from catalog`)
        }
        const modelFormatPreviousAnswers = {
            ...frameworkAnswers,
            ...engineAnswers,
            ...frameworkVersionAnswers,
            ...frameworkProfileAnswers,
            ...(this._mcpModelChoices ? { _mcpModelChoices: this._mcpModelChoices } : {})
        }
        const modelFormatAnswers = await this._runPhase(
            modelFormatPrompts, 
            modelFormatPreviousAnswers, 
            explicitConfig, 
            existingConfig
        );
        
        // Model server prompts are now deprecated (empty array)
        const modelServerAnswers = await this._runPhase(
            modelServerPrompts, 
            {...frameworkAnswers, ...engineAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers}, 
            explicitConfig, 
            existingConfig
        );
        
        // Populate model profile choices from registry (if model ID is available)
        const currentAnswers = {...frameworkAnswers, ...engineAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers, ...modelFormatAnswers, ...modelServerAnswers};
        const modelId = currentAnswers.customModelName || currentAnswers.modelName;
        
        // Fetch model information from HuggingFace and Model Registry
        // Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.11, 11.1, 11.2, 11.3, 11.5, 11.6, 11.7
        if (modelId && modelId !== 'Custom (enter manually)') {
            await this._fetchAndDisplayModelInfo(modelId);
        }
        
        const modelProfileChoices = this._getModelProfileChoices(modelId);
        const modelProfileAnswers = await this._runPhase(
            modelProfilePrompts,
            {...currentAnswers, _modelProfileChoices: modelProfileChoices},
            explicitConfig,
            existingConfig
        );
        
        const hfTokenAnswers = await this._runPhase(hfTokenPrompts, 
            { ...frameworkAnswers, ...engineAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers, ...modelFormatAnswers, ...modelServerAnswers, ...modelProfileAnswers }, 
            explicitConfig, existingConfig);

        const ngcApiKeyAnswers = await this._runPhase(ngcApiKeyPrompts,
            { ...frameworkAnswers, ...engineAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers, ...modelFormatAnswers, ...modelServerAnswers, ...modelProfileAnswers },
            explicitConfig, existingConfig);

        // Validate instance type against framework requirements (now that framework is known)
        // Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
        const instanceType = infraAnswers.customInstanceType || infraAnswers.instanceType;
        if (instanceType && frameworkVersionAnswers.frameworkVersion) {
            await this._validateAndDisplayInstanceType(
                instanceType,
                frameworkAnswers.framework,
                frameworkVersionAnswers.frameworkVersion
            );
        }

        // CUDA version selection: if the selected instance supports multiple CUDA versions,
        // let the user pick which one. This transparently sets the inference AMI version.
        const cudaAnswer = await this._promptCudaVersion(
            instanceType,
            frameworkAnswers.framework,
            frameworkVersionAnswers.frameworkVersion
        );
        if (cudaAnswer) {
            infraAnswers._selectedCudaVersion = cudaAnswer.cudaVersion;
            infraAnswers._resolvedInferenceAmiVersion = cudaAnswer.inferenceAmiVersion;
        }

        // Phase 3: Module Selection
        // Requirements: 3.3 — module selection after ML configuration
        console.log('\n📦 Module Selection');
        const moduleAnswers = await this._runPhase(modulePrompts, { ...frameworkAnswers, ...engineAnswers }, explicitConfig, existingConfig);
        
        // Ensure transformers, diffusors, and ineligible Triton backends don't get sample model
        if (frameworkAnswers.architecture === 'transformers' ||
            frameworkAnswers.architecture === 'diffusors' ||
            (frameworkAnswers.architecture === 'triton' && 
             !tritonBackends[frameworkAnswers.backend]?.supportsSampleModel)) {
            moduleAnswers.includeSampleModel = false;
        }

        // Phase 4: Project Configuration
        // Requirements: 3.4 — project configuration last
        console.log('\n📋 Project Configuration');
        const allTechnicalAnswers = {
            ...frameworkAnswers,
            ...engineAnswers,
            ...modelFormatAnswers,
            ...modelServerAnswers,
            ...moduleAnswers,
            ...infraAnswers
        };
        const projectAnswers = await this._runPhase(projectPrompts, allTechnicalAnswers, explicitConfig, existingConfig);
        const destinationAnswers = await this._runPhase(destinationPrompts, 
            { ...allTechnicalAnswers, ...projectAnswers }, explicitConfig, existingConfig);

        // Combine all answers
        const combinedAnswers = {
            ...infraAnswers,
            ...frameworkAnswers,
            ...engineAnswers,
            ...baseImageAnswers,
            ...frameworkVersionAnswers,
            ...frameworkProfileAnswers,
            ...modelFormatAnswers,
            ...modelServerAnswers,
            ...modelProfileAnswers,
            ...hfTokenAnswers,
            ...ngcApiKeyAnswers,
            ...moduleAnswers,
            ...projectAnswers,
            ...destinationAnswers,
            buildTimestamp
        };

        // Apply auto-set model format for Triton backends with single format
        // Requirements: 3.3, 3.4, 3.5
        if (tritonAutoFormat) {
            combinedAnswers.modelFormat = tritonAutoFormat
        }

        // Handle custom model name for transformers, diffusors, and Triton LLM backends
        if ((combinedAnswers.architecture === 'transformers' || 
             combinedAnswers.architecture === 'diffusors' ||
             (combinedAnswers.architecture === 'triton' && (combinedAnswers.backend === 'vllm' || combinedAnswers.backend === 'tensorrtllm'))) 
            && combinedAnswers.customModelName) {
            combinedAnswers.modelName = combinedAnswers.customModelName;
            delete combinedAnswers.customModelName;
        }

        // Handle custom instance type
        if (combinedAnswers.customInstanceType) {
            combinedAnswers.instanceType = combinedAnswers.customInstanceType;
            delete combinedAnswers.customInstanceType;
        }

        // Handle custom HyperPod cluster name
        if (combinedAnswers.customHyperPodCluster) {
            combinedAnswers.hyperPodCluster = combinedAnswers.customHyperPodCluster;
            delete combinedAnswers.customHyperPodCluster;
        }

        // Apply CUDA version selection → inference AMI override
        if (combinedAnswers._resolvedInferenceAmiVersion) {
            combinedAnswers.inferenceAmiVersion = combinedAnswers._resolvedInferenceAmiVersion;
        }
        if (combinedAnswers._selectedCudaVersion) {
            combinedAnswers.selectedCudaVersion = combinedAnswers._selectedCudaVersion;
        }
        // Clean up internal fields
        delete combinedAnswers._resolvedInferenceAmiVersion;
        delete combinedAnswers._selectedCudaVersion;

        // Handle custom AWS region
        if (combinedAnswers.customAwsRegion) {
            combinedAnswers.awsRegion = combinedAnswers.customAwsRegion;
            delete combinedAnswers.customAwsRegion;
        }

        // Handle custom base image
        if (combinedAnswers.customBaseImage) {
            combinedAnswers.baseImage = combinedAnswers.customBaseImage
            combinedAnswers._baseImageSource = 'custom'
            delete combinedAnswers.customBaseImage
        }

        // Handle --base-image CLI override
        if (this.generator.options['base-image']) {
            combinedAnswers.baseImage = this.generator.options['base-image']
        }

        // Map awsRoleArn to roleArn for templates
        if (combinedAnswers.awsRoleArn) {
            combinedAnswers.roleArn = combinedAnswers.awsRoleArn;
            delete combinedAnswers.awsRoleArn;
        }

        return combinedAnswers;
    }

    /**
     * Checks if a parameter is promptable according to the parameter matrix
     * @param {string} parameterName - Name of the parameter
     * @returns {boolean} True if parameter is promptable
     * @private
     */
    _isParameterPromptable(parameterName) {
        if (!this.configManager || !this.configManager.parameterMatrix) {
            return true; // Default to promptable if matrix not available
        }
        
        const paramConfig = this.configManager.parameterMatrix[parameterName];
        return paramConfig ? paramConfig.promptable : true;
    }

    /**
     * Filters prompts to exclude non-promptable parameters
     * @param {Array} prompts - Array of prompt objects
     * @returns {Array} Filtered prompts excluding non-promptable parameters
     * @private
     */
    _filterPromptableParameters(prompts) {
        return prompts.filter(prompt => this._isParameterPromptable(prompt.name));
    }

    /**
     * Runs a single phase of prompts
     * @private
     */
    async _runPhase(prompts, previousAnswers = {}, explicitConfig = {}, existingConfig = {}) {
        // Filter out non-promptable parameters
        const promptablePrompts = this._filterPromptableParameters(prompts);
        
        if (promptablePrompts.length === 0) return {};
        
        // First, add any existing config values to previousAnswers so they're available for defaults
        const allPreviousAnswers = { ...existingConfig, ...previousAnswers };
        
        return await this.generator.prompt(promptablePrompts.map(prompt => ({
            ...prompt,
            // Wrap message to inject previousAnswers so prompts can access _mcpInstanceChoices etc.
            message: typeof prompt.message === 'function' ? (answers) => {
                return prompt.message({...allPreviousAnswers, ...answers});
            } : prompt.message,
            // Use existing config as default if available
            default: prompt.default ? (answers) => {
                // Check if we have a value from existing config first
                if (existingConfig[prompt.name] !== undefined && existingConfig[prompt.name] !== null) {
                    return existingConfig[prompt.name];
                }
                // Otherwise use the original default logic
                if (typeof prompt.default === 'function') {
                    return prompt.default({...allPreviousAnswers, ...answers});
                }
                return prompt.default;
            } : (existingConfig[prompt.name] !== undefined && existingConfig[prompt.name] !== null) ? 
                existingConfig[prompt.name] : undefined,
            // Skip prompt ONLY if we have explicit config (not defaults)
            when: prompt.when ? (answers) => {
                // Skip if we have the value from explicit config (CLI, env vars, config files)
                if (explicitConfig[prompt.name] !== undefined && explicitConfig[prompt.name] !== null) {
                    return false;
                }
                return prompt.when({...allPreviousAnswers, ...answers});
            } : (explicitConfig[prompt.name] !== undefined && explicitConfig[prompt.name] !== null) ? 
                false : undefined,
            // Provide access to previous answers for conditional logic
            // For unbounded parameters, inject MCP-provided choices if available
            choices: prompt.choices ? (answers) => {
                const mcpChoices = this.configManager?.mcpChoices?.[prompt.name];
                if (mcpChoices && mcpChoices.length > 0) {
                    return [...mcpChoices.map(v => ({ name: v, value: v })), { name: 'Custom (enter manually)', value: 'custom' }];
                }
                // Fallback to original choices
                if (typeof prompt.choices === 'function') {
                    return prompt.choices({...allPreviousAnswers, ...answers});
                }
                return prompt.choices;
            } : undefined
        })));
    }

    /**
     * Get auto-set model format for Triton backends with a single format.
     * Returns null if the backend requires user selection (FIL, Python) or
     * doesn't use model formats (vllm, tensorrtllm).
     * Requirements: 3.3, 3.4, 3.5
     * @param {string} architecture - Resolved architecture
     * @param {string} backend - Resolved backend
     * @returns {string|null} Auto-set model format or null
     * @private
     */
    _getTritonAutoModelFormat(architecture, backend) {
        if (architecture !== 'triton') return null

        const meta = tritonBackends[backend]
        if (!meta || !meta.modelFormats) return null

        // Only auto-set if there's exactly one format
        if (meta.modelFormats.length === 1) {
            return meta.modelFormats[0]
        }

        return null
    }

    /**
     * Query MCP region-picker server before infrastructure prompts.
     * Populates configManager.mcpChoices so _runPhase injects them into list prompts.
     * @private
     */
    async _queryMcpForRegion(frameworkAnswers, explicitConfig) {
        const cm = this.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (mcpServers.length === 0) return;

        const smart = this.generator.options.smart === true;

        // Region: query unless explicitly provided via CLI option or config file
        // Note: AWS_REGION env var is treated as a default, not an explicit override,
        // so we only skip when awsRegion was set via --region CLI flag or config file
        const cliRegion = this.generator.options.region;
        const skipRegionQuery = cliRegion !== undefined && cliRegion !== null;

        if (!skipRegionQuery && mcpServers.includes('region-picker')) {
            const { regionSearch } = await this.generator.prompt([{
                type: 'input',
                name: 'regionSearch',
                message: '🔌 Search for a region (e.g. "europe", "us west", "tokyo"):',
                default: ''
            }]);

            if (regionSearch && regionSearch.trim()) {
                console.log(`   🔍 Querying region-picker${smart ? ' [smart]' : ''}...`);
                const result = await cm.queryMcpServer('region-picker', {
                    ...frameworkAnswers,
                    regionSearch: regionSearch.trim()
                });
                if (result && result.choices?.awsRegion?.length > 0) {
                    const choices = result.choices.awsRegion;
                    const preview = choices.length <= 5
                        ? choices.join(', ')
                        : `${choices.slice(0, 5).join(', ')  } (+${choices.length - 5} more)`;
                    console.log(`   ✓ ${choices.length} region(s): [${preview}]`);
                } else {
                    console.log('   ↳ No MCP results, using static list');
                }
            }
        }
    }

    /**
     * Query MCP instance-recommender server after deployment target is known.
     * Only runs when deploymentTarget is managed-inference.
     * Populates configManager.mcpChoices so _runPhase injects them into list prompts.
     * @private
     */
    async _queryMcpForInstance(frameworkAnswers, explicitConfig) {
        const cm = this.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (mcpServers.length === 0) return;

        const smart = this.generator.options.smart === true;

        // Instance type: query if not already provided via CLI/config
        if (!explicitConfig.instanceType && mcpServers.includes('instance-recommender')) {
            const { instanceSearch } = await this.generator.prompt([{
                type: 'input',
                name: 'instanceSearch',
                message: '🔌 Describe your instance needs (e.g. "multi-gpu", "cost-effective cpu"):',
                default: frameworkAnswers.framework || ''
            }]);

            if (instanceSearch && instanceSearch.trim()) {
                console.log(`   🔍 Querying instance-recommender${smart ? ' [smart]' : ''}...`);
                const result = await cm.queryMcpServer('instance-recommender', {
                    ...frameworkAnswers,
                    instanceSearch: instanceSearch.trim()
                });
                if (result && result.choices?.instanceType?.length > 0) {
                    const choices = result.choices.instanceType;
                    const preview = choices.length <= 5
                        ? choices.join(', ')
                        : `${choices.slice(0, 5).join(', ')  } (+${choices.length - 5} more)`;
                    console.log(`   ✓ ${choices.length} instance(s): [${preview}]`);
                } else {
                    console.log('   ↳ No MCP results, using static list');
                }
            }
        }
    }

    /**
     * Query the hyperpod-cluster-picker MCP server for available HyperPod EKS clusters.
     * Populates configManager.mcpChoices.hyperPodCluster so _runPhase injects them into the list prompt.
     * Falls back to manual entry if the MCP server is not configured or fails.
     * Requirements: 12.1, 12.2, 12.3
     * @private
     */
    async _queryMcpForHyperPod(infraAnswers, explicitConfig) {
        const cm = this.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('hyperpod-cluster-picker')) return;

        // Skip if cluster already provided via CLI/config
        if (explicitConfig.hyperPodCluster) return;

        const smart = this.generator.options.smart === true;
        console.log(`   🔍 Querying hyperpod-cluster-picker${smart ? ' [smart]' : ''}...`);

        const result = await cm.queryMcpServer('hyperpod-cluster-picker', {
            ...infraAnswers
        });

        if (result && result.choices?.hyperPodCluster?.length > 0) {
            const choices = result.choices.hyperPodCluster;
            const preview = choices.length <= 5
                ? choices.join(', ')
                : `${choices.slice(0, 5).join(', ')} (+${choices.length - 5} more)`;
            console.log(`   ✓ ${choices.length} cluster(s): [${preview}]`);
        } else {
            // Surface any error message from the MCP server
            if (result?.message) {
                console.log(`   ⚠️  ${result.message}`);
            } else {
                console.log('   ↳ No HyperPod clusters found via MCP, manual entry available');
            }
        }
    }

    /**
     * Query MCP base-image-picker server after deployment config is selected.
     * Populates _mcpBaseImageChoices for the base image selection prompt.
     * Requirements: 5.1, 5.2, 5.3, 5.4, 9.1, 9.2, 9.3
     * @private
     */
    async _queryMcpForBaseImage(frameworkAnswers, explicitConfig) {
        // Skip if base image provided via CLI --base-image flag
        if (this.generator.options['base-image']) return

        const cm = this.configManager
        if (!cm) return

        const mcpServers = cm.getMcpServerNames()
        if (!mcpServers.includes('base-image-picker')) return

        const smart = this.generator.options.smart === true
        const framework = frameworkAnswers.framework
        const modelServer = frameworkAnswers.modelServer
        const architecture = frameworkAnswers.architecture || frameworkAnswers.deploymentConfig?.split('-')[0]
        const isTransformer = framework === 'transformers'
        const isTriton = architecture === 'triton'
        const isDiffusors = architecture === 'diffusors'

        // For non-transformer, non-triton, non-diffusors frameworks, prompt for optional search criteria
        let searchCriteria
        if (!isTransformer && !isTriton && !isDiffusors) {
            const searchAnswer = await this.generator.prompt(baseImageSearchPrompts.map(p => ({
                ...p,
                when: () => true // Always show for non-transformer since we already checked
            })))
            searchCriteria = searchAnswer.baseImageSearch
        }

        console.log(`   🔍 Querying base-image-picker${smart ? ' [smart]' : ''}...`)

        const context = { framework, modelServer, architecture }
        if (searchCriteria && searchCriteria.trim()) {
            context.searchCriteria = searchCriteria.trim()
        }

        const result = await cm.queryMcpServer('base-image-picker', context)

        if (result && result.metadata?.baseImage?.length > 0) {
            const entries = result.metadata.baseImage
            this._mcpBaseImageChoices = formatImageChoices(entries, isTransformer || isTriton || isDiffusors)
            const count = entries.length
            console.log(`   ✓ ${count} base image(s) available`)
        } else {
            console.log('   ↳ No MCP results, using default image')
        }
    }

    /**
     * Query model-picker MCP server catalog for model choices.
     * Reads the architecture-specific catalog (popular-transformers.json or
     * popular-diffusors.json) to populate the model selection prompt.
     * @param {string} [architecture] - Current architecture ('transformers', 'diffusors', etc.)
     * @private
     */
    _queryMcpForModels(architecture) {
        const cm = this.configManager
        if (!cm) return

        const mcpServers = cm.getMcpServerNames()
        if (!mcpServers.includes('model-picker')) return

        try {
            const mcpConfigPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json')
            if (!fs.existsSync(mcpConfigPath)) return

            const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'))
            const serverConfig = mcpConfig.mcpServers?.['model-picker']
            if (!serverConfig?.args?.length) return

            // Resolve the server entry point directory from the args
            const serverEntryPoint = serverConfig.args[serverConfig.args.length - 1]
            const serverDir = path.dirname(serverEntryPoint)

            // Read manifest to find catalog path
            const manifestPath = path.join(serverDir, 'manifest.json')
            if (!fs.existsSync(manifestPath)) return

            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

            // Select catalog based on architecture
            const catalogKey = architecture === 'diffusors'
                ? 'popular-diffusors'
                : 'popular-transformers'
            const catalogRelPath = manifest.catalogs?.[catalogKey]
            if (!catalogRelPath) return

            const catalogPath = path.resolve(serverDir, catalogRelPath)
            if (!fs.existsSync(catalogPath)) return

            const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))

            // Extract model IDs, filtering out glob patterns (entries with *)
            const modelIds = Object.keys(catalog).filter(id => !id.includes('*'))

            if (modelIds.length > 0) {
                this._mcpModelChoices = modelIds
            }
        } catch {
            // Silently fall back to hardcoded defaults
        }
    }

    /**
     * Get framework version choices from registry
     * Requirements: 2.1, 2.6, 8.2, 8.3
     * @private
     */
    _getFrameworkVersionChoices(framework) {
        const registryConfigManager = this.generator.registryConfigManager;
        
        if (!registryConfigManager || !registryConfigManager.frameworkRegistry) {
            return [];
        }
        
        const frameworkVersions = registryConfigManager.frameworkRegistry[framework];
        if (!frameworkVersions || Object.keys(frameworkVersions).length === 0) {
            return [];
        }
        
        // Get available versions and sort them
        const versions = Object.keys(frameworkVersions).sort((a, b) => {
            // Simple version comparison (can be enhanced with semver)
            return b.localeCompare(a, undefined, { numeric: true });
        });
        
        // Create choices with validation level indicators
        return versions.map(version => {
            const config = frameworkVersions[version];
            const validationLevel = config.validationLevel || 'unknown';
            const indicator = {
                'tested': '✅',
                'community-validated': '👥',
                'experimental': '🧪',
                'unknown': '❓'
            }[validationLevel] || '❓';
            
            return {
                name: `${version} ${indicator} (${validationLevel})`,
                value: version,
                short: version
            };
        });
    }

    /**
     * Display framework validation information
     * Requirements: 2.6, 8.2, 8.3
     * @private
     */
    _displayFrameworkValidationInfo(framework, version) {
        const registryConfigManager = this.generator.registryConfigManager;
        
        if (!registryConfigManager || !registryConfigManager.frameworkRegistry) {
            return;
        }
        
        const config = registryConfigManager.frameworkRegistry[framework]?.[version];
        if (!config) {
            return;
        }
        
        console.log('\n📋 Framework Configuration:');
        console.log(`   • Framework: ${framework} ${version}`);
        console.log(`   • Validation Level: ${config.validationLevel || 'unknown'}`);
        console.log('   • Source: Framework_Registry');
        
        if (config.accelerator) {
            console.log(`   • Accelerator: ${config.accelerator.type} ${config.accelerator.version || 'any'}`);
        }
        
        if (config.recommendedInstanceTypes && config.recommendedInstanceTypes.length > 0) {
            console.log(`   • Recommended Instances: ${config.recommendedInstanceTypes.slice(0, 3).join(', ')}`);
        }
        
        if (config.notes) {
            console.log(`   • Notes: ${config.notes}`);
        }
    }

    /**
     * Get framework profile choices from registry
     * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.10
     * @private
     */
    _getFrameworkProfileChoices(framework, version) {
        const registryConfigManager = this.generator.registryConfigManager;
        
        if (!registryConfigManager || !registryConfigManager.frameworkRegistry) {
            return [];
        }
        
        const config = registryConfigManager.frameworkRegistry[framework]?.[version];
        if (!config || !config.profiles || Object.keys(config.profiles).length === 0) {
            return [];
        }
        
        // Create choices from profiles
        const choices = Object.entries(config.profiles).map(([profileName, profileConfig]) => {
            return {
                name: `${profileConfig.displayName || profileName} - ${profileConfig.description || 'No description'}`,
                value: profileName,
                short: profileConfig.displayName || profileName
            };
        });
        
        // Add "default" option to skip profile selection
        choices.unshift({
            name: 'Default (no profile)',
            value: null,
            short: 'Default'
        });
        
        return choices;
    }

    /**
     * Get model profile choices from registry
     * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.10
     * @private
     */
    _getModelProfileChoices(modelId) {
        const registryConfigManager = this.generator.registryConfigManager;
        
        if (!registryConfigManager || !registryConfigManager.modelRegistry || !modelId) {
            return [];
        }
        
        // Try to find model in registry (exact match or pattern match)
        let modelConfig = registryConfigManager.modelRegistry[modelId];
        
        // If no exact match, try pattern matching
        if (!modelConfig) {
            for (const [pattern, config] of Object.entries(registryConfigManager.modelRegistry)) {
                if (pattern.includes('*')) {
                    const regex = new RegExp(`^${  pattern.replace(/\*/g, '.*')  }$`);
                    if (regex.test(modelId)) {
                        modelConfig = config;
                        break;
                    }
                }
            }
        }
        
        if (!modelConfig || !modelConfig.profiles || Object.keys(modelConfig.profiles).length === 0) {
            return [];
        }
        
        // Create choices from profiles
        const choices = Object.entries(modelConfig.profiles).map(([profileName, profileConfig]) => {
            return {
                name: `${profileConfig.displayName || profileName} - ${profileConfig.description || 'No description'}`,
                value: profileName,
                short: profileConfig.displayName || profileName
            };
        });
        
        // Add "default" option to skip profile selection
        choices.unshift({
            name: 'Default (no profile)',
            value: null,
            short: 'Default'
        });
        
        return choices;
    }

    /**
     * Fetch and display model information from HuggingFace API and Model Registry
     * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.11, 11.1, 11.2, 11.3, 11.5, 11.6, 11.7
     * @private
     */
    async _fetchAndDisplayModelInfo(modelId) {
            console.log(`\n   🔍 Querying model-picker [discover]...`);

            const sources = [];
            let chatTemplate = null;
            let modelFamily = null;
            let mcpUsed = false;

            // Try model-picker MCP server in discover mode (queries HuggingFace + merges with catalog)
            const cm = this.configManager;
            if (cm) {
                const mcpServers = cm.getMcpServerNames();
                if (mcpServers.includes('model-picker')) {
                    try {
                        const mcpConfigPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
                        if (fs.existsSync(mcpConfigPath)) {
                            const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
                            const serverConfig = mcpConfig.mcpServers?.['model-picker'];
                            if (serverConfig) {
                                const { McpClient } = await import('./mcp-client.js');
                                const client = new McpClient(serverConfig, { timeout: 15000 });

                                // Override _buildContext to pass model_id and mode directly
                                client._getUnboundedParameterNames = () => [];
                                client._buildContext = () => ({});

                                // Connect and call get_models directly
                                const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
                                const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

                                const transport = new StdioClientTransport({
                                    command: serverConfig.command,
                                    args: serverConfig.args || [],
                                    env: { ...process.env, ...(serverConfig.env || {}) },
                                    stderr: 'pipe'
                                });

                                const mcpClient = new Client(
                                    { name: 'ml-container-creator', version: '1.0.0' },
                                    { capabilities: {} }
                                );

                                await mcpClient.connect(transport);

                                const result = await mcpClient.callTool({
                                    name: 'get_models',
                                    arguments: { model_id: modelId, mode: 'discover' }
                                });

                                await mcpClient.close();

                                // Parse the response
                                const textBlock = result?.content?.find(b => b.type === 'text');
                                if (textBlock) {
                                    const parsed = JSON.parse(textBlock.text);
                                    if (parsed.values && Object.keys(parsed.values).length > 0) {
                                        mcpUsed = true;
                                        const vals = parsed.values;

                                        if (vals.chat_template) {
                                            chatTemplate = vals.chat_template;
                                        }
                                        if (vals.family) {
                                            modelFamily = vals.family;
                                        }

                                        // Determine sources based on what was returned
                                        if (vals.tags || vals.pipeline_tag) {
                                            sources.push('HuggingFace_Hub_API');
                                        }
                                        if (vals.validation_level || vals.framework_compatibility) {
                                            sources.push('Model_Picker_Catalog');
                                        }
                                        if (sources.length === 0) {
                                            sources.push('model-picker');
                                        }
                                        console.log(`   ✓ Resolved: ${modelId}`);
                                    } else if (parsed.message) {
                                        console.log(`   ↳ ${parsed.message}`);
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.log('   ↳ model-picker unavailable, using fallback');
                    }
                }
            }

            // Fallback to legacy path if MCP didn't resolve
            if (!mcpUsed) {
                const registryConfigManager = this.generator.registryConfigManager;
                if (registryConfigManager) {
                    // Try HuggingFace API directly
                    try {
                        const hfData = await registryConfigManager._fetchHuggingFaceData(modelId);
                        if (hfData) {
                            sources.push('HuggingFace_Hub_API');
                            if (hfData.chatTemplate) {
                                chatTemplate = hfData.chatTemplate;
                            }
                            console.log('   ✅ Found on HuggingFace Hub');
                        } else {
                            console.log('   ℹ️  Not found on HuggingFace Hub (may be private or offline)');
                        }
                    } catch (error) {
                        console.log('   ⚠️  HuggingFace API unavailable');
                    }

                    // Check Model Registry for overrides
                    if (registryConfigManager.modelRegistry) {
                        let modelConfig = registryConfigManager.modelRegistry[modelId];

                        if (!modelConfig) {
                            for (const [pattern, config] of Object.entries(registryConfigManager.modelRegistry)) {
                                if (pattern.includes('*')) {
                                    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
                                    if (regex.test(modelId)) {
                                        modelConfig = config;
                                        console.log(`   ✅ Matched pattern in Model_Registry: ${pattern}`);
                                        break;
                                    }
                                }
                            }
                        } else {
                            console.log('   ✅ Found in Model_Registry');
                        }

                        if (modelConfig) {
                            sources.push('Model_Registry');
                            if (modelConfig.chatTemplate) {
                                chatTemplate = modelConfig.chatTemplate;
                            }
                            if (modelConfig.family) {
                                modelFamily = modelConfig.family;
                            }
                        }
                    }
                }
            }

            // Display information
            if (sources.length > 0) {
                console.log('\n📋 Model Information:');
                console.log(`   • Model ID: ${modelId}`);
                if (modelFamily) {
                    console.log(`   • Family: ${modelFamily}`);
                }
                if (chatTemplate) {
                    console.log('   • Chat Template: ✅ Available');
                    console.log('     (Will be injected into generated files)');
                } else {
                    console.log('   • Chat Template: ❌ Not available');
                    console.log('     (Chat endpoints may require manual configuration)');
                }
                console.log(`   • Sources: ${sources.join(', ')}`);
            } else {
                console.log('   ℹ️  No additional model information available');
                console.log('   Proceeding with default configuration');
            }
        }



    /**
     * Validate and display instance type compatibility
     * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
     * @private
     */
    async _validateAndDisplayInstanceType(instanceType, framework, version) {
        const registryConfigManager = this.generator.registryConfigManager;
        
        if (!registryConfigManager) {
            return;
        }
        
        // Get framework configuration
        const frameworkConfig = registryConfigManager.frameworkRegistry?.[framework]?.[version];
        if (!frameworkConfig) {
            return; // No framework config, skip validation
        }
        
        console.log(`\n🔍 Validating instance type: ${instanceType}`);
        
        // Validate instance type
        const validationResult = registryConfigManager.validateInstanceType(instanceType, frameworkConfig);
        
        if (validationResult.compatible) {
            console.log('   ✅ Instance type is compatible');
            if (validationResult.info) {
                console.log(`   ℹ️  ${validationResult.info}`);
            }
        } else {
            console.log('   ❌ Instance type compatibility issue detected');
            if (validationResult.error) {
                console.log(`   Error: ${validationResult.error}`);
            }
            if (validationResult.recommendations && validationResult.recommendations.length > 0) {
                console.log(`   💡 Recommended instances: ${validationResult.recommendations.join(', ')}`);
            }
            
            // In test mode or non-interactive mode, throw error instead of prompting
            if (this.generator.options.skipPrompts || process.env.NODE_ENV === 'test') {
                throw new Error('Instance type validation failed. Please select a compatible instance type.');
            }
            
            // Ask user if they want to proceed
            const proceed = await this.generator.prompt([{
                type: 'confirm',
                name: 'proceedWithIncompatible',
                message: 'Instance type may not be compatible. Proceed anyway?',
                default: false
            }]);
            
            if (!proceed.proceedWithIncompatible) {
                throw new Error('Instance type validation failed. Please select a compatible instance type.');
            }
        }
        
        if (validationResult.warning) {
            console.log(`   ⚠️  Warning: ${validationResult.warning}`);
        }
    }

    /**
     * CUDA-to-AMI mapping.
     * Maps CUDA major.minor versions to the SageMaker inference AMI that provides
     * the matching CUDA driver. Derived from the framework registry patterns.
     * @private
     */
    static CUDA_AMI_MAP = {
        '11.0': 'al2-ami-sagemaker-inference-gpu-2-1',
        '11.4': 'al2-ami-sagemaker-inference-gpu-2-1',
        '11.8': 'al2-ami-sagemaker-inference-gpu-3-1',
        '12.1': 'al2-ami-sagemaker-inference-gpu-3-1',
        '12.2': 'al2-ami-sagemaker-inference-gpu-3-2',
        '12.4': 'al2-ami-sagemaker-inference-gpu-3-2',
        '12.6': 'al2-ami-sagemaker-inference-gpu-3-2'
    };

    /**
     * Prompt the user to select a CUDA version when the selected GPU instance
     * supports multiple versions. The choice transparently resolves to the
     * correct SageMaker inference AMI.
     *
     * Skipped for CPU instances, non-CUDA accelerators, or when only one
     * compatible CUDA version exists.
     *
     * @param {string} instanceType - Selected instance type (e.g. "ml.g5.2xlarge")
     * @param {string} framework - Selected framework name
     * @param {string} frameworkVersion - Selected framework version
     * @returns {Promise<{cudaVersion: string, inferenceAmiVersion: string}|null>}
     * @private
     */
    async _promptCudaVersion(instanceType, framework, frameworkVersion) {
        if (!instanceType) return null;

        // Look up instance in accelerator mapping
        const instanceInfo = instanceAcceleratorMapping[instanceType];
        if (!instanceInfo || instanceInfo.accelerator.type !== 'cuda') return null;

        const instanceCudaVersions = instanceInfo.accelerator.versions;
        if (!instanceCudaVersions || instanceCudaVersions.length === 0) return null;

        // Get framework CUDA requirements (if available)
        const registryConfigManager = this.generator.registryConfigManager;
        const frameworkConfig = registryConfigManager?.frameworkRegistry?.[framework]?.[frameworkVersion];
        const frameworkAccel = frameworkConfig?.accelerator;

        // Compute compatible CUDA versions: intersection of instance support and framework range
        let compatibleVersions;
        if (frameworkAccel?.versionRange) {
            const { min, max } = frameworkAccel.versionRange;
            compatibleVersions = instanceCudaVersions.filter(v => {
                return v >= min && v <= max;
            });
        } else {
            compatibleVersions = [...instanceCudaVersions];
        }

        if (compatibleVersions.length === 0) {
            // No overlap — fall back to all instance versions (validation already warned)
            compatibleVersions = [...instanceCudaVersions];
        }

        // If only one option, auto-select it silently
        if (compatibleVersions.length === 1) {
            const cudaVersion = compatibleVersions[0];
            const inferenceAmiVersion = PromptRunner.CUDA_AMI_MAP[cudaVersion];
            if (inferenceAmiVersion) {
                console.log(`\n🔧 CUDA ${cudaVersion} auto-selected (only compatible version for ${instanceType})`);
                console.log(`   AMI: ${inferenceAmiVersion}`);
            }
            return inferenceAmiVersion ? { cudaVersion, inferenceAmiVersion } : null;
        }

        // Multiple options — let the user choose
        const defaultVersion = frameworkAccel?.version
            && compatibleVersions.includes(frameworkAccel.version)
            ? frameworkAccel.version
            : instanceInfo.accelerator.default || compatibleVersions[compatibleVersions.length - 1];

        const choices = compatibleVersions.map(v => {
            const ami = PromptRunner.CUDA_AMI_MAP[v] || 'unknown';
            const isDefault = v === defaultVersion ? ' (recommended)' : '';
            return {
                name: `CUDA ${v}${isDefault}  →  AMI: ${ami}`,
                value: v,
                short: `CUDA ${v}`
            };
        });

        const { cudaVersion } = await this.generator.prompt([{
            type: 'list',
            name: 'cudaVersion',
            message: `Select CUDA version for ${instanceType} (${instanceInfo.accelerator.hardware}):`,
            choices,
            default: defaultVersion
        }]);

        const inferenceAmiVersion = PromptRunner.CUDA_AMI_MAP[cudaVersion];
        if (inferenceAmiVersion) {
            console.log(`   ✅ CUDA ${cudaVersion} → AMI: ${inferenceAmiVersion}`);
        }

        return inferenceAmiVersion ? { cudaVersion, inferenceAmiVersion } : null;
    }
}


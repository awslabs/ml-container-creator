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
    modelLoadStrategyPrompts,
    modelProfilePrompts,
    modulePrompts,
    loraPrompts,
    benchmarkPrompts,
    infraRegionAndTargetPrompts,
    infraExistingEndpointPrompts,
    infraInstancePrompts,
    infraAsyncPrompts,
    infraBatchTransformPrompts,
    infraHyperPodPrompts,
    infraBuildPrompts,
    projectPrompts,
    destinationPrompts,
    baseImagePrompts,
    filterByCudaGeneration,
    instanceCatalogRaw
} from './prompts/index.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import RegistryLoader from './registry-loader.js';
import { runPrompts } from '../prompt-adapter.js';
import McpQueryRunner from './mcp-query-runner.js';
import SecretsPromptRunner from './secrets-prompt-runner.js';
import CudaResolver from './cuda-resolver.js';
import MarketplaceFlow from './marketplace-flow.js';

const __pr_filename = fileURLToPath(import.meta.url);
const __pr_dirname = path.dirname(__pr_filename);
const GENERATOR_ROOT = path.resolve(__pr_dirname, '..', '..');


export default class PromptRunner {
    constructor({ configManager, options, registryConfigManager, baseConfig, promptFn }) {
        this.configManager = configManager;
        this.options = options || {};
        this.registryConfigManager = registryConfigManager || null;
        this.baseConfig = baseConfig || {};
        this._runPrompts = promptFn || runPrompts;
        this.mcpQueryRunner = new McpQueryRunner(this);
        this.secretsPromptRunner = new SecretsPromptRunner(this);
        this.cudaResolver = new CudaResolver(this);
        this.marketplaceFlow = new MarketplaceFlow(this);
    }

    // ── Sub-object delegations (backward compat for tests) ──────────

    _queryMcpForBaseImage(...args) { return this.mcpQueryRunner._queryMcpForBaseImage(...args); }
    _queryMcpForModels(...args) { return this.mcpQueryRunner._queryMcpForModels(...args); }
    _queryMcpForRegion(...args) { return this.mcpQueryRunner._queryMcpForRegion(...args); }
    _queryMcpForInstance(...args) { return this.mcpQueryRunner._queryMcpForInstance(...args); }
    _queryMcpForInstanceSizing(...args) { return this.mcpQueryRunner._queryMcpForInstanceSizing(...args); }
    _queryMcpForEndpoints(...args) { return this.mcpQueryRunner._queryMcpForEndpoints(...args); }
    _queryMcpForHyperPod(...args) { return this.mcpQueryRunner._queryMcpForHyperPod(...args); }
    _fetchAndDisplayModelInfo(...args) { return this.mcpQueryRunner._fetchAndDisplayModelInfo(...args); }
    _validateAndDisplayInstanceType(...args) { return this.mcpQueryRunner._validateAndDisplayInstanceType(...args); }
    _runSecretPrompts(...args) { return this.secretsPromptRunner._runSecretPrompts(...args); }
    _secretStagesApply(...args) { return this.secretsPromptRunner._secretStagesApply(...args); }
    _getArnConfigKey(...args) { return this.secretsPromptRunner._getArnConfigKey(...args); }
    _getPlaintextConfigKey(...args) { return this.secretsPromptRunner._getPlaintextConfigKey(...args); }
    _promptSecretSelection(...args) { return this.secretsPromptRunner._promptSecretSelection(...args); }
    _promptPlaintextEntry(...args) { return this.secretsPromptRunner._promptPlaintextEntry(...args); }
    _promptPlaintextFallback(...args) { return this.secretsPromptRunner._promptPlaintextFallback(...args); }
    _promptCudaVersion(...args) { return this.cudaResolver._promptCudaVersion(...args); }

    /**
     * Runs all prompting phases and returns combined answers
     * 
     * Phase ordering (MCP Catalog Consolidation):
     *   Phase 1 (What): deployment config + model name/ID + quantization
     *   Phase 2 (How): deployment target + serving profile + base image
     *   Phase 3 (Where): region + instance-sizer query + instance type + CUDA/AMI auto-resolution + HyperPod + build target
     *   Phase 4 (Details): framework version, model profile, modules
     *   Phase 5 (Project): project name + destination
     *
     * @returns {Promise<Object>} Combined answers from all phases
     */
    async run() {
        const buildTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        // Load catalog data via Registry_Loader
        const registryLoader = new RegistryLoader();
        this._tritonBackends = await registryLoader.loadTritonBackends();
        this._instanceAcceleratorMapping = await registryLoader.loadInstanceAcceleratorMapping();

        // Get existing configuration to use as defaults
        const existingConfig = this.baseConfig || {};
        
        // Get only explicit configuration (not defaults) for prompt skipping
        const explicitConfig = this.configManager ? this.configManager.getExplicitConfiguration() : {};

        // ══════════════════════════════════════════════════════════════════════
        // Phase 1 — What (deployment config + model name/ID + quantization)
        // Requirements: 4.1, 4.2 — model selection drives instance sizing
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n🔧 Core ML Configuration');
        const deploymentConfigAnswers = await this._runPhase(deploymentConfigPrompts, {}, explicitConfig, existingConfig);
        
        // Derive architecture, backend, and legacy framework/modelServer from deploymentConfig
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

        // ──────────────────────────────────────────────────────────────────────
        // Marketplace fast-path: skip all container-related prompts
        // Requirements: 2.3, 2.4, 2.5
        // ──────────────────────────────────────────────────────────────────────
        if (frameworkAnswers.architecture === 'marketplace') {
            return this.marketplaceFlow._runMarketplaceFlow(frameworkAnswers, explicitConfig, existingConfig, buildTimestamp);
        }
        
        // Engine prompt for http architecture
        const engineAnswers = await this._runPhase(enginePrompts, { ...frameworkAnswers }, explicitConfig, existingConfig);
        
        // Auto-set model format for Triton backends with single format
        const tritonAutoFormat = this._getTritonAutoModelFormat(architecture, backend);
        
        // Query model-picker MCP server for model choices
        this.mcpQueryRunner._queryMcpForModels(frameworkAnswers.architecture);
        if (this._mcpModelChoices) {
            console.log('   🔍 Querying model-picker...');
            console.log(`   ✓ ${this._mcpModelChoices.length} model(s) available from catalog`);
        }
        const modelFormatPreviousAnswers = {
            ...frameworkAnswers,
            ...engineAnswers,
            ...(this._mcpModelChoices ? { _mcpModelChoices: this._mcpModelChoices } : {})
        };
        const modelFormatAnswers = await this._runPhase(
            modelFormatPrompts, 
            modelFormatPreviousAnswers, 
            explicitConfig, 
            existingConfig
        );
        
        // Model server prompts are now deprecated (empty array)
        const modelServerAnswers = await this._runPhase(
            modelServerPrompts, 
            {...frameworkAnswers, ...engineAnswers}, 
            explicitConfig, 
            existingConfig
        );

        // Resolve model ID early for instance-sizer query in Phase 3
        const phase1ModelId = modelFormatAnswers.customModelName || modelFormatAnswers.modelName || explicitConfig.modelName;
        
        // Fetch model information from HuggingFace and Model Registry
        if (phase1ModelId && phase1ModelId !== 'Custom (enter manually)') {
            await this.mcpQueryRunner._fetchAndDisplayModelInfo(phase1ModelId);
        }

        // ══════════════════════════════════════════════════════════════════════
        // Phase 2 — How (deployment target + serving profile + base image)
        // Requirements: 4.3 — instance prompt appears AFTER base image is known
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n💪 Infrastructure & Deployment');

        // 2a. Deployment target (realtime, async, batch, hyperpod, local)
        const bootstrapRegion = existingConfig.awsRegion || explicitConfig.awsRegion;
        const regionPreviousAnswers = bootstrapRegion ? { _bootstrapRegion: bootstrapRegion } : {};
        const regionAndTargetAnswers = await this._runPhase(infraRegionAndTargetPrompts, { ...frameworkAnswers, ...regionPreviousAnswers }, explicitConfig, existingConfig);

        // 2b. Query base-image-picker MCP server for base image choices
        await this.mcpQueryRunner._queryMcpForBaseImage(frameworkAnswers, explicitConfig);
        const baseImagePreviousAnswers = {
            ...frameworkAnswers,
            ...engineAnswers,
            ...(this._mcpBaseImageChoices ? { _mcpBaseImageChoices: this._mcpBaseImageChoices } : {})
        };
        const baseImageAnswers = await this._runPhase(
            baseImagePrompts,
            baseImagePreviousAnswers,
            explicitConfig,
            existingConfig
        );

        // Requirements: 4.2-4.5 — Check model architecture compatibility after base image selection
        this._checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers);

        // Extract CUDA version from selected base image for instance-sizer context
        const selectedBaseImageCuda = this._extractCudaFromBaseImage(baseImageAnswers);

        // ══════════════════════════════════════════════════════════════════════
        // Phase 3 — Where (region + instance [derived] + CUDA/AMI + HyperPod + build target)
        // Requirements: 4.4, 4.5, 4.7, 3.6, 3.7 — sizer query with full context
        // ══════════════════════════════════════════════════════════════════════

        // 3a. Region query
        await this.mcpQueryRunner._queryMcpForRegion(frameworkAnswers, explicitConfig);

        // 3a2. Existing endpoint prompt (only for realtime-inference)
        // Requirements: 3.3, 4.3, 4.4 — endpoint-picker MCP query
        let existingEndpointAnswers = {};
        if (regionAndTargetAnswers.deploymentTarget === 'realtime-inference') {
            // Query endpoint-picker MCP server for available endpoints
            const resolvedRegion = regionAndTargetAnswers.customAwsRegion || regionAndTargetAnswers.awsRegion;
            await this.mcpQueryRunner._queryMcpForEndpoints({ ...regionAndTargetAnswers, awsRegion: resolvedRegion }, explicitConfig);

            const endpointPreviousAnswers = {
                ...regionAndTargetAnswers,
                ...(this._mcpEndpointChoices ? { _mcpEndpointChoices: this._mcpEndpointChoices } : {})
            };
            existingEndpointAnswers = await this._runPhase(
                infraExistingEndpointPrompts,
                endpointPreviousAnswers,
                explicitConfig,
                existingConfig
            );

            // Resolve custom endpoint name
            if (existingEndpointAnswers.customExistingEndpointName) {
                existingEndpointAnswers.existingEndpointName = existingEndpointAnswers.customExistingEndpointName;
                delete existingEndpointAnswers.customExistingEndpointName;
            }
        }

        // 3b. Instance type — query instance-sizer with full context (model + profile + CUDA)
        let instanceAnswers = {};
        // Skip instance prompts when attaching to an existing endpoint (instance is inherited)
        const useExistingEndpoint = !!(existingEndpointAnswers.existingEndpointName);
        const needsInstance = !useExistingEndpoint && (regionAndTargetAnswers.deploymentTarget === 'realtime-inference' ||
            regionAndTargetAnswers.deploymentTarget === 'async-inference' ||
            regionAndTargetAnswers.deploymentTarget === 'batch-transform' ||
            regionAndTargetAnswers.deploymentTarget === 'hyperpod-eks');

        if (needsInstance) {
            // Determine architecture type for heuristic fallback
            const modelArchitecture = frameworkAnswers.architecture || frameworkAnswers.deploymentConfig?.split('-')[0];

            // Skip sizer query if --instance-type was provided via CLI
            if (!explicitConfig.instanceType) {
                // Skip sizer for predictor models (CPU-only)
                if (modelArchitecture === 'predictor' || modelArchitecture === 'http') {
                    // Architecture heuristic: predictor → ml.m5.large
                    console.log('   ℹ️  Predictor model: defaulting to CPU instance (ml.m5.large)');
                    this._architectureHeuristicDefault = 'ml.m5.large';
                } else if (phase1ModelId && phase1ModelId !== 'Custom (enter manually)') {
                    // Query instance-sizer with full context
                    await this.mcpQueryRunner._queryMcpForInstanceSizing(frameworkAnswers, modelFormatAnswers, explicitConfig, {
                        cudaVersion: selectedBaseImageCuda,
                        profileEnvVars: this._selectedProfileEnvVars || {}
                    });
                } else {
                    // No model known — use architecture heuristic
                    await this.mcpQueryRunner._queryMcpForInstance(frameworkAnswers, explicitConfig);
                }
            }

            // Build instance prompt choices from sizer results
            const mcpInstanceChoices = this._mcpInstanceSizerChoices || this.configManager?.mcpChoices?.instanceType;
            const instancePreviousAnswers = {
                ...regionAndTargetAnswers,
                ...(mcpInstanceChoices && mcpInstanceChoices.length > 0 ? { _mcpInstanceChoices: mcpInstanceChoices } : {}),
                ...(this._architectureHeuristicDefault ? { _architectureHeuristicDefault: this._architectureHeuristicDefault } : {})
            };
            instanceAnswers = await this._runPhase(infraInstancePrompts, instancePreviousAnswers, explicitConfig, existingConfig);

            // Apply architecture heuristic fallback when sizer returns empty
            if (!instanceAnswers.instanceType && !explicitConfig.instanceType && this._architectureHeuristicDefault) {
                instanceAnswers.instanceType = this._architectureHeuristicDefault;
            }

            // Process multi-select instance type results (Requirements: 6.4)
            // When user selects multiple instances via checkbox, derive instanceType and instancePools
            if (instanceAnswers.instanceTypeSelections && instanceAnswers.instanceTypeSelections.length > 0) {
                let selections = instanceAnswers.instanceTypeSelections.slice(0, 5); // Cap at 5 (API limit)

                // Resolve custom input: replace __custom_input__ sentinel with parsed instances
                if (selections.includes('__custom_input__') && instanceAnswers.customInstanceTypeSelections) {
                    const customInstances = instanceAnswers.customInstanceTypeSelections
                        .split(',').map(s => s.trim()).filter(s => s.length > 0);
                    // Remove the sentinel and any other MCP selections, replace with custom entries
                    selections = selections.filter(s => s !== '__custom_input__');
                    selections = [...selections, ...customInstances];
                    delete instanceAnswers.customInstanceTypeSelections;
                } else if (selections.includes('__custom_input__')) {
                    // Sentinel selected but no custom input provided — remove it
                    selections = selections.filter(s => s !== '__custom_input__');
                }

                // Cap at 5 after custom expansion
                if (selections.length > 5) {
                    console.log('   ⚠️  Maximum 5 instance types allowed. Using first 5 selections.');
                    selections = selections.slice(0, 5);
                }

                // Filter to same CUDA generation and warn about incompatible removals
                const { filtered, generation, removed } = filterByCudaGeneration(selections);
                if (removed.length > 0) {
                    console.log(`   ⚠️  Removed incompatible instances (different CUDA generation): ${removed.join(', ')}`);
                    console.log(`   Keeping ${generation} generation: ${filtered.join(', ')}`);
                }

                const finalSelections = filtered.length > 0 ? filtered : selections;

                if (finalSelections.length === 1) {
                    // Single selection → standard single instance type (no pools)
                    instanceAnswers.instanceType = finalSelections[0];
                    console.log(`   ✓ Single instance selected: ${finalSelections[0]}`);
                } else {
                    // Multiple selections → instance pools with priority = selection order
                    instanceAnswers.instanceType = finalSelections[0]; // backward compat: first is primary
                    instanceAnswers.instancePools = finalSelections.map((it, idx) => ({
                        InstanceType: it,
                        Priority: idx + 1
                    }));

                    // Auto-generate multi-spec IC config from catalog
                    instanceAnswers.instancePoolSpecs = finalSelections.map(it => {
                        const entry = instanceCatalogRaw[it];
                        return {
                            instanceType: it,
                            gpuCount: entry?.gpus || 1,
                            minMemoryMb: entry?.gpuMemoryGb ? entry.gpuMemoryGb * 1024 : 1024
                        };
                    });

                    console.log(`   ✓ Instance pools configured (${finalSelections.length} types):`);
                    finalSelections.forEach((it, idx) => {
                        const entry = instanceCatalogRaw[it];
                        const gpus = entry?.gpus || '?';
                        const mem = entry?.gpuMemoryGb || '?';
                        console.log(`     Priority ${idx + 1}: ${it} (${gpus} GPUs, ${mem}GB GPU memory)`);
                    });
                }

                // Clean up the raw selections from answers (not needed downstream)
                delete instanceAnswers.instanceTypeSelections;
            }
        }

        // In auto-prompt mode, use instance-sizer's top recommendation as the instance type
        if (this.configManager?.isAutoPrompt() && this._mcpInstanceSizerChoices && this._mcpInstanceSizerChoices.length > 0) {
            const sizerRecommendation = this._mcpInstanceSizerChoices[0];
            if (!explicitConfig.instanceType) {
                instanceAnswers.instanceType = sizerRecommendation;
                console.log(`   ✓ Auto-prompt: using instance-sizer recommendation: ${sizerRecommendation}`);
            }
        }

        // Auto-set tensor parallelism when sizer recommends TP > 1
        // Requirements: 4.8
        if (this._instanceSizerMetadata) {
            const sizerRecs = this._instanceSizerMetadata.recommendations || [];
            const finalInstanceType = instanceAnswers.customInstanceType || instanceAnswers.instanceType;
            const matchingRec = sizerRecs.find(r => r.instanceType === finalInstanceType);
            const tpRec = matchingRec || sizerRecs[0];
            if (tpRec && tpRec.tensorParallelism > 1) {
                this._autoTensorParallelism = tpRec.tensorParallelism;
                this._autoGpuCount = tpRec.gpuCount;
                console.log(`   ✓ Auto-set tensor parallelism: TP=${tpRec.tensorParallelism} (${tpRec.gpuCount} GPUs)`);
            }

            // Display capacity type confirmation for selected instance
            // Requirements: 5.4
            if (matchingRec && matchingRec.capacityType) {
                if (matchingRec.capacityType === 'reserved') {
                    const resType = matchingRec.reservationType === 'capacity-block' ? 'Capacity Block' : 'ODCR';
                    const endInfo = matchingRec.reservationType === 'capacity-block' && matchingRec.reservationInfo?.endDate
                        ? `, ends ${new Date(matchingRec.reservationInfo.endDate).toLocaleDateString()}`
                        : '';
                    console.log(`   ✓ Using reserved capacity — ${resType} (reservation ${matchingRec.reservationInfo?.reservationId || 'unknown'}${endInfo})`);
                } else if (matchingRec.capacityType === 'ftp') {
                    console.log(`   ✓ Using reserved capacity (plan ${matchingRec.ftpInfo?.planName || 'unknown'})`);
                } else {
                    const headroom = matchingRec.quotaHeadroom;
                    console.log(`   ✓ Using on-demand capacity (quota headroom: ${headroom ?? 'unknown'})`);
                }
            }

            // Extract reservation ARN from selected instance for deployment config
            // Requirements: 2.3
            if (matchingRec && matchingRec.capacityType === 'reserved' && matchingRec.reservationInfo?.reservationArn) {
                this._selectedCapacityReservationArn = matchingRec.reservationInfo.reservationArn;
            }
        }

        // 3c. Async-specific prompts (only when deploymentTarget === 'async-inference')
        let asyncAnswers = {};
        if (regionAndTargetAnswers.deploymentTarget === 'async-inference') {
            asyncAnswers = await this._runPhase(infraAsyncPrompts, { ...regionAndTargetAnswers }, explicitConfig, existingConfig);
        }

        // 3d. Batch transform-specific prompts (only when deploymentTarget === 'batch-transform')
        let batchTransformAnswers = {};
        if (regionAndTargetAnswers.deploymentTarget === 'batch-transform') {
            batchTransformAnswers = await this._runPhase(
                infraBatchTransformPrompts,
                { ...regionAndTargetAnswers },
                explicitConfig,
                existingConfig
            );
        }

        // 3e. CUDA/AMI auto-resolution
        const instanceType = instanceAnswers.customInstanceType || instanceAnswers.instanceType;
        const cudaAnswer = await this.cudaResolver._promptCudaVersion(
            instanceType,
            frameworkAnswers.framework,
            null, // frameworkVersion not yet known in Phase 3
            selectedBaseImageCuda // base image CUDA version for intersection
        );

        // 3f. HyperPod prompts — only query MCP and prompt when deployment target is hyperpod-eks
        let hyperPodAnswers = {};
        if (regionAndTargetAnswers.deploymentTarget === 'hyperpod-eks') {
            const resolvedRegion = regionAndTargetAnswers.customAwsRegion || regionAndTargetAnswers.awsRegion;
            await this.mcpQueryRunner._queryMcpForHyperPod({ ...regionAndTargetAnswers, awsRegion: resolvedRegion }, explicitConfig);
            hyperPodAnswers = await this._runPhase(infraHyperPodPrompts, { ...regionAndTargetAnswers }, explicitConfig, existingConfig);
        }

        // 3g. Build target + role ARN (always)
        const buildAnswers = await this._runPhase(infraBuildPrompts, { ...regionAndTargetAnswers, ...instanceAnswers, ...hyperPodAnswers }, explicitConfig, existingConfig);

        // Combine all infrastructure answers
        const infraAnswers = {
            ...regionAndTargetAnswers,
            ...existingEndpointAnswers,
            ...instanceAnswers,
            ...asyncAnswers,
            ...batchTransformAnswers,
            ...hyperPodAnswers,
            ...buildAnswers
        };

        // Apply CUDA resolution to infra answers
        if (cudaAnswer) {
            infraAnswers._selectedCudaVersion = cudaAnswer.cudaVersion;
            infraAnswers._resolvedInferenceAmiVersion = cudaAnswer.inferenceAmiVersion;
        }

        // ══════════════════════════════════════════════════════════════════════
        // Phase 4 — Details (framework version, model profile, modules)
        // ══════════════════════════════════════════════════════════════════════
        console.log('\n📦 Module Selection');

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

        // Populate model profile choices from registry (if model ID is available)
        const modelId = phase1ModelId;
        const currentAnswers = {...frameworkAnswers, ...engineAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers, ...modelFormatAnswers, ...modelServerAnswers};
        
        const modelProfileChoices = this._getModelProfileChoices(modelId);
        const modelProfileAnswers = await this._runPhase(
            modelProfilePrompts,
            {...currentAnswers, _modelProfileChoices: modelProfileChoices},
            explicitConfig,
            existingConfig
        );

        // Model loading strategy prompt (build-time vs runtime)
        const modelLoadStrategyAnswers = await this._runPhase(
            modelLoadStrategyPrompts,
            { ...frameworkAnswers, ...engineAnswers, ...modelFormatAnswers, ...modelServerAnswers, ...modelProfileAnswers },
            explicitConfig,
            existingConfig
        );

        // Secret prompts — registry-driven secret selection (replaces hardcoded hfToken/ngcApiKey prompts)
        const secretPreviousAnswers = { ...frameworkAnswers, ...engineAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers, ...modelFormatAnswers, ...modelServerAnswers, ...modelProfileAnswers };
        const secretAnswers = await this.secretsPromptRunner._runSecretPrompts(secretPreviousAnswers, explicitConfig, existingConfig);
        const hfTokenAnswers = { hfToken: secretAnswers.hfToken, hfTokenArn: secretAnswers.hfTokenArn };
        const ngcApiKeyAnswers = { ngcApiKey: secretAnswers.ngcApiKey, ngcTokenArn: secretAnswers.ngcTokenArn };

        // Module selection
        const moduleAnswers = await this._runPhase(modulePrompts, { ...frameworkAnswers, ...engineAnswers }, explicitConfig, existingConfig);
        
        // Ensure transformers, diffusors, and ineligible Triton backends don't get sample model
        if (frameworkAnswers.architecture === 'transformers' ||
            frameworkAnswers.architecture === 'diffusors' ||
            (frameworkAnswers.architecture === 'triton' && 
             !this._tritonBackends[frameworkAnswers.backend]?.supportsSampleModel)) {
            moduleAnswers.includeSampleModel = false;
        }

        // Benchmark prompts — derive includeBenchmark from testTypes selection or CLI flag
        // Requirements: 1.1, 1.2
        let benchmarkAnswers = {};
        if (frameworkAnswers.architecture === 'transformers' || frameworkAnswers.architecture === 'diffusors') {
            const testTypes = moduleAnswers.testTypes || [];
            const includeBenchmark = testTypes.includes('sagemaker-ai-automated-benchmarking') ||
                explicitConfig.includeBenchmark === true ||
                explicitConfig.includeBenchmark === 'true';
            benchmarkAnswers.includeBenchmark = includeBenchmark;
            if (includeBenchmark) {
                const subAnswers = await this._runPhase(benchmarkPrompts, { ...frameworkAnswers, ...moduleAnswers, includeBenchmark }, explicitConfig, existingConfig);
                benchmarkAnswers = { ...benchmarkAnswers, ...subAnswers };
            }
        }

        // LoRA adapter prompts — only for transformers with vllm/sglang/djl-lmi
        // Requirements: 1.1, 1.2, 1.4
        let loraAnswers = {};
        const loraSubAnswers = await this._runPhase(loraPrompts, { ...frameworkAnswers, ...engineAnswers }, explicitConfig, existingConfig);
        if (loraSubAnswers.enableLora !== undefined) {
            loraAnswers = loraSubAnswers;
        }

        // Validate instance type against framework requirements (now that framework version is known)
        const finalInstanceType = infraAnswers.customInstanceType || infraAnswers.instanceType;
        if (finalInstanceType && frameworkVersionAnswers.frameworkVersion) {
            await this.mcpQueryRunner._validateAndDisplayInstanceType(
                finalInstanceType,
                frameworkAnswers.framework,
                frameworkVersionAnswers.frameworkVersion
            );
        }

        // ══════════════════════════════════════════════════════════════════════
        // Phase 5 — Project (project name + destination)
        // ══════════════════════════════════════════════════════════════════════
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
            ...modelLoadStrategyAnswers,
            ...hfTokenAnswers,
            ...ngcApiKeyAnswers,
            ...moduleAnswers,
            ...benchmarkAnswers,
            ...loraAnswers,
            ...projectAnswers,
            ...destinationAnswers,
            buildTimestamp
        };

        // Ensure CLI-provided values that were skipped during prompting are in combinedAnswers
        if (explicitConfig.modelName && !combinedAnswers.modelName) {
            combinedAnswers.modelName = explicitConfig.modelName;
        }

        // Flow model source metadata from model-picker MCP response
        // Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
        if (this._mcpModelSource) {
            combinedAnswers.modelSource = this._mcpModelSource;
        }
        if (this._mcpArtifactUri) {
            combinedAnswers.artifactUri = this._mcpArtifactUri;
        }

        // Flow capacity reservation ARN from instance-sizer selection
        // Requirements: 2.3
        if (this._selectedCapacityReservationArn) {
            combinedAnswers.capacityReservationArn = this._selectedCapacityReservationArn;
        }

        // Validate: non-HF model sources require an artifact URI
        // Without it, the serve script can't download the model at runtime
        // Infer modelSource from model name prefix if not set by MCP
        const modelName = combinedAnswers.customModelName || combinedAnswers.modelName;
        if (!combinedAnswers.modelSource && modelName) {
            // Reject deprecated JumpStart prefixes with migration message
            if (modelName.startsWith('jumpstart://') || modelName.startsWith('jumpstart-hub://')) {
                const bareId = modelName.replace(/^jumpstart(-hub)?:\/\//, '');
                console.error(`\n   ⚠️  JumpStart is no longer supported. Use the HuggingFace model ID directly: ${bareId}`);
                console.error('   JumpStart model sources have been removed. Use one of:');
                console.error('     • HuggingFace model ID (e.g., meta-llama/Llama-2-7b-hf)');
                console.error('     • s3://bucket/path/model.tar.gz');
                console.error('     • registry://model-package-name');
                console.error('     • marketplace://arn:aws:sagemaker:...\n');
                process.exit(1);
            }
            if (modelName.startsWith('marketplace://')) {
                // marketplace://arn:aws:sagemaker:... → set architecture to marketplace and store ARN
                const arn = modelName.replace(/^marketplace:\/\//, '');
                combinedAnswers.modelPackageArn = arn;
                combinedAnswers.architecture = 'marketplace';
                combinedAnswers.deploymentConfig = 'marketplace';
                combinedAnswers.modelSource = undefined;
            } else if (modelName.startsWith('s3://')) {
                combinedAnswers.modelSource = 's3';
                combinedAnswers.artifactUri = modelName;
            } else if (modelName.startsWith('registry://')) {
                combinedAnswers.modelSource = 'registry';
            }
        }
        // For s3:// models, the model name IS the artifact URI
        if (combinedAnswers.modelSource === 's3' && !combinedAnswers.artifactUri) {
            if (modelName && modelName.startsWith('s3://')) {
                combinedAnswers.artifactUri = modelName;
            }
        }
        const downloadSources = ['s3'];
        if (downloadSources.includes(combinedAnswers.modelSource) && !combinedAnswers.artifactUri) {
            console.log(`\n   ⚠️  Model source is '${combinedAnswers.modelSource}' but no artifact URI was resolved.`);
            console.log('   The model-picker could not determine the download location.');
            console.log('   Falling back to HuggingFace source — the model will be loaded by name.');
            console.log('   If this model requires S3 download, set MODEL_ARTIFACT_URI in do/config after generation.\n');
            combinedAnswers.modelSource = 'huggingface';
        }

        // Registry models — note about InferenceSpecification requirement
        if (combinedAnswers.modelSource === 'registry') {
            if (!combinedAnswers.artifactUri) {
                console.log('\n   ⚠️  Model source is \'registry\' but no artifact URI was resolved.');
                console.log('   The model package must have an InferenceSpecification with a valid');
                console.log('   ModelDataUrl or S3DataSource for the runtime resolver to work.');
                console.log('   If your model package was registered without an InferenceSpecification,');
                console.log('   use the S3 path directly instead: --model-name="s3://bucket/path/model.tar.gz"');
                console.log('   Or set MODEL_ARTIFACT_URI in do/config before deploying.\n');
            } else {
                console.log('\n   ℹ️  Registry model: the container will resolve the artifact URI at startup');
                console.log('   via DescribeModelPackage. Ensure the model package has a valid');
                console.log('   InferenceSpecification with ModelDataUrl or S3DataSource.\n');
            }
        }



        // Apply auto-set model format for Triton backends with single format
        // Requirements: 3.3, 3.4, 3.5
        if (tritonAutoFormat) {
            combinedAnswers.modelFormat = tritonAutoFormat;
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

        // Propagate tensor parallelism from instance-sizer to templates
        // Requirements: 4.8 — auto-set TP when sizer recommends > 1
        if (this._autoTensorParallelism) {
            combinedAnswers.tensorParallelSize = this._autoTensorParallelism;
            combinedAnswers.gpuCount = this._autoGpuCount;
        } else if (this._instanceSizerMetadata) {
            const sizerInstanceType = combinedAnswers.instanceType;
            const sizerRecs = this._instanceSizerMetadata.recommendations || [];
            const matchingRec = sizerRecs.find(r => r.instanceType === sizerInstanceType);
            if (matchingRec && matchingRec.tensorParallelism > 1) {
                combinedAnswers.tensorParallelSize = matchingRec.tensorParallelism;
                combinedAnswers.gpuCount = matchingRec.gpuCount;
            }
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
            combinedAnswers.baseImage = combinedAnswers.customBaseImage;
            combinedAnswers._baseImageSource = 'custom';
            delete combinedAnswers.customBaseImage;
        }

        // Handle --base-image CLI override
        if (this.options['base-image']) {
            combinedAnswers.baseImage = this.options['base-image'];
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
        
        // Collect explicit values for prompts that will be skipped.
        // When a prompt is skipped because its value is in explicitConfig,
        // the prompt library won't include it in the returned answers.
        // Downstream code expects the value to be present, so we inject it.
        const skippedValues = {};
        for (const prompt of promptablePrompts) {
            if (explicitConfig[prompt.name] !== undefined && explicitConfig[prompt.name] !== null) {
                skippedValues[prompt.name] = explicitConfig[prompt.name];
            }
        }

        const promptedAnswers = await this._runPrompts(promptablePrompts.map(prompt => ({
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
            // In auto-prompt mode, also skip optional prompts (not required in parameter matrix)
            when: prompt.when ? (answers) => {
                // Skip if we have the value from explicit config (CLI, env vars, config files)
                if (explicitConfig[prompt.name] !== undefined && explicitConfig[prompt.name] !== null) {
                    return false;
                }
                // In auto-prompt mode, skip optional/non-matrix parameters entirely
                if (this.configManager?.isAutoPrompt()) {
                    const paramConfig = this.configManager.parameterMatrix[prompt.name];
                    // Skip if not in matrix (supplementary prompt) or if optional
                    if (!paramConfig || !paramConfig.required) {
                        return false;
                    }
                }
                return prompt.when({...allPreviousAnswers, ...answers});
            } : (_answers) => {
                // No original when condition — skip if explicit or if auto-prompt + optional/non-matrix
                if (explicitConfig[prompt.name] !== undefined && explicitConfig[prompt.name] !== null) {
                    return false;
                }
                if (this.configManager?.isAutoPrompt()) {
                    const paramConfig = this.configManager.parameterMatrix[prompt.name];
                    if (!paramConfig || !paramConfig.required) {
                        return false;
                    }
                }
                return true;
            },
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

        // Merge skipped explicit values into the answers so downstream code sees them
        return { ...skippedValues, ...promptedAnswers };
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
        if (architecture !== 'triton') return null;

        const meta = this._tritonBackends[backend];
        if (!meta || !meta.modelFormats) return null;

        // Only auto-set if there's exactly one format
        if (meta.modelFormats.length === 1) {
            return meta.modelFormats[0];
        }

        return null;
    }

    /**
     * Extract CUDA version from the selected base image.
     * Looks at the MCP base image metadata for accelerator.version or labels.cuda_version.
     * @param {object} baseImageAnswers - Answers from the base image prompt
     * @returns {string|null} CUDA version string (e.g., "12.1") or null
     * @private
     */
    _extractCudaFromBaseImage(baseImageAnswers) {
        if (!this._mcpBaseImageChoices) return null;

        const selectedImage = baseImageAnswers.baseImage || baseImageAnswers.customBaseImage;
        if (!selectedImage) return null;

        // Find the matching entry in the MCP choices
        const matchingChoice = this._mcpBaseImageChoices.find(c => c.value === selectedImage);
        if (!matchingChoice) return null;

        // Try to extract CUDA version from the choice metadata
        // The formatImageChoices function stores labels in the choice object
        if (matchingChoice._meta?.labels?.cuda_version) {
            return matchingChoice._meta.labels.cuda_version;
        }
        if (matchingChoice._meta?.accelerator?.version) {
            return matchingChoice._meta.accelerator.version;
        }

        return null;
    }

    /**
     * Check model architecture compatibility against the selected base image.
     * Emits an advisory warning if the model's model_type is not in the server's
     * supportedModelTypes. Skips silently if supportedModelTypes is empty (sync not run).
     * Requirements: 4.2, 4.3, 4.4, 4.5
     * @param {Object} baseImageAnswers - Answers from base image selection phase
     * @param {Object} frameworkAnswers - Answers from framework/deployment config phase
     * @private
     */
    _checkModelArchitectureCompatibility(baseImageAnswers, frameworkAnswers) {
        // Requirement 4.5: skip if no model_type was resolved
        if (!this._modelType) return;

        // Determine the selected image
        const selectedImage = baseImageAnswers.baseImage || baseImageAnswers.customBaseImage;
        if (!selectedImage || selectedImage === 'custom') return;

        // Resolve the matching choice from MCP base image choices
        if (!this._mcpBaseImageChoices) return;
        const matchingChoice = this._mcpBaseImageChoices.find(c => c.value === selectedImage);
        if (!matchingChoice) return;

        // Determine the server name from framework answers
        const server = frameworkAnswers.modelServer || frameworkAnswers.backend;
        if (!server) return;

        // Load the model-servers catalog to find the entry with supportedModelTypes
        try {
            const catalogPath = path.resolve(GENERATOR_ROOT, 'servers', 'lib', 'catalogs', 'model-servers.json');
            const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

            const serverEntries = catalog[server];
            if (!Array.isArray(serverEntries)) return;

            // Find the catalog entry matching the selected image
            const entry = serverEntries.find(e => e.image === selectedImage);
            if (!entry) return;

            const supported = entry.supportedModelTypes;
            // Requirement 4.5: skip silently when supportedModelTypes is empty (sync not run)
            if (!supported || supported.length === 0) return;

            // Requirement 4.2-4.3: cross-reference model_type (case-insensitive)
            const modelTypeLower = this._modelType.toLowerCase();
            if (!supported.includes(modelTypeLower)) {
                const version = entry.labels?.framework_version || entry.tag || 'unknown';
                const docsUrls = {
                    vllm: 'https://docs.vllm.ai/en/latest/models/supported_models.html',
                    sglang: 'https://sgl-project.github.io/references/supported_models.html',
                    'tensorrt-llm': 'https://nvidia.github.io/TensorRT-LLM/reference/support-matrix.html'
                };
                const docsUrl = docsUrls[server] || `https://github.com/search?q=${server}+supported+models`;

                // Requirement 4.3-4.4: emit advisory warning (does not block generation)
                console.log(`\n   ⚠️  Model architecture "${this._modelType}" may not be supported by ${server} ${version}`);
                console.log('      Consider upgrading to a newer base image, or verify compatibility at:');
                console.log(`      ${docsUrl}`);
            }
        } catch (err) {
            // Graceful degradation: if catalog can't be read, skip silently
        }
    }

    /**
     * Get architecture-based heuristic default instance type.
     * Used when the instance-sizer cannot produce a recommendation.
     * Requirements: 3.9, 4.6
     * @param {string} architecture - Model architecture type
     * @returns {string} Default instance type
     * @private
     */
    _getArchitectureHeuristicDefault(architecture) {
        const HEURISTIC_DEFAULTS = {
            'transformers': 'ml.g5.xlarge',
            'transformer': 'ml.g5.xlarge',
            'diffusors': 'ml.g5.2xlarge',
            'diffusor': 'ml.g5.2xlarge',
            'predictor': 'ml.m5.large',
            'http': 'ml.m5.large'
        };
        return Object.hasOwn(HEURISTIC_DEFAULTS, architecture) ? HEURISTIC_DEFAULTS[architecture] : 'ml.g5.xlarge';
    }

    /**
     * Get framework version choices from registry
     * Requirements: 2.1, 2.6, 8.2, 8.3
     * @private
     */
    _getFrameworkVersionChoices(framework) {
        const registryConfigManager = this.registryConfigManager;
        
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
        const registryConfigManager = this.registryConfigManager;
        
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
        const registryConfigManager = this.registryConfigManager;
        
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
        const registryConfigManager = this.registryConfigManager;
        
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


}


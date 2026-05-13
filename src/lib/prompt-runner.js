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
    benchmarkPrompts,
    infraRegionAndTargetPrompts,
    infraInstancePrompts,
    infraAsyncPrompts,
    infraBatchTransformPrompts,
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
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import RegistryLoader from './registry-loader.js';
import { runPrompts } from '../prompt-adapter.js';
import { SECRET_CLASSIFICATIONS } from './secret-classification.js';
import { isSecretsManagerArn } from './arn-detection.js';
import BootstrapConfig from './bootstrap-config.js';

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
    }

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
        
        // Engine prompt for http architecture
        const engineAnswers = await this._runPhase(enginePrompts, { ...frameworkAnswers }, explicitConfig, existingConfig);
        
        // Auto-set model format for Triton backends with single format
        const tritonAutoFormat = this._getTritonAutoModelFormat(architecture, backend);
        
        // Query model-picker MCP server for model choices
        this._queryMcpForModels(frameworkAnswers.architecture);
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
            await this._fetchAndDisplayModelInfo(phase1ModelId);
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
        await this._queryMcpForBaseImage(frameworkAnswers, explicitConfig);
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
        await this._queryMcpForRegion(frameworkAnswers, explicitConfig);

        // 3b. Instance type — query instance-sizer with full context (model + profile + CUDA)
        let instanceAnswers = {};
        const needsInstance = regionAndTargetAnswers.deploymentTarget === 'realtime-inference' ||
            regionAndTargetAnswers.deploymentTarget === 'async-inference' ||
            regionAndTargetAnswers.deploymentTarget === 'batch-transform' ||
            regionAndTargetAnswers.deploymentTarget === 'hyperpod-eks';

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
                    await this._queryMcpForInstanceSizing(frameworkAnswers, modelFormatAnswers, explicitConfig, {
                        cudaVersion: selectedBaseImageCuda,
                        profileEnvVars: this._selectedProfileEnvVars || {}
                    });
                } else {
                    // No model known — use architecture heuristic
                    await this._queryMcpForInstance(frameworkAnswers, explicitConfig);
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
        const cudaAnswer = await this._promptCudaVersion(
            instanceType,
            frameworkAnswers.framework,
            null, // frameworkVersion not yet known in Phase 3
            selectedBaseImageCuda // base image CUDA version for intersection
        );

        // 3f. HyperPod prompts — only query MCP and prompt when deployment target is hyperpod-eks
        let hyperPodAnswers = {};
        if (regionAndTargetAnswers.deploymentTarget === 'hyperpod-eks') {
            const resolvedRegion = regionAndTargetAnswers.customAwsRegion || regionAndTargetAnswers.awsRegion;
            await this._queryMcpForHyperPod({ ...regionAndTargetAnswers, awsRegion: resolvedRegion }, explicitConfig);
            hyperPodAnswers = await this._runPhase(infraHyperPodPrompts, { ...regionAndTargetAnswers }, explicitConfig, existingConfig);
        }

        // 3g. Build target + role ARN (always)
        const buildAnswers = await this._runPhase(infraBuildPrompts, { ...regionAndTargetAnswers, ...instanceAnswers, ...hyperPodAnswers }, explicitConfig, existingConfig);

        // Combine all infrastructure answers
        const infraAnswers = {
            ...regionAndTargetAnswers,
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
        const secretAnswers = await this._runSecretPrompts(secretPreviousAnswers, explicitConfig, existingConfig);
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

        // Validate instance type against framework requirements (now that framework version is known)
        const finalInstanceType = infraAnswers.customInstanceType || infraAnswers.instanceType;
        if (finalInstanceType && frameworkVersionAnswers.frameworkVersion) {
            await this._validateAndDisplayInstanceType(
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
            if (modelName.startsWith('s3://')) {
                combinedAnswers.modelSource = 's3';
                combinedAnswers.artifactUri = modelName;
            } else if (modelName.startsWith('jumpstart://')) {
                combinedAnswers.modelSource = 'jumpstart';
            } else if (modelName.startsWith('jumpstart-hub://')) {
                combinedAnswers.modelSource = 'jumpstart-hub';
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
        const downloadSources = ['jumpstart', 's3'];
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

        // Warn about jumpstart-hub:// models — private hub deployment requires
        // HubAccessConfig on CreateModel, which is not yet supported by the generator.
        if (combinedAnswers.modelSource === 'jumpstart-hub') {
            console.log('\n   ⚠️  JumpStart Private Hub models are not yet fully supported.');
            console.log('   Private hub artifacts live in AWS-managed S3 buckets that require');
            console.log('   SageMaker\'s HubAccessConfig mechanism for access.');
            console.log('   The generated project will not be able to download model artifacts at runtime.');
            console.log('   This feature is tracked for a future release.\n');
            console.log('   Falling back to HuggingFace source.\n');
            combinedAnswers.modelSource = 'huggingface';
            delete combinedAnswers.artifactUri;
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
     * Query MCP region-picker server before infrastructure prompts.
     * Populates configManager.mcpChoices so _runPhase injects them into list prompts.
     * @private
     */
    async _queryMcpForRegion(frameworkAnswers, explicitConfig) {
        const cm = this.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (mcpServers.length === 0) return;

        const smart = this.options.smart === true;

        // Region: skip MCP query if region was explicitly provided via CLI, config file, or bootstrap profile
        const cliRegion = this.options.region;
        const bootstrapRegion = explicitConfig.awsRegion;
        const skipRegionQuery = (cliRegion !== undefined && cliRegion !== null) ||
            (bootstrapRegion !== undefined && bootstrapRegion !== null);

        if (!skipRegionQuery && mcpServers.includes('region-picker')) {
            const { regionSearch } = await this._runPrompts([{
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
     * Query MCP instance-sizer server with tag-based search after deployment target is known.
     * Used when no model name is available for VRAM-based sizing.
     * Populates configManager.mcpChoices so _runPhase injects them into list prompts.
     * @private
     */
    async _queryMcpForInstance(frameworkAnswers, explicitConfig) {
        const cm = this.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (mcpServers.length === 0) return;

        const smart = this.options.smart === true;

        // Instance type: query if not already provided via CLI/config
        if (!explicitConfig.instanceType && mcpServers.includes('instance-sizer')) {
            const { instanceSearch } = await this._runPrompts([{
                type: 'input',
                name: 'instanceSearch',
                message: '🔌 Describe your instance needs (e.g. "multi-gpu", "cost-effective cpu"):',
                default: frameworkAnswers.framework || ''
            }]);

            if (instanceSearch && instanceSearch.trim()) {
                console.log(`   🔍 Querying instance-sizer [search]${smart ? ' [smart]' : ''}...`);
                const result = await cm.queryMcpServer('instance-sizer', {
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
     * Query the instance-sizer MCP server after model is known.
     * Estimates VRAM requirements and returns filtered, ranked instance recommendations.
     * Stores results in this._mcpInstanceSizerChoices and this._instanceSizerMetadata.
     * Requirements: 4.4, 4.5, 4.7, 3.6, 3.7
     * @param {object} frameworkAnswers - Framework/architecture answers
     * @param {object} modelFormatAnswers - Model format answers (contains modelName)
     * @param {object} explicitConfig - Explicit CLI/config values
     * @param {object} [sizerContext={}] - Additional context for the sizer query
     * @param {string} [sizerContext.cudaVersion] - CUDA version from base image
     * @param {object} [sizerContext.profileEnvVars] - Profile ENV overrides
     * @private
     */
    async _queryMcpForInstanceSizing(frameworkAnswers, modelFormatAnswers, explicitConfig, sizerContext = {}) {
        const cm = this.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('instance-sizer')) return;

        // Resolve model name from answers or explicit config
        const modelName = modelFormatAnswers.customModelName || modelFormatAnswers.modelName || explicitConfig.modelName;
        if (!modelName || modelName === 'Custom (enter manually)') return;

        const smart = this.options.smart === true;
        const discover = this.options.discover === true;

        const modeLabel = [smart && '[smart]', discover && '[discover]'].filter(Boolean).join(' ');
        console.log(`   🔍 Querying instance-sizer${modeLabel ? ` ${modeLabel}` : ''}...`);

        try {
            const mcpConfigPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (!fs.existsSync(mcpConfigPath)) return;

            const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
            const serverConfig = mcpConfig.mcpServers?.['instance-sizer'];
            if (!serverConfig) return;

            const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
            const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

            const serverArgs = [...(serverConfig.args || [])];
            if (discover && !serverArgs.includes('--discover')) {
                serverArgs.push('--discover');
            }

            const transport = new StdioClientTransport({
                command: serverConfig.command,
                args: serverArgs,
                env: {
                    ...process.env,
                    ...(serverConfig.env || {}),
                    ...(smart ? { BEDROCK_SMART: 'true' } : {})
                },
                stderr: 'pipe'
            });

            const mcpClient = new Client(
                { name: 'ml-container-creator', version: '1.0.0' },
                { capabilities: {} }
            );

            await mcpClient.connect(transport);

            const toolArgs = {
                modelName,
                limit: 10,
                context: {
                    architecture: frameworkAnswers.architecture || undefined,
                    backend: frameworkAnswers.backend || undefined,
                    deploymentTarget: frameworkAnswers.deploymentTarget || undefined,
                    profileEnvVars: sizerContext.profileEnvVars || undefined
                }
            };

            // Add CUDA version from base image for filtering
            if (sizerContext.cudaVersion) {
                toolArgs.cudaVersion = sizerContext.cudaVersion;
            }

            // Add quantization if available from model format answers
            if (modelFormatAnswers.quantization) {
                toolArgs.quantization = modelFormatAnswers.quantization;
            }

            const result = await mcpClient.callTool({
                name: 'get_instance_recommendation',
                arguments: toolArgs
            });

            await mcpClient.close();

            // Parse the response
            const textBlock = result?.content?.find(b => b.type === 'text');
            if (textBlock) {
                const parsed = JSON.parse(textBlock.text);

                if (parsed.choices?.instanceType?.length > 0) {
                    this._instanceSizerMetadata = parsed.metadata || null;

                    // Build display labels with VRAM estimate and utilization percentage
                    const recommendations = parsed.metadata?.recommendations || [];
                    const estimatedVramGb = parsed.metadata?.estimatedVramGb;
                    
                    // Store choices with display labels for the instance prompt
                    this._mcpInstanceSizerChoices = parsed.choices.instanceType;
                    this._mcpInstanceSizerDisplayChoices = recommendations.map(rec => ({
                        name: rec.displayLabel || `${rec.instanceType} (${estimatedVramGb ? estimatedVramGb.toFixed(1) : '?'}GB / ${rec.totalVramGb || '?'}GB — ${rec.utilizationPercent || '?'}% utilization)`,
                        value: rec.instanceType,
                        short: rec.instanceType
                    }));

                    const choices = parsed.choices.instanceType;
                    const topRec = recommendations[0];
                    const vramInfo = estimatedVramGb
                        ? ` (model needs ~${estimatedVramGb.toFixed(1)}GB VRAM)`
                        : '';

                    console.log(`   ✓ ${choices.length} compatible instance(s) found${vramInfo}`);

                    // Check if availability data is present (recommendations have capacityType)
                    const hasAvailabilityData = recommendations.some(r => r.capacityType);

                    if (hasAvailabilityData) {
                        // Group by capacityType for display
                        const reserved = recommendations.filter(r => r.capacityType === 'reserved' || r.capacityType === 'ftp');
                        const onDemand = recommendations.filter(r => r.capacityType === 'on-demand');

                        if (reserved.length > 0) {
                            console.log('     ── Reserved Capacity ──');
                            for (const rec of reserved) {
                                const tp = rec.tensorParallelism > 1 ? ` TP=${rec.tensorParallelism}` : '';
                                const vram = rec.totalVramGb ? `${rec.totalVramGb}GB` : '?';
                                const util = rec.utilizationPercent ? `${rec.utilizationPercent}%` : '?';
                                const tag = rec.capacityType === 'reserved'
                                    ? ` [CR] ${rec.reservationInfo?.planName || rec.reservationInfo?.reservationId || ''}`
                                    : ` [FTP] ${rec.ftpInfo?.planName || ''}`;
                                console.log(`     ${rec === topRec ? '→' : ' '} ${rec.instanceType.padEnd(20)} ${vram.padStart(5)} VRAM  ${util.padStart(4)} util${tp}${tag}`);
                            }
                        }

                        if (onDemand.length > 0) {
                            console.log('     ── On-Demand ──');
                            for (const rec of onDemand) {
                                const tp = rec.tensorParallelism > 1 ? ` TP=${rec.tensorParallelism}` : '';
                                const vram = rec.totalVramGb ? `${rec.totalVramGb}GB` : '?';
                                const util = rec.utilizationPercent ? `${rec.utilizationPercent}%` : '?';
                                const deployed = rec.quotaDeployed;
                                const quota = rec.quotaLimit;
                                const tag = quota !== null && quota !== undefined ? ` [Q:${deployed ?? 0}/${quota}]` : '';
                                console.log(`     ${rec === topRec ? '→' : ' '} ${rec.instanceType.padEnd(20)} ${vram.padStart(5)} VRAM  ${util.padStart(4)} util${tp}${tag}`);
                            }
                        }
                    } else {
                        // Fallback: display compact recommendation table (no availability data)
                        for (const rec of recommendations) {
                            const tp = rec.tensorParallelism > 1 ? ` TP=${rec.tensorParallelism}` : '';
                            const vram = rec.totalVramGb ? `${rec.totalVramGb}GB` : '?';
                            const util = rec.utilizationPercent ? `${rec.utilizationPercent}%` : '?';
                            console.log(`     ${rec === topRec ? '→' : ' '} ${rec.instanceType.padEnd(20)} ${vram.padStart(5)} VRAM  ${util.padStart(4)} util${tp}`);
                        }
                    }
                } else if (parsed.metadata?.allFilteredByQuota) {
                    // All VRAM-compatible instances had zero quota
                    console.log('   ⚠️ No quota available for compatible instances. Request a quota increase.');
                    this._instanceSizerMetadata = parsed.metadata || null;
                } else if (parsed.metadata?.warning) {
                    console.log(`   ⚠️  ${parsed.metadata.warning}`);
                } else {
                    // Apply architecture heuristic fallback when sizer returns empty
                    const archForHeuristic = frameworkAnswers.architecture || frameworkAnswers.deploymentConfig?.split('-')[0];
                    this._architectureHeuristicDefault = this._getArchitectureHeuristicDefault(archForHeuristic);
                    console.log(`   ↳ No instance-sizer results, using heuristic default: ${this._architectureHeuristicDefault}`);
                }
            }
        } catch (err) {
            // Sizer unavailable — apply architecture heuristic fallback
            const archForHeuristic = frameworkAnswers.architecture || frameworkAnswers.deploymentConfig?.split('-')[0];
            this._architectureHeuristicDefault = this._getArchitectureHeuristicDefault(archForHeuristic);
            console.log(`   ⚠️  instance-sizer: ${err.message}`);
            console.log(`   ↳ Using heuristic default: ${this._architectureHeuristicDefault}`);
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

        const smart = this.options.smart === true;
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
    async _queryMcpForBaseImage(frameworkAnswers, _explicitConfig) {
        // Skip if base image provided via CLI --base-image flag
        if (this.options['base-image']) return;

        const cm = this.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('base-image-picker')) return;

        const smart = this.options.smart === true;
        const discover = this.options.discover === true;
        const framework = frameworkAnswers.framework;
        const modelServer = frameworkAnswers.modelServer;
        const architecture = frameworkAnswers.architecture || frameworkAnswers.deploymentConfig?.split('-')[0];
        const isTransformer = framework === 'transformers';
        const isTriton = architecture === 'triton';
        const isDiffusors = architecture === 'diffusors';

        // For non-transformer, non-triton, non-diffusors frameworks, prompt for optional search criteria
        let searchCriteria;
        if (!isTransformer && !isTriton && !isDiffusors) {
            const searchAnswer = await this._runPrompts(baseImageSearchPrompts.map(p => ({
                ...p,
                when: () => true // Always show for non-transformer since we already checked
            })));
            searchCriteria = searchAnswer.baseImageSearch;
        }

        const modeLabel = [smart && '[smart]', discover && '[discover]'].filter(Boolean).join(' ');
        console.log(`   🔍 Querying base-image-picker${modeLabel ? ` ${modeLabel}` : ''}...`);

        const context = { framework, modelServer, architecture };
        if (searchCriteria && searchCriteria.trim()) {
            context.searchCriteria = searchCriteria.trim();
        }

        const result = await cm.queryMcpServer('base-image-picker', context);

        if (result && result.metadata?.baseImage?.length > 0) {
            const entries = result.metadata.baseImage;
            this._mcpBaseImageChoices = formatImageChoices(entries, isTransformer || isTriton || isDiffusors);
            const count = entries.length;
            console.log(`   ✓ ${count} base image(s) available`);
        } else {
            console.log('   ↳ No MCP results, using default image');
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
        const cm = this.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('model-picker')) return;

        try {
            const mcpConfigPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (!fs.existsSync(mcpConfigPath)) return;

            const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
            const serverConfig = mcpConfig.mcpServers?.['model-picker'];
            if (!serverConfig?.args?.length) return;

            // Resolve the server entry point directory from the args
            const serverEntryPoint = serverConfig.args[serverConfig.args.length - 1];
            const serverDir = path.dirname(serverEntryPoint);

            // Read manifest to find catalog path
            const manifestPath = path.join(serverDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) return;

            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            // Select catalog based on architecture
            const catalogKey = architecture === 'diffusors'
                ? 'popular-diffusors'
                : 'popular-transformers';
            const catalogRelPath = manifest.catalogs?.[catalogKey];
            if (!catalogRelPath) return;

            const catalogPath = path.resolve(serverDir, catalogRelPath);
            if (!fs.existsSync(catalogPath)) return;

            const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

            // Extract model IDs, filtering out glob patterns (entries with *)
            const modelIds = Object.keys(catalog).filter(id => !id.includes('*'));

            if (modelIds.length > 0) {
                this._mcpModelChoices = modelIds;
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

    /**
     * Fetch and display model information from HuggingFace API and Model Registry
     * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.11, 11.1, 11.2, 11.3, 11.5, 11.6, 11.7
     * @private
     */
    async _fetchAndDisplayModelInfo(modelId) {
        console.log('\n   🔍 Querying model-picker [discover]...');

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

                                    // Extract model_type for architecture validation
                                    // Requirements: 4.1
                                    if (vals.model_type) {
                                        this._modelType = vals.model_type;
                                    }

                                    // Extract model source metadata for loading adapter
                                    // Requirements: 2.1, 2.2, 2.3, 2.4
                                    if (vals.provider) {
                                        this._mcpModelSource = vals.provider;
                                    }
                                    if (vals.artifactUri) {
                                        this._mcpArtifactUri = vals.artifactUri;
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
            const registryConfigManager = this.registryConfigManager;
            if (registryConfigManager) {
                // Only try HuggingFace API for bare model IDs (not prefixed URIs)
                const isNonHfUri = modelId.startsWith('jumpstart://') ||
                        modelId.startsWith('jumpstart-hub://') ||
                        modelId.startsWith('s3://') ||
                        modelId.startsWith('registry://');

                if (!isNonHfUri) {
                    // Try HuggingFace API directly
                    try {
                        const hfData = await registryConfigManager._fetchHuggingFaceData(modelId);
                        if (hfData) {
                            sources.push('HuggingFace_Hub_API');
                            if (hfData.chatTemplate) {
                                chatTemplate = hfData.chatTemplate;
                            }
                            // Extract model_type for architecture validation
                            // Requirements: 4.1
                            if (hfData.modelConfig?.model_type) {
                                this._modelType = hfData.modelConfig.model_type;
                            }
                            console.log('   ✅ Found on HuggingFace Hub');
                        } else {
                            console.log('   ℹ️  Not found on HuggingFace Hub (may be private or offline)');
                        }
                    } catch (error) {
                        console.log('   ⚠️  HuggingFace API unavailable');
                    }
                } else {
                    // Non-HF URI (jumpstart://, s3://, etc.) — skip HF lookup silently
                    // The summary at the end of this function will report "No additional model information"
                }

                // Check Model Registry for overrides
                if (registryConfigManager.modelRegistry) {
                    let modelConfig = registryConfigManager.modelRegistry[modelId];

                    if (!modelConfig) {
                        for (const [pattern, config] of Object.entries(registryConfigManager.modelRegistry)) {
                            if (pattern.includes('*')) {
                                const regex = new RegExp(`^${  pattern.replace(/\*/g, '.*')  }$`);
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
        const registryConfigManager = this.registryConfigManager;
        
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
            if (this.options.skipPrompts || process.env.NODE_ENV === 'test') {
                throw new Error('Instance type validation failed. Please select a compatible instance type.');
            }
            
            // Ask user if they want to proceed
            const proceed = await this._runPrompts([{
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
     * Run secret prompts using the Secret_Classification registry.
     * For each secret type whose stages apply to the current context:
     * - Query for managed secrets of that type
     * - If managed secrets exist: show selection list (secrets + "Enter plaintext token" + "Skip")
     * - If no managed secrets exist: fall back to existing plaintext prompt
     * 
     * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9
     * @param {object} previousAnswers - Answers from previous prompt phases
     * @param {object} explicitConfig - Explicit CLI/config values
     * @param {object} existingConfig - Existing project configuration
     * @returns {Promise<object>} Object with token/ARN values keyed by config field names
     * @private
     */
    async _runSecretPrompts(previousAnswers, explicitConfig, existingConfig) {
        const results = {};

        for (const classification of SECRET_CLASSIFICATIONS) {
            // Check if this secret type's stages apply to the current context
            if (!this._secretStagesApply(classification, previousAnswers)) continue;

            // Determine the config keys for this classification
            const arnConfigKey = this._getArnConfigKey(classification);
            const plaintextConfigKey = this._getPlaintextConfigKey(classification);

            // Skip if ARN already provided via CLI flag
            if (explicitConfig[arnConfigKey]) {
                results[arnConfigKey] = explicitConfig[arnConfigKey];
                continue;
            }

            // Skip if plaintext already provided via CLI flag
            if (explicitConfig[plaintextConfigKey]) {
                results[plaintextConfigKey] = explicitConfig[plaintextConfigKey];
                continue;
            }

            // Query for existing managed secrets of this type
            const managedSecrets = await this._listManagedSecrets(classification.identifier);

            if (managedSecrets.length > 0) {
                // Show selection list: managed secrets + plaintext entry + skip
                const answer = await this._promptSecretSelection(classification, managedSecrets, previousAnswers);
                Object.assign(results, answer);
            } else {
                // Fall back to existing plaintext prompt
                const answer = await this._promptPlaintextFallback(classification, previousAnswers, explicitConfig, existingConfig);
                Object.assign(results, answer);
            }
        }

        return results;
    }

    /**
     * Determine if a secret classification's stages apply to the current generation context.
     * Build-time secrets apply when the project involves a Docker build step.
     * Runtime secrets apply when the architecture uses HuggingFace Hub models.
     * Requirements: 8.9
     * @param {object} classification - Secret classification entry
     * @param {object} answers - Current answers from previous phases
     * @returns {boolean} True if the secret type is applicable
     * @private
     */
    _secretStagesApply(classification, answers) {
        const architecture = answers.architecture || answers.deploymentConfig?.split('-')[0];
        const backend = answers.backend || answers.deploymentConfig?.split('-').slice(1).join('-');

        if (classification.identifier === 'hf-token') {
            // HF token applies to transformers, diffusors, and Triton LLM backends
            const isTransformers = architecture === 'transformers';
            const isDiffusors = architecture === 'diffusors';
            const isTritonLlm = architecture === 'triton' && (backend === 'vllm' || backend === 'tensorrtllm');

            if (!isTransformers && !isDiffusors && !isTritonLlm) return false;

            // Skip for non-HuggingFace model sources
            const modelSource = answers.modelSource;
            if (modelSource && modelSource !== 'huggingface') return false;

            return true;
        }

        if (classification.identifier === 'ngc-token') {
            // NGC token only applies to transformers-tensorrt-llm (build-time only)
            if (architecture === 'triton') return false;
            if (architecture === 'diffusors') return false;
            return architecture === 'transformers' && backend === 'tensorrt-llm';
        }

        // For future secret types, check if any stage applies
        // Build-time applies to all Docker-based deployments
        // Runtime applies to architectures that download at startup
        return classification.stages.length > 0;
    }

    /**
     * Get the ARN config key for a classification.
     * Maps classification identifiers to config field names.
     * @param {object} classification - Secret classification entry
     * @returns {string} Config key for the ARN value
     * @private
     */
    _getArnConfigKey(classification) {
        const keyMap = {
            'hf-token': 'hfTokenArn',
            'ngc-token': 'ngcTokenArn'
        };
        return keyMap[classification.identifier] || `${classification.identifier.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Arn`;
    }

    /**
     * Get the plaintext config key for a classification.
     * Maps classification identifiers to config field names.
     * @param {object} classification - Secret classification entry
     * @returns {string} Config key for the plaintext value
     * @private
     */
    _getPlaintextConfigKey(classification) {
        const keyMap = {
            'hf-token': 'hfToken',
            'ngc-token': 'ngcApiKey'
        };
        return keyMap[classification.identifier] || classification.identifier.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }

    /**
     * List managed secrets of a given type from AWS Secrets Manager.
     * Uses the active bootstrap profile to query for secrets tagged with
     * the mlcc:secret-type matching the given identifier.
     * @param {string} secretType - The secret type identifier (e.g., 'hf-token')
     * @returns {Promise<Array<{name: string, arn: string}>>} Array of managed secrets
     * @private
     */
    async _listManagedSecrets(secretType) {
        try {
            const bootstrapConfig = new BootstrapConfig();
            const activeProfile = bootstrapConfig.getActiveProfile();
            if (!activeProfile) return [];

            const profile = activeProfile.config.awsProfile;
            const region = activeProfile.config.awsRegion;
            if (!profile || !region) return [];

            const command = `aws secretsmanager list-secrets --filters Key=tag-key,Values=mlcc:managed-by Key=tag-value,Values=ml-container-creator --region ${region} --profile ${profile} --output json`;
            const output = execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
            const trimmed = output.trim();
            if (!trimmed) return [];

            const result = JSON.parse(trimmed);
            const secrets = result.SecretList || [];

            // Filter by secret type tag
            return secrets
                .filter(secret => {
                    const typeTag = (secret.Tags || []).find(t => t.Key === 'mlcc:secret-type');
                    return typeTag && typeTag.Value === secretType;
                })
                .map(secret => ({
                    name: secret.Name,
                    arn: secret.ARN
                }));
        } catch {
            // If AWS CLI fails (not configured, no credentials, etc.), return empty
            return [];
        }
    }

    /**
     * Display a selection list for managed secrets of a given type.
     * Shows available secrets plus options for plaintext entry and skip.
     * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
     * @param {object} classification - Secret classification entry
     * @param {Array<{name: string, arn: string}>} managedSecrets - Available managed secrets
     * @param {object} previousAnswers - Answers from previous phases
     * @returns {Promise<object>} Object with the selected value keyed by config field name
     * @private
     */
    async _promptSecretSelection(classification, managedSecrets, previousAnswers) {
        const arnConfigKey = this._getArnConfigKey(classification);

        console.log(`\n🔐 ${classification.displayName}`);
        console.log(`   ${classification.purpose}`);

        // Build choices: managed secrets + enter plaintext + skip
        const choices = [
            ...managedSecrets.map(secret => ({
                name: `🔒 ${secret.name} (${secret.arn})`,
                value: secret.arn,
                short: secret.name
            })),
            { name: '✏️  Enter plaintext token', value: '__plaintext__', short: 'Plaintext' },
            { name: '⏭️  Skip (use environment variable)', value: '__skip__', short: 'Skip' }
        ];

        const { secretSelection } = await this._runPrompts([{
            type: 'list',
            name: 'secretSelection',
            message: `Select ${classification.promptLabel}:`,
            choices
        }]);

        if (secretSelection === '__skip__') {
            return {};
        }

        if (secretSelection === '__plaintext__') {
            // Use existing plaintext flow
            return this._promptPlaintextEntry(classification, previousAnswers);
        }

        // User selected a managed secret ARN
        return { [arnConfigKey]: secretSelection };
    }

    /**
     * Prompt for plaintext token entry with ARN detection.
     * If the user enters an ARN, store it as an ARN reference.
     * Requirements: 8.4, 8.5, 8.6
     * @param {object} classification - Secret classification entry
     * @param {object} previousAnswers - Answers from previous phases
     * @returns {Promise<object>} Object with the value keyed by config field name
     * @private
     */
    async _promptPlaintextEntry(classification, _previousAnswers) {
        const arnConfigKey = this._getArnConfigKey(classification);
        const plaintextConfigKey = this._getPlaintextConfigKey(classification);

        const { tokenValue } = await this._runPrompts([{
            type: 'input',
            name: 'tokenValue',
            message: `${classification.promptLabel} (enter token, ARN, or leave empty):`,
            validate: (input) => {
                // Empty is valid
                if (!input || input.trim() === '') return true;
                // Environment variable reference is valid
                if (input.trim().startsWith('$')) return true;
                return true;
            }
        }]);

        if (!tokenValue || tokenValue.trim() === '') {
            return {};
        }

        const value = tokenValue.trim();

        // ARN detection: if the value is a Secrets Manager ARN, store as ARN
        if (isSecretsManagerArn(value)) {
            return { [arnConfigKey]: value };
        }

        // Otherwise store as plaintext
        return { [plaintextConfigKey]: value };
    }

    /**
     * Fall back to existing plaintext prompt when no managed secrets exist.
     * Uses the same prompts as the original hfTokenPrompts/ngcApiKeyPrompts
     * but with ARN detection on the input.
     * Requirements: 8.7
     * @param {object} classification - Secret classification entry
     * @param {object} previousAnswers - Answers from previous phases
     * @param {object} explicitConfig - Explicit CLI/config values
     * @param {object} existingConfig - Existing project configuration
     * @returns {Promise<object>} Object with the value keyed by config field name
     * @private
     */
    async _promptPlaintextFallback(classification, _previousAnswers, _explicitConfig, _existingConfig) {
        const arnConfigKey = this._getArnConfigKey(classification);
        const plaintextConfigKey = this._getPlaintextConfigKey(classification);

        // If in auto-prompt mode, skip
        if (this.configManager?.isAutoPrompt()) {
            return {};
        }

        // Display context-appropriate security message
        if (classification.identifier === 'hf-token') {
            console.log('\n🔐 HuggingFace Authentication');
            console.log('   Many models (e.g. Llama, Mistral) are gated and require a token.');
            console.log('   💡 Tip: Use `ml-container-creator secrets create --type hf-token` to store');
            console.log('   your token in AWS Secrets Manager for zero-knowledge operation.');
            console.log('   For CI/CD pipelines, use "$HF_TOKEN" to reference an environment variable.\n');
        } else if (classification.identifier === 'ngc-token') {
            console.log('\n🔐 NVIDIA NGC Authentication');
            console.log('   TensorRT-LLM base images are hosted on NVIDIA NGC and require an API key.');
            console.log('   💡 Tip: Use `ml-container-creator secrets create --type ngc-token` to store');
            console.log('   your key in AWS Secrets Manager for zero-knowledge operation.');
            console.log('   For CI/CD pipelines, use "$NGC_API_KEY" to reference an environment variable.\n');
        } else {
            console.log(`\n🔐 ${classification.displayName}`);
            console.log(`   ${classification.purpose}\n`);
        }

        const { tokenValue } = await this._runPrompts([{
            type: 'input',
            name: 'tokenValue',
            message: `${classification.promptLabel} (enter token, ARN, "$${classification.envVar}" for env var, or leave empty):`,
            validate: (input) => {
                if (!input || input.trim() === '') return true;
                if (input.trim().startsWith('$')) return true;
                // Warn about HF token format
                if (classification.identifier === 'hf-token' && !input.startsWith('hf_') && !isSecretsManagerArn(input)) {
                    console.warn('\n⚠️  Warning: HuggingFace tokens typically start with "hf_"');
                    console.warn('   If this is intentional, you can ignore this warning.');
                }
                return true;
            }
        }]);

        if (!tokenValue || tokenValue.trim() === '') {
            return {};
        }

        const value = tokenValue.trim();

        // ARN detection: if the value is a Secrets Manager ARN, store as ARN
        if (isSecretsManagerArn(value)) {
            return { [arnConfigKey]: value };
        }

        // Otherwise store as plaintext
        return { [plaintextConfigKey]: value };
    }

    /**
     * CUDA-to-AMI mapping.
     * Maps CUDA major.minor versions to the SageMaker inference AMI that provides
     * the matching CUDA driver. Derived from the framework registry patterns.
     * @private
     */
    static CUDA_AMI_MAP = {
        '11.0': 'al2-ami-sagemaker-inference-gpu-2',
        '11.4': 'al2-ami-sagemaker-inference-gpu-2-1',
        '11.8': 'al2-ami-sagemaker-inference-gpu-2-1',
        '12.1': 'al2-ami-sagemaker-inference-gpu-3-1',
        '12.2': 'al2-ami-sagemaker-inference-gpu-3-1',
        '12.4': 'al2-ami-sagemaker-inference-gpu-3-1',
        '12.6': 'al2-ami-sagemaker-inference-gpu-3-1',
        '13.0': 'al2023-ami-sagemaker-inference-gpu-4-1'
    };

    /**
     * Prompt the user to select a CUDA version when the selected GPU instance
     * supports multiple versions. The choice transparently resolves to the
     * correct SageMaker inference AMI.
     *
     * When a base image CUDA version is provided, auto-resolves by intersecting
     * with the instance's supported versions. Removes the CUDA prompt from the
     * interactive flow when auto-resolution succeeds.
     *
     * Skipped for CPU instances, non-CUDA accelerators, or when only one
     * compatible CUDA version exists.
     *
     * @param {string} instanceType - Selected instance type (e.g. "ml.g5.2xlarge")
     * @param {string} framework - Selected framework name
     * @param {string} frameworkVersion - Selected framework version
     * @param {string} [baseImageCuda] - CUDA version from selected base image (for auto-resolution)
     * @returns {Promise<{cudaVersion: string, inferenceAmiVersion: string}|null>}
     * @private
     */
    async _promptCudaVersion(instanceType, framework, frameworkVersion, baseImageCuda) {
        if (!instanceType) return null;

        // Look up instance in accelerator mapping
        const instanceInfo = this._instanceAcceleratorMapping[instanceType];
        if (!instanceInfo || instanceInfo.accelerator.type !== 'cuda') return null;

        const instanceCudaVersions = instanceInfo.accelerator.versions;
        if (!instanceCudaVersions || instanceCudaVersions.length === 0) return null;

        // Auto-resolution: when base image specifies a CUDA version, intersect with instance support
        // Requirements: 3.11, 4.9, 4.10, 4.11
        if (baseImageCuda) {
            const majorRequired = baseImageCuda.split('.')[0];
            const intersection = instanceCudaVersions.filter(v => {
                if (v === baseImageCuda) return true;
                if (v.startsWith(`${majorRequired  }.`)) return true;
                return false;
            });

            if (intersection.length > 0) {
                // Auto-select: pick exact match or highest compatible
                const exactMatch = intersection.find(v => v === baseImageCuda);
                const selectedVersion = exactMatch || intersection.sort().pop();
                const inferenceAmiVersion = PromptRunner.CUDA_AMI_MAP[selectedVersion];
                if (inferenceAmiVersion) {
                    console.log(`\n🔧 CUDA ${selectedVersion} auto-resolved from base image (requires ${baseImageCuda})`);
                    console.log(`   AMI: ${inferenceAmiVersion}`);
                    return { cudaVersion: selectedVersion, inferenceAmiVersion };
                }
            } else {
                // No intersection — warn and fall through to manual prompt
                console.log(`\n   ⚠️  Base image requires CUDA ${baseImageCuda} but instance ${instanceType} supports: ${instanceCudaVersions.join(', ')}`);
                console.log('   No compatible CUDA version found. Falling back to manual selection.');
            }
        }

        // Get framework CUDA requirements (if available)
        const registryConfigManager = this.registryConfigManager;
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

        // Multiple options — let the user choose (or auto-select in auto-prompt mode)
        const defaultVersion = frameworkAccel?.version
            && compatibleVersions.includes(frameworkAccel.version)
            ? frameworkAccel.version
            : instanceInfo.accelerator.default || compatibleVersions[compatibleVersions.length - 1];

        // In auto-prompt mode, auto-select the default without prompting
        if (this.configManager?.isAutoPrompt()) {
            const inferenceAmiVersion = PromptRunner.CUDA_AMI_MAP[defaultVersion];
            if (inferenceAmiVersion) {
                console.log(`\n🔧 CUDA ${defaultVersion} auto-selected (auto-prompt mode)`);
                console.log(`   AMI: ${inferenceAmiVersion}`);
            }
            return inferenceAmiVersion ? { cudaVersion: defaultVersion, inferenceAmiVersion } : null;
        }

        const choices = compatibleVersions.map(v => {
            const ami = PromptRunner.CUDA_AMI_MAP[v] || 'unknown';
            const isDefault = v === defaultVersion ? ' (recommended)' : '';
            return {
                name: `CUDA ${v}${isDefault}  →  AMI: ${ami}`,
                value: v,
                short: `CUDA ${v}`
            };
        });

        const { cudaVersion } = await this._runPrompts([{
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


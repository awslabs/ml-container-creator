// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isTuneSupported } from './tune-catalog-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Finds model configuration by exact match or glob-pattern match.
 *
 * @param {string} modelName - Model ID to look up
 * @param {object} registryConfigManager - Registry configuration manager
 * @returns {object|null} Model configuration or null
 */
function _findModelConfig(modelName, registryConfigManager) {
    if (!registryConfigManager?.modelRegistry) return null;

    // Exact match first
    const exact = registryConfigManager.modelRegistry[modelName];
    if (exact) return exact;

    // Pattern matching with glob-style wildcards
    for (const [pattern, config] of Object.entries(registryConfigManager.modelRegistry)) {
        if (pattern.includes('*')) {
            const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
            if (regex.test(modelName)) {
                return config;
            }
        }
    }

    return null;
}

/**
 * Merges environment variables from all catalog sources with correct precedence.
 * Precedence (lowest → highest):
 *   1. catalog defaults (Image_Entry defaults.envVars)
 *   2. framework profile (Image_Entry profiles[selectedProfile].envVars)
 *   3. model entry (model catalog entry envVars)
 *   4. model profile (model catalog entry profiles[selectedProfile].envVars)
 *   5. CLI overrides (existing answers.envVars from user CLI input)
 *
 * @param {object} answers - Configuration answers
 * @param {object|null} registryConfigManager - Registry configuration manager
 */
export async function _mergeEnvVarsWithPrecedence(answers, registryConfigManager) {
    if (!registryConfigManager) return;

    // Capture CLI-provided env vars before merging (highest precedence)
    const cliEnvVars = { ...answers.envVars };

    // Resolve the framework config for the selected framework + version
    const frameworkName = answers.framework || answers.deploymentConfig;
    const frameworkVersion = answers.frameworkVersion;
    let frameworkConfig = null;

    if (frameworkName && registryConfigManager.frameworkRegistry) {
        const frameworkVersions = registryConfigManager.frameworkRegistry[frameworkName];
        if (frameworkVersions) {
            if (frameworkVersion && frameworkVersions[frameworkVersion]) {
                frameworkConfig = frameworkVersions[frameworkVersion];
            } else {
                // Fall back to latest version for Triton and other non-versioned lookups
                const versions = Object.keys(frameworkVersions).sort((a, b) =>
                    b.localeCompare(a, undefined, { numeric: true })
                );
                if (versions.length > 0) {
                    frameworkConfig = frameworkVersions[versions[0]];
                }
            }
        }
    }

    // Resolve the model config (exact match or pattern match)
    let modelConfig = null;
    if (answers.modelName && registryConfigManager.modelRegistry) {
        modelConfig = _findModelConfig(answers.modelName, registryConfigManager);
    }

    // Layer 1: catalog defaults (Image_Entry defaults.envVars)
    const catalogDefaults = frameworkConfig?.envVars || {};

    // Layer 2: framework profile envVars
    let frameworkProfileEnvVars = {};
    if (answers.frameworkProfile && frameworkConfig?.profiles) {
        const profile = frameworkConfig.profiles[answers.frameworkProfile];
        if (profile?.envVars) {
            frameworkProfileEnvVars = profile.envVars;
        }
    }

    // Layer 3: model entry envVars
    const modelEntryEnvVars = modelConfig?.envVars || {};

    // Layer 4: model profile envVars
    let modelProfileEnvVars = {};
    if (answers.modelProfile && modelConfig?.profiles) {
        const profile = modelConfig.profiles[answers.modelProfile];
        if (profile?.envVars) {
            modelProfileEnvVars = profile.envVars;
        }
    }

    // Layer 5: CLI overrides (captured above)

    // Merge in precedence order: each layer overrides the previous
    answers.envVars = {
        ...catalogDefaults,
        ...frameworkProfileEnvVars,
        ...modelEntryEnvVars,
        ...modelProfileEnvVars,
        ...cliEnvVars
    };
}

/**
 * Validates environment variables using the registry system.
 * Displays errors and warnings to the user.
 *
 * @param {object} answers - Configuration answers
 * @param {object} registryConfigManager - Registry configuration manager
 */
export async function _validateEnvironmentVariables(answers, registryConfigManager) {
    // Get framework configuration
    // For Triton configs, look up using deploymentConfig key (e.g. 'triton-fil')
    let frameworkConfig;
    if (answers.architecture === 'triton' && answers.deploymentConfig) {
        const tritonEntry = registryConfigManager.frameworkRegistry?.[answers.deploymentConfig];
        if (tritonEntry) {
            const versions = Object.keys(tritonEntry);
            if (versions.length > 0) {
                frameworkConfig = tritonEntry[versions[0]];
            }
        }
    }
    if (!frameworkConfig) {
        frameworkConfig = registryConfigManager.frameworkRegistry?.[answers.framework]?.[answers.frameworkVersion];
    }

    if (!frameworkConfig || !frameworkConfig.envVars) {
        return; // No env vars to validate
    }

    console.log('\n🔍 Validating environment variables...');

    // Validate environment variables
    const validationResult = registryConfigManager.validateEnvironmentVariables(
        frameworkConfig.envVars,
        frameworkConfig
    );

    // Display validation results
    if (validationResult.errors && validationResult.errors.length > 0) {
        console.log('\n❌ Environment Variable Validation Errors:');
        validationResult.errors.forEach(error => {
            console.log(`   • ${error.key}: ${error.message}`);
        });
    }

    if (validationResult.warnings && validationResult.warnings.length > 0) {
        console.log('\n⚠️  Environment Variable Validation Warnings:');
        validationResult.warnings.forEach(warning => {
            console.log(`   • ${warning.key ? `${warning.key}: ` : ''}${warning.message}`);
        });
    }

    if (validationResult.strategiesUsed && validationResult.strategiesUsed.length > 0) {
        console.log(`\n✅ Validation methods used: ${validationResult.strategiesUsed.join(', ')}`);
    }

    if (!validationResult.errors || validationResult.errors.length === 0) {
        if (!validationResult.warnings || validationResult.warnings.length === 0) {
            console.log('   ✅ All environment variables validated successfully');
        }
    }

    // In non-interactive mode (skip-prompts), throw on errors
    if (validationResult.errors && validationResult.errors.length > 0) {
        throw new Error('Environment variable validation failed. Please fix the errors and try again.');
    }
}

/**
 * Ensures all template variables have proper defaults to prevent
 * "undefined" errors in EJS templates. Also enriches answers with
 * registry data (env var merging, HuggingFace data, Triton base image).
 *
 * @param {object} answers - Answers object to fill defaults into
 * @param {object|null} registryConfigManager - Registry configuration manager (or null)
 */
export async function _ensureTemplateVariables(answers, registryConfigManager = null) {
    const defaults = {
        chatTemplate: null,
        chatTemplateSource: null,
        hfToken: null,
        hfTokenArn: null,
        ngcApiKey: null,
        ngcTokenArn: null,
        envVars: {},
        inferenceAmiVersion: null,
        accelerator: null,
        frameworkVersion: null,
        validationLevel: 'unknown',
        configSources: [],
        recommendedInstanceTypes: [],
        roleArn: null,
        deploymentConfig: '',
        architecture: null,
        backend: null,
        engine: null,
        codebuildComputeType: null,
        codebuildProjectName: null,
        modelName: null,
        modelFormat: null,
        includeSampleModel: true,
        includeTesting: true,
        testTypes: [],
        buildTimestamp: new Date().toISOString(),
        buildTarget: 'codebuild',
        deploymentTarget: 'realtime-inference',
        hyperPodCluster: null,
        hyperPodNamespace: 'default',
        hyperPodReplicas: 1,
        fsxVolumeHandle: null,
        baseImage: null,
        modelSource: 'huggingface',
        artifactUri: '',
        modelLoadStrategy: 'runtime',
        existingEndpointName: null,
        enableLora: false,
        maxLoras: 30,
        maxLoraRank: 64
    };

    Object.entries(defaults).forEach(([key, value]) => {
        if (answers[key] === undefined) {
            answers[key] = value;
        }
    });

    // Backward compatibility: populate framework and modelServer from architecture/backend
    if (!answers.framework && answers.architecture) {
        answers.framework = answers.architecture;
    }
    if (!answers.modelServer && answers.backend) {
        answers.modelServer = answers.backend;
    }

    // Always include testing with all available test types
    answers.includeTesting = true;
    if (!answers.testTypes || answers.testTypes.length === 0) {
        if (answers.architecture === 'transformers' || answers.framework === 'transformers') {
            answers.testTypes = ['hosted-model-endpoint'];
        } else {
            answers.testTypes = ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
        }
    }

    // Merge catalog env vars into answers.envVars with correct precedence
    await _mergeEnvVarsWithPrecedence(answers, registryConfigManager);

    // For Triton architecture, set default base image fallback
    if (answers.architecture === 'triton' && !answers.baseImage) {
        // Try to look up base image from framework registry using deployment-config key
        const tritonRegistryKey = answers.deploymentConfig;
        if (tritonRegistryKey && registryConfigManager?.frameworkRegistry) {
            const tritonFrameworkConfig = registryConfigManager.frameworkRegistry[tritonRegistryKey];
            if (tritonFrameworkConfig) {
                const versions = Object.keys(tritonFrameworkConfig).sort((a, b) =>
                    b.localeCompare(a, undefined, { numeric: true })
                );
                if (versions.length > 0) {
                    const latestConfig = tritonFrameworkConfig[versions[0]];
                    if (latestConfig.baseImage) {
                        answers.baseImage = latestConfig.baseImage;
                    }
                    if (latestConfig.inferenceAmiVersion && !answers.inferenceAmiVersion) {
                        answers.inferenceAmiVersion = latestConfig.inferenceAmiVersion;
                    }
                    if (latestConfig.accelerator) {
                        answers.accelerator = latestConfig.accelerator;
                    }
                }
            }
        }
        // Final fallback: hardcoded default Triton base image
        if (!answers.baseImage) {
            answers.baseImage = 'nvcr.io/nvidia/tritonserver:24.08-py3';
        }
    }

    // For transformer models, enrich with HuggingFace data and non-envVar metadata
    if (answers.framework === 'transformers' && answers.modelName && registryConfigManager) {
        try {
            // Fetch HuggingFace data for model-specific info
            const hfData = await registryConfigManager._fetchHuggingFaceData(answers.modelName);

            // Merge chatTemplate if available and not already set
            if (hfData && hfData.chatTemplate && !answers.chatTemplate) {
                answers.chatTemplate = hfData.chatTemplate;
                answers.chatTemplateSource = 'HuggingFace_Hub_API';
            }

            // Check Model Registry for chatTemplate overrides
            if (registryConfigManager.modelRegistry) {
                const modelConfig = _findModelConfig(answers.modelName, registryConfigManager);

                if (modelConfig && modelConfig.chatTemplate) {
                    answers.chatTemplate = modelConfig.chatTemplate;
                    answers.chatTemplateSource = 'Model_Registry';
                }
            }

            // Set framework-level metadata (non-envVar fields)
            if (answers.frameworkVersion && registryConfigManager.frameworkRegistry) {
                const frameworkConfig = registryConfigManager.frameworkRegistry[answers.framework]?.[answers.frameworkVersion];

                if (frameworkConfig) {
                    if (frameworkConfig.inferenceAmiVersion && !answers.inferenceAmiVersion) {
                        answers.inferenceAmiVersion = frameworkConfig.inferenceAmiVersion;
                    }
                    if (frameworkConfig.accelerator) {
                        answers.accelerator = frameworkConfig.accelerator;
                    }
                }
            }
        } catch (error) {
            // Silently continue - defaults are already set
        }
    }

    // Populate baseImage from the catalog when still falsy (covers --skip-prompts and
    // cases where MCP/CLI/config did not provide a base image).
    // Precedence: MCP > CLI > config > catalog default (this block).
    if (!answers.baseImage && registryConfigManager?.frameworkRegistry) {
        const backendKey = answers.backend || answers.modelServer;
        if (backendKey) {
            const frameworkVersions = registryConfigManager.frameworkRegistry[backendKey];
            if (frameworkVersions) {
                let resolvedConfig = null;
                if (answers.frameworkVersion && frameworkVersions[answers.frameworkVersion]) {
                    resolvedConfig = frameworkVersions[answers.frameworkVersion];
                } else {
                    // Fall back to latest version
                    const versions = Object.keys(frameworkVersions).sort((a, b) =>
                        b.localeCompare(a, undefined, { numeric: true })
                    );
                    if (versions.length > 0) {
                        resolvedConfig = frameworkVersions[versions[0]];
                    }
                }
                if (resolvedConfig?.baseImage) {
                    answers.baseImage = resolvedConfig.baseImage;
                }
            }
        }
    }

    // Populate icGpuCount from instance catalog when not explicitly set.
    // The deploy template uses IC_GPU_COUNT unconditionally for NumberOfAcceleratorDevicesRequired,
    // so it must always have a value for GPU deployments.
    if ((answers.icGpuCount === null || answers.icGpuCount === undefined) && answers.instanceType) {
        // Use gpuCount from instance-sizer recommendation if available
        if (answers.gpuCount) {
            answers.icGpuCount = answers.gpuCount;
        } else {
            // Look up from instances catalog
            try {
                const catalogPath = path.resolve(__dirname, '..', '..', 'servers', 'lib', 'catalogs', 'instances.json');
                const catalogData = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
                const instanceInfo = catalogData?.catalog?.[answers.instanceType];
                if (instanceInfo?.gpus && instanceInfo.gpus > 0) {
                    answers.icGpuCount = instanceInfo.gpus;
                }
            } catch {
                // Silently continue — template fallback handles missing value
            }
        }
    }

    // Determine tune support based on model presence in the tune catalog.
    // Used by the do/config template to write TUNE_SUPPORTED=true|false.
    if (answers.tuneSupported === undefined) {
        try {
            const tuneCatalogPath = path.resolve(__dirname, '..', '..', 'config', 'tune-catalog.json');
            const tuneCatalog = JSON.parse(fs.readFileSync(tuneCatalogPath, 'utf-8'));
            const modelId = answers.modelName || '';
            answers.tuneSupported = isTuneSupported(modelId, tuneCatalog);
        } catch {
            answers.tuneSupported = false;
        }
    }
}

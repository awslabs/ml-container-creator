// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Manager - Handles configuration precedence and merging
 * 
 * Implements the complete precedence order (Highest → Lowest Priority):
 * 1. CLI Options (--framework=transformers)
 * 2. CLI Arguments (yo generator projectName)
 * 3. Environment Variables (AWS_REGION=us-east-1)
 * 4. CLI Config File (--config=prod.json) / Inline JSON (--config-json='...')
 * 5. Custom Config File (config/mcp.json)
 * 6. Package.json Section ("ml-container-creator": {...})
 * 7. Bootstrap Config (~/.ml-container-creator/config.json)
 * 8. Generator Defaults
 * 9. Prompting (fallback)
 */

import fs from 'fs';
import path from 'path';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp-client.js';
import DeploymentConfigResolver from './deployment-config-resolver.js';
import BootstrapConfig from './bootstrap-config.js';
import { parseKeyValue } from './key-value-parser.js';
import ParameterSchemaValidator from './parameter-schema-validator.js';

const __configMgrFilename = fileURLToPath(import.meta.url);
const __configMgrDir = dirname(__configMgrFilename);
const tritonBackendsCatalogPath = resolve(__configMgrDir, '../../servers/lib/catalogs/triton-backends.json');

function loadTritonBackendsFromCatalog() {
    try {
        const raw = readFileSync(tritonBackendsCatalogPath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        console.warn(`Failed to load triton backends catalog: ${error.message}`);
        return {};
    }
}

const tritonBackends = loadTritonBackendsFromCatalog();

// Resolve the generator project root (two levels up from src/lib/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATOR_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Configuration error for invalid configuration values
 */
export class ConfigurationError extends Error {
    constructor(message, parameter, source) {
        super(message);
        this.name = 'ConfigurationError';
        this.parameter = parameter;
        this.source = source;
    }
}

/**
 * Validation error for invalid parameter values
 */
export class ValidationError extends Error {
    constructor(message, parameter, value) {
        super(message);
        this.name = 'ValidationError';
        this.parameter = parameter;
        this.value = value;
    }
}

export default class ConfigManager {
    constructor({ options, args }) {
        this.options = options || {};
        this.args = args || [];
        this.config = {};
        this.skipPrompts = false;
        this.autoPrompt = false;
        this.deploymentConfigResolver = new DeploymentConfigResolver();
        this.parameterMatrix = this._getParameterMatrix();
        this.schemaValidator = new ParameterSchemaValidator();
        this.mcpSources = {};
        this.mcpChoices = {};
        this._sourceManifest = [];
    }

    /**
     * Loads configuration from all sources according to precedence
     * @returns {Object} Merged configuration object
     */
    async loadConfiguration() {
        // Start with generator defaults
        this.config = this._getGeneratorDefaults();
        
        // Track explicit configuration (non-default values)
        this.explicitConfig = {};

        // Apply configurations in reverse precedence order (lowest to highest)
        await this._loadBootstrapConfig();
        await this._loadPackageJsonConfig();
        await this._loadCustomConfigFile();
        await this._loadCliConfigFile();
        await this._loadEnvironmentVariables();
        await this._loadCliArguments();
        await this._loadCliOptions();

        // Normalize deprecated values to canonical equivalents
        this._normalizeDeprecatedValues();

        // Query configured MCP servers for unbounded parameter values
        await this._queryMcpServers();

        // Check if we should skip prompts
        this.skipPrompts = this.options['skip-prompts'] || 
                          this._hasCompleteConfiguration();

        // Auto-prompt mode: fill defaults like skip-prompts, but prompt for truly missing values
        this.autoPrompt = this.options['auto-prompt'] === true;
        if (this.autoPrompt) {
            // In auto-prompt mode, we don't skip prompts entirely — we'll selectively prompt
            this.skipPrompts = false;

            // Pre-fill defaults for required parameters that can be auto-generated.
            // Promote these into explicitConfig so the wizard skips them.
            // This means the wizard only prompts for values that are truly ambiguous.
            this._fillAutoPromptDefaults();
        }

        return this.config;
    }

    /**
     * Checks if prompting should be skipped
     * @returns {boolean}
     */
    shouldSkipPrompts() {
        return this.skipPrompts;
    }

    /**
     * Gets the final configuration, filling in any missing values with prompts
     * @param {Object} promptAnswers - Answers from prompting phase
     * @returns {Object} Complete configuration
     */
    getFinalConfiguration(promptAnswers = {}) {
        // Prompting has lowest precedence, so only use for missing values
        const finalConfig = { ...promptAnswers };
        
        // Override with explicit configuration (not defaults)
        const explicitConfig = this.getExplicitConfiguration();
        Object.keys(explicitConfig).forEach(key => {
            if (explicitConfig[key] !== undefined && explicitConfig[key] !== null) {
                finalConfig[key] = explicitConfig[key];
            }
        });

        // Fill in missing values with defaults from this.config
        Object.keys(this.config).forEach(key => {
            if (finalConfig[key] === undefined || finalConfig[key] === null) {
                finalConfig[key] = this.config[key];
            }
        });

        // Ensure env var collections are properly merged (CLI over config file over registry)
        // this.config already has the fully merged result from all sources
        if (this.config.modelEnvVars && typeof this.config.modelEnvVars === 'object') {
            finalConfig.modelEnvVars = { ...this.config.modelEnvVars };
        }
        if (this.config.serverEnvVars && typeof this.config.serverEnvVars === 'object') {
            finalConfig.serverEnvVars = { ...this.config.serverEnvVars };
        }

        // Ensure all parameters from the matrix are included in final config
        // This is important for optional parameters that might be null
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (finalConfig[param] === undefined) {
                finalConfig[param] = this.config[param] || config.default;
            }
        });

        // Derive architecture, backend, and engine from deploymentConfig using DeploymentConfigResolver.
        // In prompted mode the PromptRunner may do this, but in --skip-prompts
        // mode we need to do it here so the values are available for downstream logic.
        if (finalConfig.deploymentConfig) {
            const parts = this.deploymentConfigResolver.decompose(finalConfig.deploymentConfig);
            finalConfig.architecture = parts.architecture;
            finalConfig.backend = parts.backend;
            // For http architecture, engine comes from the --engine CLI option or prompt
            if (parts.architecture === 'http') {
                if (!finalConfig.engine) {
                    finalConfig.engine = parts.engine;
                }
            } else {
                finalConfig.engine = parts.engine;
            }
        }

        // When skipping prompts or in auto-prompt mode, provide reasonable defaults for missing required parameters
        if (this.skipPrompts || this.autoPrompt) {
            Object.entries(this.parameterMatrix).forEach(([param, config]) => {
                if (config.required && 
                    (finalConfig[param] === null || finalConfig[param] === undefined)) {
                    
                    // Provide reasonable defaults for missing required parameters
                    if (param === 'modelFormat') {
                        // Infer model format from architecture/engine (skip for transformers/triton)
                        const architecture = finalConfig.architecture || 'http';
                        if (architecture === 'http') {
                            const engine = finalConfig.engine || 'sklearn';
                            const formatMap = {
                                'sklearn': 'pkl',
                                'xgboost': 'json',
                                'tensorflow': 'keras'
                            };
                            finalConfig[param] = formatMap[engine] || 'pkl';
                        }
                    } else if (param === 'instanceType') {
                        // Default to ml.m5.large for http, ml.g5.xlarge for transformers/triton
                        const architecture = finalConfig.architecture || 'http';
                        finalConfig[param] = architecture === 'http' ? 'ml.m5.large' : 'ml.g5.xlarge';
                    } else if (param === 'projectName') {
                        // Generate project name
                        finalConfig[param] = this._generateProjectName(finalConfig.architecture);
                    } else if (config.default !== null) {
                        // Use default value if available
                        finalConfig[param] = config.default;
                    }
                }
            });
        }

        // Always generate values for non-promptable required parameters that are missing
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (config.required && !config.promptable && 
                (finalConfig[param] === null || finalConfig[param] === undefined)) {
                
                if (param === 'projectName') {
                    // Generate project name based on architecture or use default
                    finalConfig[param] = this._generateProjectName(finalConfig.architecture);
                } else if (config.default !== null) {
                    // Use default value if available
                    finalConfig[param] = config.default;
                }
            }
        });

        // Apply architecture-specific overrides
        if (finalConfig.architecture === 'transformers') {
            finalConfig.includeSampleModel = false;
        }
        if (finalConfig.architecture === 'diffusors') {
            finalConfig.includeSampleModel = false;
        }
        if (finalConfig.architecture === 'triton') {
            const backendMeta = tritonBackends[finalConfig.backend];
            if (!backendMeta || !backendMeta.supportsSampleModel) {
                finalConfig.includeSampleModel = false;
            }
        }
        
        // Set destinationDir based on projectName if not explicitly provided via --project-dir
        // This matches standard CLI behavior:
        // - `ml-container-creator my-app` creates `./my-app/` subdirectory
        // - `ml-container-creator my-app --project-dir /tmp` uses `/tmp/` directly
        // - `yo generator --project-name my-app` uses current directory (option, not argument)
        //
        // Only create subdirectory when:
        // 1. Project name was provided as a positional CLI argument (not option/config)
        // 2. --project-dir was NOT explicitly provided
        // 3. destinationDir is still the default '.'
        
        const projectNameFromArgument = this.projectNameFromArgument || false;
        const explicitDestination = explicitConfig.destinationDir;
        
        if (projectNameFromArgument && 
            !explicitDestination && 
            finalConfig.destinationDir === '.') {
            finalConfig.destinationDir = `./${finalConfig.projectName}`;
        }
        
        // Generate CodeBuild project name if buildTarget is codebuild
        if ((finalConfig.buildTarget === 'codebuild' || finalConfig.deployTarget === 'codebuild') && !finalConfig.codebuildProjectName) {
            finalConfig.codebuildProjectName = this._generateCodeBuildProjectName(
                finalConfig.projectName, 
                finalConfig.architecture
            );
        }

        // Add build timestamp if not present
        if (!finalConfig.buildTimestamp) {
            finalConfig.buildTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        }

        // Resolve HF_TOKEN environment variable references
        // This happens after all configuration sources have been merged
        if (finalConfig.hfToken) {
            finalConfig.hfToken = this._resolveHfToken(finalConfig.hfToken);
        }

        // Map awsRoleArn to roleArn for templates
        if (finalConfig.awsRoleArn) {
            finalConfig.roleArn = finalConfig.awsRoleArn;
            delete finalConfig.awsRoleArn;
        }

        return finalConfig;
    }

    /**
     * Gets only the explicit configuration (not defaults) for prompting
     * @returns {Object} Explicit configuration only
     */
    getExplicitConfiguration() {
        return this.explicitConfig || {};
    }

    /**
     * Gets the MCP source tracking information
     * @returns {Object} Map of parameter names to their MCP source info
     */
    getMcpSources() {
        return this.mcpSources || {};
    }

    /**
     * Returns the complete configuration object with all parameter families
     * separated into named collections for validation layer consumption.
     * @returns {{
     *   core: Object,
     *   endpointConfig: Object,
     *   icConfig: Object,
     *   modelEnvVars: Object,
     *   serverEnvVars: Object,
     *   manifest: Array<{param: string, value: *, source: string}>
     * }}
     */
    getFullConfiguration() {
        const endpointParams = [
            'endpointInitialInstanceCount',
            'endpointDataCapturePercent',
            'endpointVariantName',
            'endpointVolumeSize'
        ];
        const icParams = [
            'icCpuCount',
            'icMemorySize',
            'icGpuCount',
            'icCopyCount',
            'icModelWeight'
        ];

        const endpointConfig = {};
        for (const param of endpointParams) {
            const shortKey = param.replace('endpoint', '');
            const key = shortKey.charAt(0).toLowerCase() + shortKey.slice(1);
            if (this.config[param] !== undefined && this.config[param] !== null) {
                endpointConfig[key] = this.config[param];
            }
        }

        const icConfig = {};
        for (const param of icParams) {
            const shortKey = param.replace('ic', '');
            const key = shortKey.charAt(0).toLowerCase() + shortKey.slice(1);
            if (this.config[param] !== undefined && this.config[param] !== null) {
                icConfig[key] = this.config[param];
            }
        }

        // Core parameters: everything that is NOT endpoint, iC, or env var collections
        const excludedFromCore = new Set([
            ...endpointParams,
            ...icParams,
            'modelEnvVars',
            'serverEnvVars'
        ]);
        const core = {};
        for (const [key, value] of Object.entries(this.config)) {
            if (!excludedFromCore.has(key) && key !== '_sourceManifest') {
                core[key] = value;
            }
        }

        return {
            core,
            endpointConfig,
            icConfig,
            modelEnvVars: { ...(this.config.modelEnvVars || {}) },
            serverEnvVars: { ...(this.config.serverEnvVars || {}) },
            manifest: [...this._sourceManifest]
        };
    }

    /**
     * Merge registry-provided environment variables with CLI-provided values.
     * CLI values take precedence over registry values for the same key.
     * Requirements: 3.3, 4.3
     * @param {Object} registryModelEnvVars - Model env vars from registry
     * @param {Object} registryServerEnvVars - Server env vars from registry
     */
    mergeRegistryEnvVars(registryModelEnvVars = {}, registryServerEnvVars = {}) {
        // Initialize collections if needed
        if (!this.config.modelEnvVars || typeof this.config.modelEnvVars !== 'object') {
            this.config.modelEnvVars = {};
        }
        if (!this.config.serverEnvVars || typeof this.config.serverEnvVars !== 'object') {
            this.config.serverEnvVars = {};
        }

        // Merge registry model env vars (CLI takes precedence)
        Object.entries(registryModelEnvVars).forEach(([key, value]) => {
            if (!(key in this.config.modelEnvVars)) {
                this.config.modelEnvVars[key] = value;
                this._recordSource(`modelEnvVars.${key}`, value, 'registry');
            }
        });

        // Merge registry server env vars (CLI takes precedence)
        Object.entries(registryServerEnvVars).forEach(([key, value]) => {
            if (!(key in this.config.serverEnvVars)) {
                this.config.serverEnvVars[key] = value;
                this._recordSource(`serverEnvVars.${key}`, value, 'registry');
            }
        });
    }

    /**
     * Gets the parameter matrix configuration
     * @private
     */
    _getParameterMatrix() {
        return {
            deploymentConfig: {
                cliOption: 'deployment-config',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: true,
                default: null,
                valueSpace: 'bounded'
            },
            architecture: {
                cliOption: null,
                envVar: null,
                configFile: false,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: null,
                valueSpace: 'bounded'
            },
            backend: {
                cliOption: null,
                envVar: null,
                configFile: false,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: null,
                valueSpace: 'bounded'
            },
            engine: {
                cliOption: 'engine',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'bounded'
            },
            modelFormat: {
                cliOption: 'model-format',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: true,
                default: null,
                valueSpace: 'bounded'
            },
            modelName: {
                cliOption: 'model-name',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 'openai/gpt-oss-20b',
                valueSpace: 'bounded'
            },
            includeSampleModel: {
                cliOption: 'include-sample',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: true,
                default: false,
                valueSpace: 'bounded'
            },
            includeTesting: {
                cliOption: 'include-testing',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: true,
                valueSpace: 'bounded'
            },
            instanceType: {
                cliOption: 'instance-type',
                envVar: 'ML_INSTANCE_TYPE',
                configFile: true,
                packageJson: false,
                mcp: true,
                promptable: true,
                required: true,
                default: null,
                valueSpace: 'unbounded'
            },
            awsRegion: {
                cliOption: 'region',
                envVar: 'AWS_REGION',
                ambientEnvVar: true, // AWS_REGION is commonly set in shells; treat as default, not explicit override
                configFile: true,
                packageJson: true,
                mcp: true,
                promptable: true,
                required: false,
                default: 'us-east-1',
                valueSpace: 'unbounded'
            },
            awsRoleArn: {
                cliOption: 'role-arn',
                envVar: 'AWS_ROLE',
                configFile: true,
                packageJson: true,
                mcp: true,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'unbounded'
            },
            configFile: {
                cliOption: 'config',
                envVar: 'ML_CONTAINER_CREATOR_CONFIG',
                configFile: false,
                packageJson: true,
                mcp: false,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'bounded'
            },
            skipPrompts: {
                cliOption: 'skip-prompts',
                envVar: null,
                configFile: false,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: false,
                valueSpace: 'bounded'
            },
            projectName: {
                cliOption: 'project-name',
                envVar: null,
                configFile: true,
                packageJson: true,
                mcp: false,
                promptable: false,
                required: true,
                default: null,
                valueSpace: 'bounded'
            },
            destinationDir: {
                cliOption: 'project-dir',
                envVar: null,
                configFile: true,
                packageJson: true,
                mcp: false,
                promptable: false,
                required: true,
                default: '.',
                valueSpace: 'bounded'
            },
            buildTarget: {
                cliOption: 'build-target',
                envVar: 'ML_BUILD_TARGET',
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: true,
                default: 'codebuild',
                valueSpace: 'bounded'
            },
            codebuildComputeType: {
                cliOption: 'codebuild-compute-type',
                envVar: 'ML_CODEBUILD_COMPUTE_TYPE',
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 'BUILD_GENERAL1_MEDIUM',
                valueSpace: 'bounded'
            },
            codebuildProjectName: {
                cliOption: null,
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: null,
                valueSpace: 'bounded'
            },
            hfToken: {
                cliOption: 'hf-token',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'bounded'
            },
            deploymentTarget: {
                cliOption: 'deployment-target',
                envVar: 'ML_DEPLOYMENT_TARGET',
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: true,
                default: 'realtime-inference',
                valueSpace: 'bounded'
            },
            hyperPodCluster: {
                cliOption: 'hyperpod-cluster',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: true,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'unbounded'
            },
            hyperPodNamespace: {
                cliOption: 'hyperpod-namespace',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 'default',
                valueSpace: 'bounded'
            },
            hyperPodReplicas: {
                cliOption: 'hyperpod-replicas',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 1,
                valueSpace: 'bounded'
            },
            fsxVolumeHandle: {
                cliOption: 'fsx-volume-handle',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'bounded'
            },
            baseImage: {
                cliOption: 'base-image',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: true,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'unbounded'
            },
            asyncS3OutputPath: {
                cliOption: 'async-s3-output-path',
                envVar: 'ML_ASYNC_S3_OUTPUT_PATH',
                configFile: true,
                packageJson: false,
                mcp: true,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'unbounded'
            },
            asyncSnsSuccessTopic: {
                cliOption: 'async-sns-success-topic',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: true,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'unbounded'
            },
            asyncSnsErrorTopic: {
                cliOption: 'async-sns-error-topic',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: true,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'unbounded'
            },
            asyncMaxConcurrentInvocations: {
                cliOption: 'async-max-concurrent',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 1,
                valueSpace: 'bounded'
            },
            batchInputPath: {
                cliOption: 'batch-input-path',
                envVar: 'ML_BATCH_INPUT_PATH',
                configFile: true,
                packageJson: false,
                mcp: true,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'unbounded'
            },
            batchOutputPath: {
                cliOption: 'batch-output-path',
                envVar: 'ML_BATCH_OUTPUT_PATH',
                configFile: true,
                packageJson: false,
                mcp: true,
                promptable: true,
                required: false,
                default: null,
                valueSpace: 'unbounded'
            },
            batchInstanceCount: {
                cliOption: 'batch-instance-count',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 1,
                valueSpace: 'bounded'
            },
            batchSplitType: {
                cliOption: 'batch-split-type',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 'Line',
                valueSpace: 'bounded'
            },
            batchStrategy: {
                cliOption: 'batch-strategy',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 'MultiRecord',
                valueSpace: 'bounded'
            },
            batchJoinSource: {
                cliOption: 'batch-join-source',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 'None',
                valueSpace: 'bounded'
            },
            batchMaxConcurrentTransforms: {
                cliOption: 'batch-max-concurrent',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 1,
                valueSpace: 'bounded'
            },
            batchMaxPayloadInMB: {
                cliOption: 'batch-max-payload',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: true,
                required: false,
                default: 6,
                valueSpace: 'bounded'
            },
            endpointInitialInstanceCount: {
                cliOption: 'endpoint-initial-instance-count',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: 1,
                valueSpace: 'bounded',
                schemaValidated: true
            },
            endpointDataCapturePercent: {
                cliOption: 'endpoint-data-capture-percent',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: 0,
                valueSpace: 'bounded',
                schemaValidated: true
            },
            endpointVariantName: {
                cliOption: 'endpoint-variant-name',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: 'AllTraffic',
                valueSpace: 'bounded',
                schemaValidated: true
            },
            endpointVolumeSize: {
                cliOption: 'endpoint-volume-size',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: null,
                valueSpace: 'bounded',
                schemaValidated: true
            },
            icCpuCount: {
                cliOption: 'ic-cpu-count',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: null,
                valueSpace: 'bounded',
                schemaValidated: true
            },
            icMemorySize: {
                cliOption: 'ic-memory-size',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: null,
                valueSpace: 'bounded',
                schemaValidated: true
            },
            icGpuCount: {
                cliOption: 'ic-gpu-count',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: null,
                valueSpace: 'bounded',
                schemaValidated: true
            },
            icCopyCount: {
                cliOption: 'ic-copy-count',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: 1,
                valueSpace: 'bounded',
                schemaValidated: true
            },
            icModelWeight: {
                cliOption: 'ic-model-weight',
                envVar: null,
                configFile: true,
                packageJson: false,
                mcp: false,
                promptable: false,
                required: false,
                default: 1.0,
                valueSpace: 'bounded',
                schemaValidated: true
            }
        };
    }

    /**
     * Checks if a parameter source is supported according to the matrix
     * @private
     */
    _isSourceSupported(parameter, source) {
        const paramConfig = this.parameterMatrix[parameter];
        if (!paramConfig) return false;
        
        switch (source) {
        case 'envVar':
            return paramConfig.envVar !== null;
        case 'configFile':
            return paramConfig.configFile === true;
        case 'packageJson':
            return paramConfig.packageJson === true;
        case 'cliOption':
            return paramConfig.cliOption !== null;
        default:
            return false;
        }
    }

    /**
     * Parses a value according to its expected type
     * @private
     */
    _parseValue(parameter, value) {
        // Handle boolean parameters
        if (parameter === 'includeSampleModel' || parameter === 'includeTesting' || parameter === 'skipPrompts') {
            return value === true || value === 'true';
        }
        
        // Handle array parameters (if any in the future)
        if (parameter === 'testTypes' && typeof value === 'string') {
            return value.split(',').map(s => s.trim());
        }
        
        // Coerce numeric parameters from CLI strings to numbers.
        // CLI always passes values as strings; we coerce when:
        // 1. The default is already a number (e.g. endpointInitialInstanceCount default: 1)
        // 2. The parameter is schema-validated, default is null, and the value is purely numeric
        //    (string defaults like 'AllTraffic' won't match since their default type is string)
        const paramConfig = this.parameterMatrix[parameter];
        if (paramConfig && typeof value === 'string') {
            const hasNumericDefault = (typeof paramConfig.default === 'number');
            const isNullDefaultNumericParam = (paramConfig.default === null &&
                paramConfig.schemaValidated &&
                /^-?\d+(\.\d+)?$/.test(value));
            if (hasNumericDefault || isNullDefaultNumericParam) {
                const num = Number(value);
                if (!isNaN(num)) {
                    return num;
                }
            }
        }
        
        // Handle string parameters
        return value;
    }
    /**
     * Generator defaults (lowest precedence before prompting)
     * @private
     */
    _getGeneratorDefaults() {
        const defaults = {};
        
        // Apply defaults from parameter matrix
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (config.default !== null) {
                defaults[param] = config.default;
                this._recordSource(param, config.default, 'default');
            } else {
                defaults[param] = null;
            }
        });

        // Add legacy parameters that aren't in the matrix but are still used internally
        defaults.testTypes = null;
        defaults.includeTesting = true;

        // Collection parameters for env vars (not in matrix, handled separately)
        defaults.modelEnvVars = {};
        defaults.serverEnvVars = {};

        return defaults;
    }

    /**
     * Load from bootstrap config (~/.ml-container-creator/config.json)
     * Reads the active profile and maps its keys to ConfigManager config keys.
     * Sits above generator defaults but below all other configuration sources.
     * @private
     */
    async _loadBootstrapConfig() {
        try {
            const bootstrapConfig = new BootstrapConfig();
            const activeProfile = bootstrapConfig.getActiveProfile();
            if (!activeProfile) {
                return;
            }

            const profileConfig = activeProfile.config;
            const mapped = {};

            if (profileConfig.roleArn) {
                mapped.awsRoleArn = profileConfig.roleArn;
            }
            if (profileConfig.awsRegion) {
                mapped.awsRegion = profileConfig.awsRegion;
            }
            if (profileConfig.awsProfile) {
                mapped.awsProfile = profileConfig.awsProfile;
            }

            this._mergeConfig(mapped);
        } catch (error) {
            // Ignore errors — config file may not exist or may be malformed
        }
    }

    /**
     * Load from package.json "ml-container-creator" section (filtered by matrix)
     * @private
     */
    async _loadPackageJsonConfig() {
        try {
            const packageJsonPath = path.resolve(process.cwd(), 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                const generatorConfig = packageJson['ml-container-creator'];
                if (generatorConfig) {
                    // Filter config to only include parameters supported in package.json
                    const filteredConfig = {};
                    Object.entries(generatorConfig).forEach(([key, value]) => {
                        if (this._isSourceSupported(key, 'packageJson')) {
                            filteredConfig[key] = this._parseValue(key, value);
                        }
                    });
                    this._mergeConfig(filteredConfig);
                }
            }
        } catch (error) {
            // Ignore errors - this is optional
        }
    }

    /**
     * Load from config/mcp.json
     * @private
     */
    async _loadCustomConfigFile() {
        try {
            const configPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this._mergeConfig(config);
            }
        } catch (error) {
            // Ignore errors - this is optional
        }
    }

    /**
     * Load from CLI --config file or --config-json inline string.
     *
     * --config-json accepts either:
     *   1. An inline JSON string: --config-json='{"deploymentConfig":"transformers-vllm"}'
     *   2. A path to a JSON file: --config-json=config.json
     *
     * When both --config and --config-json are provided, --config-json wins
     * (it is applied second, so its values override --config values).
     *
     * Also checks the ML_CONTAINER_CREATOR_CONFIG environment variable as a
     * fallback for --config.
     *
     * @private
     */
    async _loadCliConfigFile() {
        let configFile = this.options.config;
        
        // Check environment variable if CLI option not provided
        if (!configFile && process.env.ML_CONTAINER_CREATOR_CONFIG) {
            configFile = process.env.ML_CONTAINER_CREATOR_CONFIG;
        }
        
        if (configFile) {
            this._loadConfigFromFile(configFile);
        }

        // --config-json: inline JSON string or path to a JSON file
        const configJson = this.options['config-json'];
        if (configJson) {
            this._loadConfigFromJson(configJson);
        }
    }

    /**
     * Load configuration from a JSON file path.
     * @param {string} configFile - Path to the JSON config file
     * @private
     */
    _loadConfigFromFile(configFile) {
        try {
            const configPath = path.resolve(configFile);
            if (!fs.existsSync(configPath)) {
                throw new ConfigurationError(
                    `Config file not found: ${configPath}`,
                    'configFile',
                    'cli'
                );
            }
            
            // Check if file is readable
            try {
                fs.accessSync(configPath, fs.constants.R_OK);
            } catch (accessError) {
                throw new ConfigurationError(
                    `Config file is not readable: ${configPath}`,
                    'configFile',
                    'cli'
                );
            }
            
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            this._applyJsonConfig(config);
        } catch (error) {
            if (error instanceof ConfigurationError) {
                throw error;
            } else {
                throw new ConfigurationError(
                    `Failed to load config file ${configFile}: ${error.message}`,
                    'configFile',
                    'cli'
                );
            }
        }
    }

    /**
     * Load configuration from an inline JSON string or a JSON file path.
     * Tries to parse as JSON first; if that fails and the value looks like
     * a file path, reads and parses the file instead.
     *
     * @param {string} configJson - Inline JSON string or path to a JSON file
     * @private
     */
    _loadConfigFromJson(configJson) {
        let config;
        try {
            config = JSON.parse(configJson);
        } catch {
            // Not valid JSON — try as a file path
            try {
                const configPath = path.resolve(configJson);
                if (!fs.existsSync(configPath)) {
                    throw new ConfigurationError(
                        `--config-json value is not valid JSON and file not found: ${configJson}`,
                        'configJson',
                        'cli'
                    );
                }
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (error) {
                if (error instanceof ConfigurationError) {
                    throw error;
                }
                throw new ConfigurationError(
                    `Failed to parse --config-json: ${error.message}`,
                    'configJson',
                    'cli'
                );
            }
        }
        this._applyJsonConfig(config);
    }

    /**
     * Apply a parsed JSON config object, filtering to supported parameters.
     * Handles nested objects for endpoint, iC, and env var configuration.
     * @param {Object} config - Parsed JSON config object
     * @private
     */
    _applyJsonConfig(config) {
        const filteredConfig = {};
        Object.entries(config).forEach(([key, value]) => {
            // Handle nested endpointConfig object
            if (key === 'endpointConfig' && typeof value === 'object' && value !== null) {
                const endpointMapping = {
                    initialInstanceCount: 'endpointInitialInstanceCount',
                    dataCapturePercent: 'endpointDataCapturePercent',
                    variantName: 'endpointVariantName',
                    volumeSize: 'endpointVolumeSize'
                };
                Object.entries(value).forEach(([nestedKey, nestedValue]) => {
                    const flatKey = endpointMapping[nestedKey];
                    if (flatKey && this._isSourceSupported(flatKey, 'configFile')) {
                        filteredConfig[flatKey] = nestedValue;
                        this._recordSource(flatKey, nestedValue, 'config-file');
                    }
                });
                return;
            }

            // Handle nested icConfig object
            if (key === 'icConfig' && typeof value === 'object' && value !== null) {
                const icMapping = {
                    cpuCount: 'icCpuCount',
                    memorySize: 'icMemorySize',
                    gpuCount: 'icGpuCount',
                    copyCount: 'icCopyCount',
                    modelWeight: 'icModelWeight'
                };
                Object.entries(value).forEach(([nestedKey, nestedValue]) => {
                    const flatKey = icMapping[nestedKey];
                    if (flatKey && this._isSourceSupported(flatKey, 'configFile')) {
                        filteredConfig[flatKey] = nestedValue;
                        this._recordSource(flatKey, nestedValue, 'config-file');
                    }
                });
                return;
            }

            // Handle modelEnvVars object (merge with CLI, CLI takes precedence)
            if (key === 'modelEnvVars' && typeof value === 'object' && value !== null) {
                if (!this.config.modelEnvVars) {
                    this.config.modelEnvVars = {};
                }
                // Only set keys not already provided by CLI (CLI has higher precedence)
                const cliModelEnvVars = (this.explicitConfig && this.explicitConfig.modelEnvVars) || {};
                Object.entries(value).forEach(([envKey, envValue]) => {
                    if (!(envKey in cliModelEnvVars)) {
                        this.config.modelEnvVars[envKey] = envValue;
                        this._recordSource(`modelEnvVars.${envKey}`, envValue, 'config-file');
                    }
                });
                return;
            }

            // Handle serverEnvVars object (merge with CLI, CLI takes precedence)
            if (key === 'serverEnvVars' && typeof value === 'object' && value !== null) {
                if (!this.config.serverEnvVars) {
                    this.config.serverEnvVars = {};
                }
                // Only set keys not already provided by CLI (CLI has higher precedence)
                const cliServerEnvVars = (this.explicitConfig && this.explicitConfig.serverEnvVars) || {};
                Object.entries(value).forEach(([envKey, envValue]) => {
                    if (!(envKey in cliServerEnvVars)) {
                        this.config.serverEnvVars[envKey] = envValue;
                        this._recordSource(`serverEnvVars.${envKey}`, envValue, 'config-file');
                    }
                });
                return;
            }

            if (this._isSourceSupported(key, 'configFile')) {
                filteredConfig[key] = this._parseValue(key, value);
                this._recordSource(key, this._parseValue(key, value), 'config-file');
            }
        });
        this._mergeConfig(filteredConfig);
    }

    /**
     * Load from environment variables (filtered by matrix)
     * @private
     */
    async _loadEnvironmentVariables() {
        // Build environment variable mapping from parameter matrix
        const envMapping = {};
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (config.envVar) {
                envMapping[config.envVar] = { param, ambient: config.ambientEnvVar === true };
            }
        });

        Object.entries(envMapping).forEach(([envVar, { param: configKey, ambient }]) => {
            const value = process.env[envVar];
            if (value !== undefined && value !== '' && this._isSourceSupported(configKey, 'envVar')) {
                this.config[configKey] = this._parseValue(configKey, value);
                this._recordSource(configKey, this._parseValue(configKey, value), 'env-var');
                // Track as explicit configuration — unless the env var is ambient
                // (e.g. AWS_REGION is commonly set in shells as a default, not an override)
                if (!ambient) {
                    if (!this.explicitConfig) {
                        this.explicitConfig = {};
                    }
                    this.explicitConfig[configKey] = this._parseValue(configKey, value);
                }
            }
        });
    }

    /**
     * Load from CLI arguments (positional)
     * @private
     */
    async _loadCliArguments() {
        // First positional argument is project name
        if (this.args && this.args.length > 0) {
            this.config.projectName = this.args[0];
            // Track as explicit configuration
            if (!this.explicitConfig) {
                this.explicitConfig = {};
            }
            this.explicitConfig.projectName = this.args[0];
            // Track that project name came from positional argument (for subdirectory creation)
            this.projectNameFromArgument = true;
        }
    }

    /**
     * Load from CLI options (highest precedence, filtered by matrix)
     * @private
     */
    async _loadCliOptions() {
        const options = this.options;
        
        // Build CLI option mapping from parameter matrix
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (config.cliOption && options[config.cliOption] !== undefined) {
                this.config[param] = this._parseValue(param, options[config.cliOption]);
                this._recordSource(param, this._parseValue(param, options[config.cliOption]), 'cli');
                // Track as explicit configuration
                if (!this.explicitConfig) {
                    this.explicitConfig = {};
                }
                this.explicitConfig[param] = this._parseValue(param, options[config.cliOption]);
            }
        });

        // Parse --model-env KEY=VALUE pairs
        this._parseEnvVarOptions('model-env', 'modelEnvVars');

        // Parse --server-env KEY=VALUE pairs
        this._parseEnvVarOptions('server-env', 'serverEnvVars');
    }

    /**
     * Normalizes deprecated parameter values to their canonical equivalents.
     * Prints a deprecation warning when a deprecated value is encountered.
     * @private
     */
    _normalizeDeprecatedValues() {
        const DEPRECATED_VALUES = {
            deploymentTarget: {
                'managed-inference': {
                    canonical: 'realtime-inference',
                    message: '--deployment-target=managed-inference is deprecated, use realtime-inference instead'
                }
            }
        };

        for (const [param, aliases] of Object.entries(DEPRECATED_VALUES)) {
            const currentValue = this.config[param];
            if (currentValue && aliases[currentValue]) {
                const { canonical, message } = aliases[currentValue];
                console.log(`\n⚠️  Deprecation: ${message}`);
                this.config[param] = canonical;
                // Also update explicit config if it was set there
                if (this.explicitConfig && this.explicitConfig[param] === currentValue) {
                    this.explicitConfig[param] = canonical;
                }
            }
        }
    }

    /**
     * Parse --model-env or --server-env CLI options into env var collections.
     * Supports both array (multiple flags) and single string values.
     * Performs eager format validation at parse time.
     * @param {string} optionName - CLI option name (e.g., 'model-env')
     * @param {string} configKey - Config key to store results (e.g., 'modelEnvVars')
     * @private
     */
    _parseEnvVarOptions(optionName, configKey) {
        const rawValue = this.options[optionName];
        if (rawValue === undefined || rawValue === null) {
            return;
        }

        // Normalize to array (may receive a single string or an array)
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];

        // Initialize collection if not already present
        if (!this.config[configKey] || typeof this.config[configKey] !== 'object') {
            this.config[configKey] = {};
        }

        for (const entry of values) {
            if (typeof entry !== 'string' || entry.trim() === '') {
                continue;
            }
            const { key, value } = parseKeyValue(entry);
            this.config[configKey][key] = value;
            this._recordSource(`${configKey}.${key}`, value, 'cli');
        }

        // Track as explicit configuration
        if (Object.keys(this.config[configKey]).length > 0) {
            if (!this.explicitConfig) {
                this.explicitConfig = {};
            }
            this.explicitConfig[configKey] = { ...this.config[configKey] };
        }
    }

    /**
     * Query configured MCP servers for unbounded parameter values.
     * Reads mcpServers from config/mcp.json, spawns each one,
     * and stores results in mcpSources/mcpChoices.
     * @private
     */
    async _queryMcpServers() {
        // No-op: MCP queries now happen on-demand during prompting
        // via queryMcpServer(). This method is kept for backward compatibility.
    }

    /**
     * Query a single named MCP server on-demand with the given context.
     * Stores results in mcpSources/mcpChoices and returns the result.
     * @param {string} serverName - Name of the server in mcpServers config
     * @param {object} context - Context to pass to the MCP tool (e.g. { regionSearch: 'europe' })
     * @returns {Promise<{ values: object, choices: object } | null>}
     */
    async queryMcpServer(serverName, context = {}) {
        let mcpServerConfigs;
        try {
            const configPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (!fs.existsSync(configPath)) return null;
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            mcpServerConfigs = config.mcpServers;
        } catch {
            return null;
        }

        if (!mcpServerConfigs || !mcpServerConfigs[serverName]) return null;

        const smart = this.options.smart === true;
        const discover = this.options.discover === true;
        const serverConfig = mcpServerConfigs[serverName];

        // Build a custom McpClient that passes context through
        const client = new McpClient(serverConfig, {
            timeout: 15000,
            parameterMatrix: this.parameterMatrix,
            smart,
            discover
        });

        // Override the _buildContext to merge our search context
        const origBuildContext = client._buildContext.bind(client);
        client._buildContext = () => ({ ...origBuildContext(), ...context });

        try {
            const result = await client.query();
            await client.close();

            if (!result) {
                const diag = client.getDiagnosticMessage();
                if (diag) console.log(`   ⚠️  ${serverName}: ${diag}`);
                return null;
            }

            // Store values
            for (const [param, value] of Object.entries(result.values || {})) {
                const paramConfig = this.parameterMatrix[param];
                if (paramConfig && paramConfig.valueSpace === 'unbounded' && paramConfig.mcp === true) {
                    this.mcpSources[param] = {
                        server: serverName,
                        value,
                        timestamp: new Date().toISOString()
                    };
                }
            }

            // Store choices
            for (const [param, choices] of Object.entries(result.choices || {})) {
                const paramConfig = this.parameterMatrix[param];
                if (paramConfig && paramConfig.valueSpace === 'unbounded' && paramConfig.mcp === true && Array.isArray(choices)) {
                    this.mcpChoices[param] = choices;
                }
            }

            return result;
        } catch (err) {
            await client.close().catch(() => {});
            console.log(`   ⚠️  ${serverName}: ${err.message}`);
            return null;
        }
    }

    /**
     * Get the names of configured MCP servers.
     * @returns {string[]}
     */
    getMcpServerNames() {
        try {
            const configPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (!fs.existsSync(configPath)) return [];
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return Object.keys(config.mcpServers || {});
        } catch {
            return [];
        }
    }

    /**
     * Merges configuration object into current config
     * @private
     */
    _mergeConfig(newConfig) {
        Object.keys(newConfig).forEach(key => {
            if (newConfig[key] !== undefined && newConfig[key] !== null) {
                this.config[key] = newConfig[key];
                // Track as explicit configuration (not default)
                if (!this.explicitConfig) {
                    this.explicitConfig = {};
                }
                this.explicitConfig[key] = newConfig[key];
            }
        });
    }

    /**
     * Records a source manifest entry for a parameter.
     * If the parameter already has an entry, it is replaced (higher-precedence wins).
     * @param {string} param - Parameter name
     * @param {*} value - Parameter value
     * @param {string} source - Source identifier (cli, config-file, registry, env-var, default)
     * @private
     */
    _recordSource(param, value, source) {
        const existingIndex = this._sourceManifest.findIndex(entry => entry.param === param);
        if (existingIndex >= 0) {
            this._sourceManifest[existingIndex] = { param, value, source };
        } else {
            this._sourceManifest.push({ param, value, source });
        }
    }

    /**
     * Checks if we have enough configuration to skip prompts
     * Non-promptable parameters are not required for this check since they can be auto-generated
     * @private
     */
    _hasCompleteConfiguration() {
        // Only check promptable required parameters
        const promptableRequired = Object.entries(this.parameterMatrix)
            .filter(([_param, config]) => config.required && config.promptable)
            .map(([param]) => param);
        
        // Special case: modelFormat is not required for transformers/triton/diffusors architectures
        const requiredForConfig = promptableRequired.filter(param => {
            if (param === 'modelFormat') {
                const architecture = this.config.architecture;
                if (architecture === 'transformers' || architecture === 'triton' || architecture === 'diffusors') {
                    return false;
                }
            }
            return true;
        });
        
        return requiredForConfig.every(key => 
            this.config[key] !== undefined && this.config[key] !== null
        );
    }

    /**
     * Validates the current configuration against the parameter matrix
     * Only reports errors for parameters that cannot be resolved through prompting or auto-generation
     * @returns {Array} Array of validation errors
     */
    validateConfiguration() {
        const errors = [];

        // Old-format deployment-config migration messages
        const oldFormatMigration = {
            'sklearn-flask': 'Use --deployment-config=http-flask --engine=sklearn instead',
            'sklearn-fastapi': 'Use --deployment-config=http-fastapi --engine=sklearn instead',
            'xgboost-flask': 'Use --deployment-config=http-flask --engine=xgboost instead',
            'xgboost-fastapi': 'Use --deployment-config=http-fastapi --engine=xgboost instead',
            'tensorflow-flask': 'Use --deployment-config=http-flask --engine=tensorflow instead',
            'tensorflow-fastapi': 'Use --deployment-config=http-fastapi --engine=tensorflow instead'
        };

        // Validate deployment-config
        if (this.config.deploymentConfig) {
            const migrationMsg = oldFormatMigration[this.config.deploymentConfig];
            if (migrationMsg) {
                errors.push(`Unsupported deployment-config: ${this.config.deploymentConfig}. This value has been replaced. ${migrationMsg}`);
            } else if (!this.deploymentConfigResolver.isValid(this.config.deploymentConfig)) {
                const valid = this.deploymentConfigResolver.getAllConfigs().join(', ');
                errors.push(`Unsupported deployment-config: ${this.config.deploymentConfig}. Valid configs: ${valid}`);
            }
        }

        // Validate engine (only valid for http architecture)
        if (this.config.engine) {
            const validEngines = ['sklearn', 'xgboost', 'tensorflow'];
            if (!validEngines.includes(this.config.engine)) {
                errors.push(`Unsupported engine: ${this.config.engine}. Supported: ${validEngines.join(', ')}`);
            }
        }

        // Validate model format based on architecture/engine
        if (this.config.modelFormat && this.config.deploymentConfig) {
            try {
                const parts = this.deploymentConfigResolver.decompose(this.config.deploymentConfig);
                if (parts.architecture === 'http') {
                    const engine = this.config.engine || parts.engine;
                    if (engine) {
                        const supportedOptions = this._getSupportedOptions();
                        const validFormats = supportedOptions.modelFormats[engine] || [];
                        if (validFormats.length > 0 && !validFormats.includes(this.config.modelFormat)) {
                            errors.push(`Unsupported model format '${this.config.modelFormat}' for engine '${engine}'. Supported: ${validFormats.join(', ')}`);
                        }
                    }
                }
            } catch {
                // deploymentConfig already flagged as invalid above
            }
        }

        // Validate AWS Role ARN format if provided
        if (this.config.awsRoleArn) {
            try {
                this._isValidArn(this.config.awsRoleArn);
            } catch (error) {
                if (error instanceof ValidationError) {
                    errors.push(error.message);
                } else {
                    errors.push(`Invalid AWS Role ARN format: ${this.config.awsRoleArn}. Expected format: arn:aws:iam::123456789012:role/RoleName`);
                }
            }
        }

        // Validate build target (renamed from deployTarget)
        const buildTarget = this.config.buildTarget || this.config.deployTarget;
        if (buildTarget && !this._getSupportedOptions().buildTargets.includes(buildTarget)) {
            errors.push(`Unsupported build target: ${buildTarget}. Supported targets: ${this._getSupportedOptions().buildTargets.join(', ')}`);
        }

        // Validate CodeBuild compute type
        if (this.config.codebuildComputeType && !this._getSupportedOptions().codebuildComputeTypes.includes(this.config.codebuildComputeType)) {
            errors.push(`Unsupported CodeBuild compute type: ${this.config.codebuildComputeType}. Supported types: ${this._getSupportedOptions().codebuildComputeTypes.join(', ')}`);
        }

        // Validate CodeBuild project name format
        if (this.config.codebuildProjectName) {
            const projectNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_]{1,254}$/;
            if (!projectNamePattern.test(this.config.codebuildProjectName)) {
                errors.push(`Invalid CodeBuild project name: ${this.config.codebuildProjectName}. Project names must be 2-255 characters, start with a letter or number, and contain only letters, numbers, hyphens, and underscores.`);
            }
        }

        // Only validate required parameters if we're skipping prompts
        // If prompts are available, missing parameters can be collected later
        if (this.skipPrompts) {
            Object.entries(this.parameterMatrix).forEach(([param, config]) => {
                if (config.required && 
                    (this.config[param] === null || this.config[param] === undefined)) {
                    
                    // Special case: modelFormat is not required for transformers/triton/diffusors
                    if (param === 'modelFormat') {
                        try {
                            const parts = this.deploymentConfigResolver.decompose(this.config.deploymentConfig);
                            if (parts.architecture === 'transformers' || parts.architecture === 'triton' || parts.architecture === 'diffusors') {
                                return;
                            }
                        } catch {
                            // If deploymentConfig is invalid, skip this check
                            return;
                        }
                    }
                    
                    // Only error for promptable required parameters that have no default and can't be auto-generated
                    if (config.promptable && config.default === null && !this._canAutoGenerate(param)) {
                        errors.push(`Required parameter '${param}' is missing and prompts are disabled`);
                    }
                }
            });

            // Validate that modelName is provided for diffusors architecture
            if (this.config.deploymentConfig) {
                try {
                    const parts = this.deploymentConfigResolver.decompose(this.config.deploymentConfig);
                    if (parts.architecture === 'diffusors') {
                        const explicitModelName = this.explicitConfig && this.explicitConfig.modelName;
                        if (!explicitModelName) {
                            errors.push('Model name is required for diffusors architecture. Use --model-name to specify a HuggingFace diffusion model.');
                        }
                    }
                } catch {
                    // deploymentConfig already flagged as invalid above
                }
            }
        }

        // Validate schema-validated parameters (endpoint, iC)
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (config.schemaValidated && this.config[param] !== null && this.config[param] !== undefined) {
                const result = this.schemaValidator.validate(param, this.config[param], this.config.deploymentTarget);
                if (!result.valid) {
                    errors.push(result.error);
                }
            }
        });

        return errors;
    }

    /**
     * Validates required parameters before file generation
     * This is called after all configuration sources have been processed and prompting is complete
     * @param {Object} finalConfig - The complete configuration object
     * @returns {Array} Array of validation errors for missing required parameters
     */
    validateRequiredParameters(finalConfig) {
        const errors = [];
        
        // First, validate individual parameter values
        Object.entries(finalConfig).forEach(([param, value]) => {
            if (value !== null && value !== undefined && value !== '') {
                try {
                    this._validateParameterValue(param, value, finalConfig);
                } catch (error) {
                    if (error instanceof ValidationError) {
                        errors.push(error.message);
                    } else {
                        errors.push(`Invalid value for parameter '${param}': ${error.message}`);
                    }
                }
            }
        });
        
        // Then, validate required parameters are present
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (config.required) {
                const value = finalConfig[param];
                const isEmpty = value === null || value === undefined || value === '';
                
                // Special case: modelFormat is not required for transformers/triton/diffusors
                if (param === 'modelFormat' && (finalConfig.architecture === 'transformers' || finalConfig.architecture === 'triton' || finalConfig.architecture === 'diffusors')) {
                    return; // Skip validation
                }
                
                // Special case: instanceType is not required for hyperpod-eks
                // when not provided (backward compatibility) — but it IS prompted now
                // so it should normally be present
                if (param === 'instanceType' && finalConfig.deploymentTarget === 'hyperpod-eks' && !finalConfig.instanceType) {
                    return; // Skip validation only if truly missing for backward compat
                }
                
                if (isEmpty) {
                    if (config.promptable) {
                        // Promptable required parameter is missing - this should not happen after prompting
                        errors.push(`Required parameter '${param}' is missing. This parameter is required for ${finalConfig.architecture || 'the selected'} architecture.`);
                    } else {
                        // Non-promptable required parameter is missing - this is a configuration error
                        errors.push(`Required non-promptable parameter '${param}' is missing. This parameter must be provided through CLI options, environment variables, or configuration files.`);
                    }
                }
            }
        });

        // Finally, validate parameter combinations and dependencies
        const combinationErrors = this._validateParameterCombinations(finalConfig);
        errors.push(...combinationErrors);

        return errors;
    }

    /**
     * Validates parameter combinations and dependencies
     * @param {Object} config - The configuration object to validate
     * @returns {Array} Array of validation errors for invalid combinations
     * @private
     */
    _validateParameterCombinations(config) {
        const errors = [];

        // Additional combination validations that aren't covered by individual parameter validation
        // For example, complex business rules that involve multiple parameters
        
        // Validate that transformers architecture has sample model disabled
        if (config.architecture === 'transformers' && config.includeSampleModel === true) {
            errors.push(`Architecture '${config.architecture}' does not support sample models. The 'includeSampleModel' parameter will be automatically set to false.`);
        }
        // Validate that diffusors architecture has sample model disabled
        if (config.architecture === 'diffusors' && config.includeSampleModel === true) {
            errors.push(`Architecture '${config.architecture}' does not support sample models. The 'includeSampleModel' parameter will be automatically set to false.`);
        }
        // Validate that ineligible Triton backends have sample model disabled
        if (config.architecture === 'triton' && config.includeSampleModel === true) {
            const backendMeta = tritonBackends[config.backend];
            if (!backendMeta || !backendMeta.supportsSampleModel) {
                errors.push(`Triton backend '${config.backend}' does not support sample models. The 'includeSampleModel' parameter will be automatically set to false.`);
            }
        }

        return errors;
    }

    /**
     * Checks if a parameter can be auto-generated when missing
     * @param {string} param - Parameter name
     * @returns {boolean} True if parameter can be auto-generated
     * @private
     */
    _canAutoGenerate(param) {
        // Parameters that can be auto-generated even when missing
        const autoGeneratable = [
            'modelFormat',        // Can be inferred from engine
            'includeSampleModel', // Has default
            'includeTesting',     // Has default
            'instanceType'        // Has default
        ];
        
        return autoGeneratable.includes(param);
    }

    /**
     * Fills auto-prompt defaults for parameters that have sensible defaults
     * or can be inferred from the current config. Promotes these into
     * explicitConfig so the wizard skips them.
     * 
     * Only fills parameters that:
     * - Have a non-null default in the parameter matrix, OR
     * - Can be auto-generated (instanceType, modelFormat, etc.)
     * 
     * Does NOT fill parameters that are truly ambiguous and need user input
     * (e.g., deploymentConfig when not provided).
     * @private
     */
    _fillAutoPromptDefaults() {
        if (!this.explicitConfig) {
            this.explicitConfig = {};
        }

        // Derive architecture from deploymentConfig if available
        let architecture = this.config.architecture;
        if (!architecture && this.config.deploymentConfig) {
            try {
                const parts = this.deploymentConfigResolver.decompose(this.config.deploymentConfig);
                architecture = parts.architecture;
                this.config.architecture = parts.architecture;
                this.config.backend = parts.backend;
                this.config.engine = parts.engine;
            } catch {
                // Invalid deploymentConfig — will be caught by validation
            }
        }

        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            // Skip if already explicitly set
            if (this.explicitConfig[param] !== undefined && this.explicitConfig[param] !== null) {
                return;
            }

            // For optional parameters: mark them as explicit (with null) so the wizard skips them.
            // The downstream template logic handles defaults for optional params.
            if (!config.required) {
                // Don't override if there's already a value in config
                if (this.config[param] !== undefined && this.config[param] !== null) {
                    this.explicitConfig[param] = this.config[param];
                } else if (config.default !== null && config.default !== undefined) {
                    this.config[param] = config.default;
                    this.explicitConfig[param] = config.default;
                }
                return;
            }

            // For required parameters: fill auto-generatable values
            if (this.config[param] === undefined || this.config[param] === null) {
                if (param === 'instanceType') {
                    // If instance-sizer is configured and model is known, defer to sizer
                    // The sizer query happens in PromptRunner after model is selected
                    // For now, set a heuristic default that may be overridden by the sizer
                    const arch = architecture || 'http';
                    this.config[param] = arch === 'http' ? 'ml.m5.large' : 'ml.g5.xlarge';
                } else if (param === 'modelFormat') {
                    if (architecture === 'transformers' || architecture === 'triton' || architecture === 'diffusors') {
                        return; // Not needed for these architectures
                    }
                    const engine = this.config.engine || 'sklearn';
                    const formatMap = { sklearn: 'pkl', xgboost: 'json', tensorflow: 'keras' };
                    this.config[param] = formatMap[engine] || 'pkl';
                } else if (param === 'projectName') {
                    this.config[param] = this._generateProjectName(architecture);
                } else {
                    return; // Can't fill — leave for prompting
                }
            }

            // Promote non-null values to explicitConfig so the wizard skips them
            if (this.config[param] !== undefined && this.config[param] !== null) {
                if (config.default !== null || this._canAutoGenerate(param)) {
                    this.explicitConfig[param] = this.config[param];
                }
            }
        });
    }

    /**
     * Returns whether auto-prompt mode is active
     * @returns {boolean}
     */
    isAutoPrompt() {
        return this.autoPrompt;
    }

    /**
     * Gets the list of required parameters that are truly missing and cannot be
     * auto-generated or defaulted. Used by auto-prompt mode to determine which
     * specific prompts to show.
     * 
     * @returns {string[]} Array of parameter names that need prompting
     */
    getMissingRequiredParameters() {
        const missing = [];

        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (!config.required || !config.promptable) return;

            const value = this.config[param];
            const hasValue = value !== undefined && value !== null;

            if (hasValue) return;

            // Special case: modelFormat is not required for transformers/triton/diffusors
            if (param === 'modelFormat') {
                const architecture = this.config.architecture;
                if (architecture === 'transformers' || architecture === 'triton' || architecture === 'diffusors') {
                    return;
                }
                // Can be inferred from engine
                if (this.config.engine || this.config.deploymentConfig) {
                    return;
                }
            }

            // Skip params that can be auto-generated
            if (this._canAutoGenerate(param)) return;

            // Skip params that have a non-null default
            if (config.default !== null && config.default !== undefined) return;

            missing.push(param);
        });

        return missing;
    }

    /**
     * Generates a project name based on framework
     * @param {string} framework - The ML framework
     * @returns {string} Generated project name
     * @private
     */
    _generateProjectName(architecture) {
        const adjectives = [
            'smart', 'fast', 'clever', 'bright', 'swift', 'agile', 'sharp', 'quick',
            'wise', 'keen', 'bold', 'sleek', 'neat', 'cool', 'fresh', 'prime'
        ];
        
        const architectureNames = {
            'http': ['http', 'api', 'serve'],
            'transformers': ['llm', 'transformer', 'gpt', 'bert', 'ai'],
            'triton': ['triton', 'inference', 'nvidia'],
            'diffusors': ['diffusion', 'image', 'vllm-omni']
        };
        
        const suffixes = [
            'model', 'predictor', 'classifier', 'engine', 'service', 'api',
            'container', 'deployment', 'inference', 'ml', 'ai', 'bot'
        ];
        
        // Get random elements
        const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
        const archName = architectureNames[architecture] ? 
            architectureNames[architecture][Math.floor(Math.random() * architectureNames[architecture].length)] :
            'ml';
        const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
        
        return `${adjective}-${archName}-${suffix}`;
    }

    /**
     * Generates a descriptive CodeBuild project name
     * @param {string} projectName - The main project name
     * @param {string} framework - The ML framework being used
     * @returns {string} Generated CodeBuild project name
     * @private
     */
    _generateCodeBuildProjectName(projectName, architecture) {
        const architectureMap = {
            'http': 'http',
            'transformers': 'llm',
            'triton': 'triton',
            'diffusors': 'diffusion'
        };
        
        const archName = architectureMap[architecture] || 'ml';
        const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
        
        // Create a descriptive name that indicates it's a build project
        const buildProjectName = `${projectName}-${archName}-build-${timestamp}`;
        
        // Ensure it meets AWS CodeBuild naming requirements (2-255 chars, alphanumeric + hyphens/underscores)
        return buildProjectName
            .toLowerCase()
            .replace(/[^a-z0-9\-_]/g, '-')  // Replace invalid chars with hyphens
            .replace(/-+/g, '-')            // Replace multiple hyphens with single
            .replace(/^-|-$/g, '')          // Remove leading/trailing hyphens
            .slice(0, 255);                 // Ensure max length
    }

    /**
     * Validates a single parameter value
     * @param {string} parameter - Parameter name
     * @param {*} value - Parameter value
     * @param {Object} context - Additional context (e.g., other parameter values)
     * @throws {ValidationError} If parameter value is invalid
     * @private
     */
    _validateParameterValue(parameter, value, context = {}) {
        const supportedOptions = this._getSupportedOptions();
        
        switch (parameter) {
        case 'deploymentConfig':
            if (value) {
                // Check for old-format configs with migration messages
                const oldFormatMigration = {
                    'sklearn-flask': 'Use --deployment-config=http-flask --engine=sklearn instead',
                    'sklearn-fastapi': 'Use --deployment-config=http-fastapi --engine=sklearn instead',
                    'xgboost-flask': 'Use --deployment-config=http-flask --engine=xgboost instead',
                    'xgboost-fastapi': 'Use --deployment-config=http-fastapi --engine=xgboost instead',
                    'tensorflow-flask': 'Use --deployment-config=http-flask --engine=tensorflow instead',
                    'tensorflow-fastapi': 'Use --deployment-config=http-fastapi --engine=tensorflow instead'
                };
                const migrationMsg = oldFormatMigration[value];
                if (migrationMsg) {
                    throw new ValidationError(
                        `Unsupported deployment-config: ${value}. This value has been replaced. ${migrationMsg}`,
                        parameter,
                        value
                    );
                }
                if (!this.deploymentConfigResolver.isValid(value)) {
                    const valid = this.deploymentConfigResolver.getAllConfigs().join(', ');
                    throw new ValidationError(
                        `Unsupported deployment-config: ${value}. Valid configs: ${valid}`,
                        parameter,
                        value
                    );
                }
            }
            break;

        case 'engine':
            if (value) {
                const validEngines = ['sklearn', 'xgboost', 'tensorflow'];
                if (!validEngines.includes(value)) {
                    throw new ValidationError(
                        `Unsupported engine: ${value}. Supported: ${validEngines.join(', ')}`,
                        parameter,
                        value
                    );
                }
            }
            break;
                
        case 'modelFormat':
            if (value && context.architecture === 'http' && context.engine) {
                const validFormats = supportedOptions.modelFormats[context.engine] || [];
                if (validFormats.length > 0 && !validFormats.includes(value)) {
                    throw new ValidationError(
                        `Model format '${value}' is not compatible with engine '${context.engine}'. Compatible formats: ${validFormats.join(', ')}`,
                        parameter,
                        value
                    );
                }
            }
            break;
                
        case 'instanceType':
            if (value) {
                // Validate AWS SageMaker instance type format
                const instancePattern = /^ml\.[a-z0-9]+\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/;
                if (!instancePattern.test(value)) {
                    throw new ValidationError(
                        `Invalid instance type format: ${value}. Expected format: ml.{family}.{size} (e.g., ml.m5.large, ml.g4dn.xlarge)`,
                        parameter,
                        value
                    );
                }
                // Warn about CPU instances for transformers/triton (but don't block)
                if (context.architecture === 'transformers' || context.architecture === 'triton') {
                    const cpuFamilies = ['t2', 't3', 't3a', 't4g', 'm4', 'm5', 'm5a', 'm5ad', 'm5d', 'm5dn', 'm5n', 'm5zn', 'm6a', 'm6g', 'm6gd', 'm6i', 'm6id', 'm6idn', 'm6in', 'c4', 'c5', 'c5a', 'c5ad', 'c5d', 'c5n', 'c6a', 'c6g', 'c6gd', 'c6gn', 'c6i', 'c6id', 'c6in', 'r4', 'r5', 'r5a', 'r5ad', 'r5b', 'r5d', 'r5dn', 'r5n', 'r6a', 'r6g', 'r6gd', 'r6i', 'r6id', 'r6idn', 'r6in'];
                    const instanceFamily = value.split('.')[1];
                    if (cpuFamilies.includes(instanceFamily)) {
                        console.warn(`⚠️  Warning: Using CPU instance ${value} with ${context.architecture} architecture. GPU instances are recommended for better performance.`);
                    }
                }
            }
            break;
            
        case 'awsRegion':
            if (value && !supportedOptions.awsRegions.includes(value)) {
                throw new ValidationError(
                    `Unsupported AWS region: ${value}. Supported regions: ${supportedOptions.awsRegions.join(', ')}`,
                    parameter,
                    value
                );
            }
            break;
                
        case 'awsRoleArn':
            if (value) {
                this._isValidArn(value);
            }
            break;
            
        case 'buildTarget':
        case 'deployTarget':
            if (value && !supportedOptions.buildTargets.includes(value)) {
                throw new ValidationError(
                    `Unsupported build target: ${value}. Supported targets: ${supportedOptions.buildTargets.join(', ')}`,
                    parameter,
                    value
                );
            }
            break;
            
        case 'codebuildComputeType':
            if (value && !supportedOptions.codebuildComputeTypes.includes(value)) {
                throw new ValidationError(
                    `Unsupported CodeBuild compute type: ${value}. Supported types: ${supportedOptions.codebuildComputeTypes.join(', ')}`,
                    parameter,
                    value
                );
            }
            break;
            
        case 'codebuildProjectName':
            if (value) {
                // AWS CodeBuild project names must follow specific naming rules
                const projectNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_]{1,254}$/;
                if (!projectNamePattern.test(value)) {
                    throw new ValidationError(
                        `Invalid CodeBuild project name: ${value}. Project names must be 2-255 characters, start with a letter or number, and contain only letters, numbers, hyphens, and underscores.`,
                        parameter,
                        value
                    );
                }
            }
            break;
        }
    }

    /**
     * Resolves HF_TOKEN references to actual token values
     * @param {string} tokenValue - The token value or "$HF_TOKEN" reference
     * @returns {string|null} Resolved token value
     * @private
     */
    _resolveHfToken(tokenValue) {
        if (!tokenValue || tokenValue.trim() === '') {
            return null;
        }
        
        // Check if it's an environment variable reference
        if (tokenValue.trim() === '$HF_TOKEN') {
            const envToken = process.env.HF_TOKEN;
            if (!envToken) {
                console.warn('⚠️  Warning: $HF_TOKEN specified but HF_TOKEN environment variable is not set');
                console.warn('   The container will be built without authentication.');
                return null;
            }
            return envToken;
        }
        
        // Direct token value
        return tokenValue;
    }

    /**
     * Validates AWS Role ARN format
     * @param {string} arn - The ARN to validate
     * @throws {ValidationError} If ARN format is invalid
     * @private
     */
    _isValidArn(arn) {
        const arnPattern = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
        if (!arnPattern.test(arn)) {
            throw new ValidationError(
                `Invalid AWS Role ARN format: ${arn}. Expected format: arn:aws:iam::123456789012:role/RoleName`,
                'awsRoleArn',
                arn
            );
        }
        return true;
    }

    /**
     * Gets supported options for validation
     * @private
     */
    _getSupportedOptions() {
        return {
            deploymentConfigs: this.deploymentConfigResolver.getAllConfigs(),
            engines: ['sklearn', 'xgboost', 'tensorflow'],
            modelFormats: {
                'sklearn': ['pkl', 'joblib'],
                'xgboost': ['json', 'model', 'ubj'],
                'tensorflow': ['keras', 'h5', 'SavedModel']
            },
            buildTargets: ['codebuild'],
            codebuildComputeTypes: ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'],
            awsRegions: [
                'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
                'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1',
                'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
                'ca-central-1', 'sa-east-1'
            ]
        };
    }
}


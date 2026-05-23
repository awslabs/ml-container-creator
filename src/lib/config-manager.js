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
import DeploymentConfigResolver from './deployment-config-resolver.js';
import ParameterSchemaValidator from './parameter-schema-validator.js';
import ConfigLoader from './config-loader.js';
import ConfigMcpClient from './config-mcp-client.js';
import ConfigValidator from './config-validator.js';
import { parameterMatrix } from './generated/parameter-matrix.js';

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
        this.GENERATOR_ROOT = GENERATOR_ROOT;

        // Delegate modules
        this._loader = new ConfigLoader(this);
        this._mcpClient = new ConfigMcpClient(this);
        this._validator = new ConfigValidator(this);
    }

    /** Delegate to config-loader for backward compatibility with tests */
    _applyJsonConfig(config) {
        return this._loader._applyJsonConfig(config);
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

        // Mutual exclusion: ARN takes precedence over plaintext when both are set
        // (CLI validation should prevent this, but enforce at config level too)
        if (finalConfig.hfTokenArn) {
            finalConfig.hfToken = null;
        }
        if (finalConfig.ngcTokenArn) {
            finalConfig.ngcApiKey = null;
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
     * Gets the parameter matrix configuration (generated from schema)
     * @private
     */
    _getParameterMatrix() {
        return parameterMatrix;
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
        if (parameter === 'includeSampleModel' || parameter === 'includeTesting' || parameter === 'skipPrompts' || parameter === 'includeBenchmark' || parameter === 'benchmarkStreaming' || parameter === 'enableLora') {
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
        return this._loader._loadBootstrapConfig();
    }

    /**
     * Load from package.json "ml-container-creator" section (filtered by matrix)
     * @private
     */
    async _loadPackageJsonConfig() {
        return this._loader._loadPackageJsonConfig();
    }

    /**
     * Load from config/mcp.json
     * @private
     */
    async _loadCustomConfigFile() {
        return this._loader._loadCustomConfigFile();
    }

    /**
     * Load from CLI --config file or --config-json inline string.
     * @private
     */
    async _loadCliConfigFile() {
        return this._loader._loadCliConfigFile();
    }

    /**
     * Load from environment variables (filtered by matrix)
     * @private
     */
    async _loadEnvironmentVariables() {
        return this._loader._loadEnvironmentVariables();
    }

    /**
     * Load from CLI arguments (positional)
     * @private
     */
    async _loadCliArguments() {
        return this._loader._loadCliArguments();
    }

    /**
     * Load from CLI options (highest precedence, filtered by matrix)
     * @private
     */
    async _loadCliOptions() {
        return this._loader._loadCliOptions();
    }

    /**
     * Normalizes deprecated parameter values to their canonical equivalents.
     * @private
     */
    _normalizeDeprecatedValues() {
        return this._loader._normalizeDeprecatedValues();
    }

    /**
     * Parse --model-env or --server-env CLI options into env var collections.
     * @param {string} optionName - CLI option name
     * @param {string} configKey - Config key to store results
     * @private
     */
    _parseEnvVarOptions(optionName, configKey) {
        return this._loader._parseEnvVarOptions(optionName, configKey);
    }

    /**
     * Query configured MCP servers for unbounded parameter values.
     * Reads mcpServers from config/mcp.json, spawns each one,
     * and stores results in mcpSources/mcpChoices.
     * @private
     */
    async _queryMcpServers() {
        return this._mcpClient._queryMcpServers();
    }

    /**
     * Query a single named MCP server on-demand with the given context.
     * Stores results in mcpSources/mcpChoices and returns the result.
     * @param {string} serverName - Name of the server in mcpServers config
     * @param {object} context - Context to pass to the MCP tool (e.g. { regionSearch: 'europe' })
     * @returns {Promise<{ values: object, choices: object } | null>}
     */
    async queryMcpServer(serverName, context = {}) {
        return this._mcpClient.queryMcpServer(serverName, context);
    }

    /**
     * Get the names of configured MCP servers.
     * @returns {string[]}
     */
    getMcpServerNames() {
        return this._mcpClient.getMcpServerNames();
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
     * @returns {Array} Array of validation errors
     */
    validateConfiguration() {
        return this._validator.validateConfiguration();
    }

    /**
     * Validates required parameters before file generation
     * @param {Object} finalConfig - The complete configuration object
     * @returns {Array} Array of validation errors for missing required parameters
     */
    validateRequiredParameters(finalConfig) {
        return this._validator.validateRequiredParameters(finalConfig);
    }

    /**
     * @private
     */
    _validateParameterCombinations(config) {
        return this._validator._validateParameterCombinations(config);
    }

    /**
     * @private
     */
    _canAutoGenerate(param) {
        return this._validator._canAutoGenerate(param);
    }

    /**
     * @private
     */
    _fillAutoPromptDefaults() {
        return this._validator._fillAutoPromptDefaults();
    }

    /**
     * Returns whether auto-prompt mode is active
     * @returns {boolean}
     */
    isAutoPrompt() {
        return this._validator.isAutoPrompt();
    }

    /**
     * Gets the list of required parameters that are truly missing.
     * @returns {string[]} Array of parameter names that need prompting
     */
    getMissingRequiredParameters() {
        return this._validator.getMissingRequiredParameters();
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
     * @private
     */
    _validateParameterValue(parameter, value, context = {}) {
        return this._validator._validateParameterValue(parameter, value, context);
    }

    /**
     * @private
     */
    _resolveHfToken(tokenValue) {
        return this._validator._resolveHfToken(tokenValue);
    }

    /**
     * @private
     */
    _isValidArn(arn) {
        return this._validator._isValidArn(arn);
    }

    /**
     * @private
     */
    _getSupportedOptions() {
        return this._validator._getSupportedOptions();
    }
}


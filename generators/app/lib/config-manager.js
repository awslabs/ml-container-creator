// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Manager - Handles configuration precedence and merging
 * 
 * Implements the complete precedence order (Highest → Lowest Priority):
 * 1. CLI Options (--framework=transformers)
 * 2. CLI Arguments (yo generator projectName)
 * 3. Environment Variables (AWS_REGION=us-east-1)
 * 4. CLI Config File (--config=prod.json)
 * 5. Custom Config File (ml-container.config.json)
 * 6. Package.json Section ("ml-container-creator": {...})
 * 7. Generator Defaults
 * 8. Prompting (fallback)
 */

import fs from 'fs';
import path from 'path';

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
    constructor(generator) {
        this.generator = generator;
        this.config = {};
        this.skipPrompts = false;
        this.parameterMatrix = this._getParameterMatrix();
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
        await this._loadPackageJsonConfig();
        await this._loadCustomConfigFile();
        await this._loadCliConfigFile();
        await this._loadEnvironmentVariables();
        await this._loadCliArguments();
        await this._loadCliOptions();

        // Check if we should skip prompts
        this.skipPrompts = this.generator.options['skip-prompts'] || 
                          this._hasCompleteConfiguration();

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

        // Ensure all parameters from the matrix are included in final config
        // This is important for optional parameters that might be null
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (finalConfig[param] === undefined) {
                finalConfig[param] = this.config[param] || config.default;
            }
        });

        // When skipping prompts, provide reasonable defaults for missing required parameters
        if (this.skipPrompts) {
            Object.entries(this.parameterMatrix).forEach(([param, config]) => {
                if (config.required && 
                    (finalConfig[param] === null || finalConfig[param] === undefined)) {
                    
                    // Provide reasonable defaults for missing required parameters
                    if (param === 'framework') {
                        finalConfig[param] = 'sklearn'; // Default framework
                    } else if (param === 'modelServer') {
                        // Infer model server from framework
                        const framework = finalConfig.framework || 'sklearn';
                        finalConfig[param] = framework === 'transformers' ? 'vllm' : 'flask';
                    } else if (param === 'modelFormat') {
                        // Infer model format from framework (skip for transformers)
                        const framework = finalConfig.framework || 'sklearn';
                        if (framework !== 'transformers') {
                            const formatMap = {
                                'sklearn': 'pkl',
                                'xgboost': 'json',
                                'tensorflow': 'keras'
                            };
                            finalConfig[param] = formatMap[framework] || 'pkl';
                        }
                    } else if (param === 'instanceType') {
                        // Default to cpu-optimized, but use gpu-enabled for transformers
                        const framework = finalConfig.framework || 'sklearn';
                        finalConfig[param] = framework === 'transformers' ? 'gpu-enabled' : 'cpu-optimized';
                    } else if (param === 'projectName') {
                        // Generate project name
                        finalConfig[param] = this._generateProjectName(finalConfig.framework);
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
                    // Generate project name based on framework or use default
                    finalConfig[param] = this._generateProjectName(finalConfig.framework);
                } else if (config.default !== null) {
                    // Use default value if available
                    finalConfig[param] = config.default;
                }
            }
        });

        // Apply framework-specific overrides
        if (finalConfig.framework === 'transformers') {
            // Transformers don't support sample models
            finalConfig.includeSampleModel = false;
        }
        
        // Generate CodeBuild project name if deployTarget is codebuild
        if (finalConfig.deployTarget === 'codebuild' && !finalConfig.codebuildProjectName) {
            finalConfig.codebuildProjectName = this._generateCodeBuildProjectName(
                finalConfig.projectName, 
                finalConfig.framework
            );
        }

        // Add build timestamp if not present
        if (!finalConfig.buildTimestamp) {
            finalConfig.buildTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
     * Gets the parameter matrix configuration
     * @private
     */
    _getParameterMatrix() {
        return {
            framework: {
                cliOption: 'framework',
                envVar: null,
                configFile: true,
                packageJson: false,
                promptable: true,
                required: true,
                default: null
            },
            modelServer: {
                cliOption: 'model-server',
                envVar: null,
                configFile: true,
                packageJson: false,
                promptable: true,
                required: true,
                default: null
            },
            modelFormat: {
                cliOption: 'model-format',
                envVar: null,
                configFile: true,
                packageJson: false,
                promptable: true,
                required: true,
                default: null
            },
            modelName: {
                cliOption: 'model-name',
                envVar: null,
                configFile: true,
                packageJson: false,
                promptable: true,
                required: false,
                default: 'openai/gpt-oss-20b'
            },
            includeSampleModel: {
                cliOption: 'include-sample',
                envVar: null,
                configFile: true,
                packageJson: false,
                promptable: true,
                required: true,
                default: false
            },
            includeTesting: {
                cliOption: 'include-testing',
                envVar: null,
                configFile: true,
                packageJson: false,
                promptable: true,
                required: true,
                default: true
            },
            instanceType: {
                cliOption: 'instance-type',
                envVar: 'ML_INSTANCE_TYPE',
                configFile: true,
                packageJson: false,
                promptable: true,
                required: true,
                default: null
            },
            awsRegion: {
                cliOption: 'region',
                envVar: 'AWS_REGION',
                configFile: true,
                packageJson: true,
                promptable: true,
                required: false,
                default: 'us-east-1'
            },
            awsRoleArn: {
                cliOption: 'role-arn',
                envVar: 'AWS_ROLE',
                configFile: true,
                packageJson: true,
                promptable: true,
                required: false,
                default: null
            },
            configFile: {
                cliOption: 'config',
                envVar: 'ML_CONTAINER_CREATOR_CONFIG',
                configFile: false,
                packageJson: true,
                promptable: true,
                required: false,
                default: null
            },
            skipPrompts: {
                cliOption: 'skip-prompts',
                envVar: null,
                configFile: false,
                packageJson: false,
                promptable: false,
                required: false,
                default: false
            },
            projectName: {
                cliOption: 'project-name',
                envVar: null,
                configFile: true,
                packageJson: true,
                promptable: false,
                required: true,
                default: null
            },
            destinationDir: {
                cliOption: 'project-dir',
                envVar: null,
                configFile: true,
                packageJson: true,
                promptable: false,
                required: true,
                default: '.'
            },
            deployTarget: {
                cliOption: 'deploy-target',
                envVar: 'ML_DEPLOY_TARGET',
                configFile: true,
                packageJson: false,
                promptable: true,
                required: true,
                default: 'sagemaker'
            },
            codebuildComputeType: {
                cliOption: 'codebuild-compute-type',
                envVar: 'ML_CODEBUILD_COMPUTE_TYPE',
                configFile: true,
                packageJson: false,
                promptable: true,
                required: false,
                default: 'BUILD_GENERAL1_MEDIUM'
            },
            codebuildProjectName: {
                cliOption: null,
                envVar: null,
                configFile: true,
                packageJson: false,
                promptable: false,
                required: false,
                default: null
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
            } else {
                defaults[param] = null;
            }
        });

        // Add legacy parameters that aren't in the matrix but are still used internally
        defaults.testTypes = null;

        return defaults;
    }



    /**
     * Load from package.json "ml-container-creator" section (filtered by matrix)
     * @private
     */
    async _loadPackageJsonConfig() {
        try {
            const packageJsonPath = this.generator.destinationPath('package.json');
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
     * Load from ml-container.config.json
     * @private
     */
    async _loadCustomConfigFile() {
        try {
            const configPath = this.generator.destinationPath('ml-container.config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this._mergeConfig(config);
            }
        } catch (error) {
            // Ignore errors - this is optional
        }
    }

    /**
     * Load from CLI --config file (with environment variable support)
     * @private
     */
    async _loadCliConfigFile() {
        let configFile = this.generator.options.config;
        
        // Check environment variable if CLI option not provided
        if (!configFile && process.env.ML_CONTAINER_CREATOR_CONFIG) {
            configFile = process.env.ML_CONTAINER_CREATOR_CONFIG;
        }
        
        if (configFile) {
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
                // Filter config to only include parameters supported in config files
                const filteredConfig = {};
                Object.entries(config).forEach(([key, value]) => {
                    if (this._isSourceSupported(key, 'configFile')) {
                        filteredConfig[key] = this._parseValue(key, value);
                    }
                });
                this._mergeConfig(filteredConfig);
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
                envMapping[config.envVar] = param;
            }
        });

        Object.entries(envMapping).forEach(([envVar, configKey]) => {
            const value = process.env[envVar];
            if (value !== undefined && value !== '' && this._isSourceSupported(configKey, 'envVar')) {
                this.config[configKey] = this._parseValue(configKey, value);
                // Track as explicit configuration
                if (!this.explicitConfig) {
                    this.explicitConfig = {};
                }
                this.explicitConfig[configKey] = this._parseValue(configKey, value);
            }
        });
    }

    /**
     * Load from CLI arguments (positional)
     * @private
     */
    async _loadCliArguments() {
        // First positional argument is project name
        if (this.generator.args && this.generator.args.length > 0) {
            this.config.projectName = this.generator.args[0];
            // Track as explicit configuration
            if (!this.explicitConfig) {
                this.explicitConfig = {};
            }
            this.explicitConfig.projectName = this.generator.args[0];
        }
    }

    /**
     * Load from CLI options (highest precedence, filtered by matrix)
     * @private
     */
    async _loadCliOptions() {
        const options = this.generator.options;
        
        // Build CLI option mapping from parameter matrix
        Object.entries(this.parameterMatrix).forEach(([param, config]) => {
            if (config.cliOption && options[config.cliOption] !== undefined) {
                this.config[param] = this._parseValue(param, options[config.cliOption]);
                // Track as explicit configuration
                if (!this.explicitConfig) {
                    this.explicitConfig = {};
                }
                this.explicitConfig[param] = this._parseValue(param, options[config.cliOption]);
            }
        });
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
     * Checks if we have enough configuration to skip prompts
     * Non-promptable parameters are not required for this check since they can be auto-generated
     * @private
     */
    _hasCompleteConfiguration() {
        // Only check promptable required parameters
        const promptableRequired = Object.entries(this.parameterMatrix)
            .filter(([_param, config]) => config.required && config.promptable)
            .map(([param]) => param);
        
        // Special case: modelFormat is not required for transformers
        const requiredForFramework = promptableRequired.filter(param => {
            if (param === 'modelFormat' && this.config.framework === 'transformers') {
                return false;
            }
            return true;
        });
        
        return requiredForFramework.every(key => 
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
        const supportedOptions = this._getSupportedOptions();

        // Validate framework
        if (this.config.framework && !supportedOptions.frameworks.includes(this.config.framework)) {
            errors.push(`Unsupported framework: ${this.config.framework}. Supported: ${supportedOptions.frameworks.join(', ')}`);
        }

        // Validate model server based on framework
        if (this.config.modelServer && this.config.framework) {
            const validServers = supportedOptions.modelServers[this.config.framework] || [];
            if (!validServers.includes(this.config.modelServer)) {
                errors.push(`Unsupported model server '${this.config.modelServer}' for framework '${this.config.framework}'. Supported: ${validServers.join(', ')}`);
            }
        }

        // Validate model format based on framework (transformers don't need model format)
        if (this.config.modelFormat && this.config.framework) {
            const validFormats = supportedOptions.modelFormats[this.config.framework] || [];
            if (validFormats.length > 0 && !validFormats.includes(this.config.modelFormat)) {
                errors.push(`Unsupported model format '${this.config.modelFormat}' for framework '${this.config.framework}'. Supported: ${validFormats.join(', ')}`);
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

        // Validate deployment target
        if (this.config.deployTarget && !supportedOptions.deployTargets.includes(this.config.deployTarget)) {
            errors.push(`Unsupported deployment target: ${this.config.deployTarget}. Supported targets: ${supportedOptions.deployTargets.join(', ')}`);
        }

        // Validate CodeBuild compute type
        if (this.config.codebuildComputeType && !supportedOptions.codebuildComputeTypes.includes(this.config.codebuildComputeType)) {
            errors.push(`Unsupported CodeBuild compute type: ${this.config.codebuildComputeType}. Supported types: ${supportedOptions.codebuildComputeTypes.join(', ')}`);
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
                    
                    // Special case: modelFormat is not required for transformers
                    if (param === 'modelFormat' && this.config.framework === 'transformers') {
                        return; // Skip validation for transformers
                    }
                    
                    // Only error for promptable required parameters that have no default and can't be auto-generated
                    if (config.promptable && config.default === null && !this._canAutoGenerate(param)) {
                        errors.push(`Required parameter '${param}' is missing and prompts are disabled`);
                    }
                }
            });
        }

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
                
                // Special case: modelFormat is not required for transformers
                if (param === 'modelFormat' && finalConfig.framework === 'transformers') {
                    return; // Skip validation for transformers
                }
                
                if (isEmpty) {
                    if (config.promptable) {
                        // Promptable required parameter is missing - this should not happen after prompting
                        errors.push(`Required parameter '${param}' is missing. This parameter is required for ${finalConfig.framework || 'the selected'} framework.`);
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
        
        // Validate that transformers framework has sample model disabled
        if (config.framework === 'transformers' && config.includeSampleModel === true) {
            errors.push('Framework \'transformers\' does not support sample models. The \'includeSampleModel\' parameter will be automatically set to false.');
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
            'framework',     // Can default to a reasonable choice
            'modelServer',   // Can be inferred from framework
            'modelFormat',   // Can be inferred from framework
            'includeSampleModel', // Has default
            'includeTesting',     // Has default
            'instanceType'        // Has default
        ];
        
        return autoGeneratable.includes(param);
    }

    /**
     * Generates a project name based on framework
     * @param {string} framework - The ML framework
     * @returns {string} Generated project name
     * @private
     */
    _generateProjectName(framework) {
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
     * Generates a descriptive CodeBuild project name
     * @param {string} projectName - The main project name
     * @param {string} framework - The ML framework being used
     * @returns {string} Generated CodeBuild project name
     * @private
     */
    _generateCodeBuildProjectName(projectName, framework) {
        const frameworkMap = {
            'sklearn': 'sklearn',
            'xgboost': 'xgboost', 
            'tensorflow': 'tensorflow',
            'transformers': 'llm'
        };
        
        const frameworkName = frameworkMap[framework] || 'ml';
        const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
        
        // Create a descriptive name that indicates it's a build project
        const buildProjectName = `${projectName}-${frameworkName}-build-${timestamp}`;
        
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
        case 'framework':
            if (value && !supportedOptions.frameworks.includes(value)) {
                throw new ValidationError(
                    `Unsupported framework: ${value}. Supported: ${supportedOptions.frameworks.join(', ')}`,
                    parameter,
                    value
                );
            }
            break;
                
        case 'modelServer':
            if (value && context.framework) {
                const validServers = supportedOptions.modelServers[context.framework] || [];
                if (!validServers.includes(value)) {
                    throw new ValidationError(
                        `Model server '${value}' is not compatible with framework '${context.framework}'. Compatible servers: ${validServers.join(', ')}`,
                        parameter,
                        value
                    );
                }
            }
            break;
                
        case 'modelFormat':
            if (value && context.framework && context.framework !== 'transformers') {
                const validFormats = supportedOptions.modelFormats[context.framework] || [];
                if (validFormats.length > 0 && !validFormats.includes(value)) {
                    throw new ValidationError(
                        `Model format '${value}' is not compatible with framework '${context.framework}'. Compatible formats: ${validFormats.join(', ')}`,
                        parameter,
                        value
                    );
                }
            }
            break;
                
        case 'instanceType':
            if (value && !supportedOptions.instanceTypes.includes(value)) {
                throw new ValidationError(
                    `Unsupported instance type: ${value}. Supported types: ${supportedOptions.instanceTypes.join(', ')}`,
                    parameter,
                    value
                );
            }
            // Special validation for transformers requiring GPU
            if (value === 'cpu-optimized' && context.framework === 'transformers') {
                throw new ValidationError(
                    'Framework \'transformers\' requires GPU-enabled instances. CPU-optimized instances are not supported for transformer models.',
                    parameter,
                    value
                );
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
            
        case 'deployTarget':
            if (value && !supportedOptions.deployTargets.includes(value)) {
                throw new ValidationError(
                    `Unsupported deployment target: ${value}. Supported targets: ${supportedOptions.deployTargets.join(', ')}`,
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
            frameworks: ['sklearn', 'xgboost', 'tensorflow', 'transformers'],
            modelServers: {
                'sklearn': ['flask', 'fastapi'],
                'xgboost': ['flask', 'fastapi'],
                'tensorflow': ['flask', 'fastapi'],
                'transformers': ['vllm', 'sglang']
            },
            modelFormats: {
                'sklearn': ['pkl', 'joblib'],
                'xgboost': ['json', 'model', 'ubj'],
                'tensorflow': ['keras', 'h5', 'SavedModel'],
                'transformers': [] // No format needed
            },
            deployTargets: ['sagemaker', 'codebuild'],
            codebuildComputeTypes: ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'],
            instanceTypes: ['cpu-optimized', 'gpu-enabled'],
            awsRegions: [
                'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
                'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1',
                'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
                'ca-central-1', 'sa-east-1'
            ]
        };
    }
}


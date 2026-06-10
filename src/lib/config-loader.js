// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Config Loader - Handles loading configuration from all sources.
 * Uses delegation pattern: receives parent ConfigManager reference to access shared state.
 */

import fs from 'fs';
import path from 'path';
import BootstrapConfig from './bootstrap-config.js';
import { parseKeyValue } from './key-value-parser.js';
import { ConfigurationError } from './config-manager.js';

export default class ConfigLoader {
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Load from bootstrap config (~/.ml-container-creator/config.json)
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
            if (profileConfig.ciBenchmarkResultsBucket) {
                mapped.ciBenchmarkResultsBucket = profileConfig.ciBenchmarkResultsBucket;
            }

            this.manager._mergeConfig(mapped);
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
                    const filteredConfig = {};
                    Object.entries(generatorConfig).forEach(([key, value]) => {
                        if (this.manager._isSourceSupported(key, 'packageJson')) {
                            filteredConfig[key] = this.manager._parseValue(key, value);
                        }
                    });
                    this.manager._mergeConfig(filteredConfig);
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
            const configPath = path.join(this.manager.GENERATOR_ROOT, 'config', 'mcp.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this.manager._mergeConfig(config);
            }
        } catch (error) {
            // Ignore errors - this is optional
        }
    }

    /**
     * Load from CLI --config file or --config-json inline string.
     * @private
     */
    async _loadCliConfigFile() {
        let configFile = this.manager.options.config;

        // Check environment variable if CLI option not provided
        if (!configFile && process.env.ML_CONTAINER_CREATOR_CONFIG) {
            configFile = process.env.ML_CONTAINER_CREATOR_CONFIG;
        }

        if (configFile) {
            this._loadConfigFromFile(configFile);
        }

        // --config-json: inline JSON string or path to a JSON file
        const configJson = this.manager.options['config-json'];
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
     * @param {string} configJson - Inline JSON string or path to a JSON file
     * @private
     */
    _loadConfigFromJson(configJson) {
        let config;
        try {
            config = JSON.parse(configJson);
        } catch {
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
                    if (flatKey && this.manager._isSourceSupported(flatKey, 'configFile')) {
                        filteredConfig[flatKey] = nestedValue;
                        this.manager._recordSource(flatKey, nestedValue, 'config-file');
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
                    if (flatKey && this.manager._isSourceSupported(flatKey, 'configFile')) {
                        filteredConfig[flatKey] = nestedValue;
                        this.manager._recordSource(flatKey, nestedValue, 'config-file');
                    }
                });
                return;
            }

            // Handle modelEnvVars object
            if (key === 'modelEnvVars' && typeof value === 'object' && value !== null) {
                if (!this.manager.config.modelEnvVars) {
                    this.manager.config.modelEnvVars = {};
                }
                const cliModelEnvVars = (this.manager.explicitConfig && this.manager.explicitConfig.modelEnvVars) || {};
                Object.entries(value).forEach(([envKey, envValue]) => {
                    if (!(envKey in cliModelEnvVars)) {
                        this.manager.config.modelEnvVars[envKey] = envValue;
                        this.manager._recordSource(`modelEnvVars.${envKey}`, envValue, 'config-file');
                    }
                });
                return;
            }

            // Handle serverEnvVars object
            if (key === 'serverEnvVars' && typeof value === 'object' && value !== null) {
                if (!this.manager.config.serverEnvVars) {
                    this.manager.config.serverEnvVars = {};
                }
                const cliServerEnvVars = (this.manager.explicitConfig && this.manager.explicitConfig.serverEnvVars) || {};
                Object.entries(value).forEach(([envKey, envValue]) => {
                    if (!(envKey in cliServerEnvVars)) {
                        this.manager.config.serverEnvVars[envKey] = envValue;
                        this.manager._recordSource(`serverEnvVars.${envKey}`, envValue, 'config-file');
                    }
                });
                return;
            }

            if (this.manager._isSourceSupported(key, 'configFile')) {
                filteredConfig[key] = this.manager._parseValue(key, value);
                this.manager._recordSource(key, this.manager._parseValue(key, value), 'config-file');
            }
        });
        this.manager._mergeConfig(filteredConfig);
    }

    /**
     * Load from environment variables (filtered by matrix)
     * @private
     */
    async _loadEnvironmentVariables() {
        const envMapping = {};
        Object.entries(this.manager.parameterMatrix).forEach(([param, config]) => {
            if (config.envVar) {
                envMapping[config.envVar] = { param, ambient: false };
            }
            // Also check ambient env vars (e.g., AWS_REGION, AWS_ROLE, HF_TOKEN)
            if (config.ambientEnvVar) {
                envMapping[config.ambientEnvVar] = { param, ambient: true };
            }
        });

        Object.entries(envMapping).forEach(([envVar, { param: configKey, ambient }]) => {
            const value = process.env[envVar];
            if (value !== undefined && value !== '' && this.manager._isSourceSupported(configKey, 'envVar')) {
                this.manager.config[configKey] = this.manager._parseValue(configKey, value);
                this.manager._recordSource(configKey, this.manager._parseValue(configKey, value), 'env-var');
                if (!ambient) {
                    if (!this.manager.explicitConfig) {
                        this.manager.explicitConfig = {};
                    }
                    this.manager.explicitConfig[configKey] = this.manager._parseValue(configKey, value);
                }
            }
        });
    }

    /**
     * Load from CLI arguments (positional)
     * @private
     */
    async _loadCliArguments() {
        if (this.manager.args && this.manager.args.length > 0) {
            this.manager.config.projectName = this.manager.args[0];
            if (!this.manager.explicitConfig) {
                this.manager.explicitConfig = {};
            }
            this.manager.explicitConfig.projectName = this.manager.args[0];
            this.manager.projectNameFromArgument = true;
        }
    }

    /**
     * Load from CLI options (highest precedence, filtered by matrix)
     * @private
     */
    async _loadCliOptions() {
        const options = this.manager.options;

        Object.entries(this.manager.parameterMatrix).forEach(([param, config]) => {
            if (config.cliOption && options[config.cliOption] !== undefined) {
                this.manager.config[param] = this.manager._parseValue(param, options[config.cliOption]);
                this.manager._recordSource(param, this.manager._parseValue(param, options[config.cliOption]), 'cli');
                if (!this.manager.explicitConfig) {
                    this.manager.explicitConfig = {};
                }
                this.manager.explicitConfig[param] = this.manager._parseValue(param, options[config.cliOption]);
            }
        });

        // Parse --model-env KEY=VALUE pairs
        this._parseEnvVarOptions('model-env', 'modelEnvVars');

        // Parse --server-env KEY=VALUE pairs
        this._parseEnvVarOptions('server-env', 'serverEnvVars');
    }

    /**
     * Normalizes deprecated parameter values to their canonical equivalents.
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
            const currentValue = this.manager.config[param];
            if (currentValue && aliases[currentValue]) {
                const { canonical, message } = aliases[currentValue];
                console.log(`\n⚠️  Deprecation: ${message}`);
                this.manager.config[param] = canonical;
                if (this.manager.explicitConfig && this.manager.explicitConfig[param] === currentValue) {
                    this.manager.explicitConfig[param] = canonical;
                }
            }
        }
    }

    /**
     * Parse --model-env or --server-env CLI options into env var collections.
     * @param {string} optionName - CLI option name
     * @param {string} configKey - Config key to store results
     * @private
     */
    _parseEnvVarOptions(optionName, configKey) {
        const rawValue = this.manager.options[optionName];
        if (rawValue === undefined || rawValue === null) {
            return;
        }

        const values = Array.isArray(rawValue) ? rawValue : [rawValue];

        if (!this.manager.config[configKey] || typeof this.manager.config[configKey] !== 'object') {
            this.manager.config[configKey] = {};
        }

        for (const entry of values) {
            if (typeof entry !== 'string' || entry.trim() === '') {
                continue;
            }
            const { key, value } = parseKeyValue(entry);
            this.manager.config[configKey][key] = value;
            this.manager._recordSource(`${configKey}.${key}`, value, 'cli');
        }

        if (Object.keys(this.manager.config[configKey]).length > 0) {
            if (!this.manager.explicitConfig) {
                this.manager.explicitConfig = {};
            }
            this.manager.explicitConfig[configKey] = { ...this.manager.config[configKey] };
        }
    }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Config Validator - Handles configuration validation.
 * Uses delegation pattern: receives parent ConfigManager reference to access shared state.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from './config-manager.js';
import { validationRules } from './generated/validation-rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tritonBackendsCatalogPath = resolve(__dirname, '../../servers/lib/catalogs/triton-backends.json');

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

export default class ConfigValidator {
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Validates the current configuration against the parameter matrix
     * @returns {Array} Array of validation errors
     */
    validateConfiguration() {
        const errors = [];
        const m = this.manager;

        const oldFormatMigration = {
            'sklearn-flask': 'Use --deployment-config=http-flask --engine=sklearn instead',
            'sklearn-fastapi': 'Use --deployment-config=http-fastapi --engine=sklearn instead',
            'xgboost-flask': 'Use --deployment-config=http-flask --engine=xgboost instead',
            'xgboost-fastapi': 'Use --deployment-config=http-fastapi --engine=xgboost instead',
            'tensorflow-flask': 'Use --deployment-config=http-flask --engine=tensorflow instead',
            'tensorflow-fastapi': 'Use --deployment-config=http-fastapi --engine=tensorflow instead'
        };

        if (m.config.deploymentConfig) {
            const migrationMsg = oldFormatMigration[m.config.deploymentConfig];
            if (migrationMsg) {
                errors.push(`Unsupported deployment-config: ${m.config.deploymentConfig}. This value has been replaced. ${migrationMsg}`);
            } else if (!m.deploymentConfigResolver.isValid(m.config.deploymentConfig)) {
                const valid = m.deploymentConfigResolver.getAllConfigs().join(', ');
                errors.push(`Unsupported deployment-config: ${m.config.deploymentConfig}. Valid configs: ${valid}`);
            }
        }

        if (m.config.engine) {
            const validEngines = ['sklearn', 'xgboost', 'tensorflow'];
            if (!validEngines.includes(m.config.engine)) {
                errors.push(`Unsupported engine: ${m.config.engine}. Supported: ${validEngines.join(', ')}`);
            }
        }

        if (m.config.modelFormat && m.config.deploymentConfig) {
            try {
                const parts = m.deploymentConfigResolver.decompose(m.config.deploymentConfig);
                if (parts.architecture === 'http') {
                    const engine = m.config.engine || parts.engine;
                    if (engine) {
                        const supportedOptions = this._getSupportedOptions();
                        const validFormats = supportedOptions.modelFormats[engine] || [];
                        if (validFormats.length > 0 && !validFormats.includes(m.config.modelFormat)) {
                            errors.push(`Unsupported model format '${m.config.modelFormat}' for engine '${engine}'. Supported: ${validFormats.join(', ')}`);
                        }
                    }
                }
            } catch {
                // deploymentConfig already flagged as invalid above
            }
        }

        if (m.config.hfToken && m.config.hfTokenArn) {
            errors.push('Cannot specify both --hf-token and --hf-token-arn. Use one or the other.');
        }
        if (m.config.ngcTokenArn) {
            const ngcTokenFromCli = m.options['ngc-token'];
            if (ngcTokenFromCli) {
                errors.push('Cannot specify both --ngc-token and --ngc-token-arn. Use one or the other.');
            }
        }

        if (m.config.awsRoleArn) {
            try {
                this._isValidArn(m.config.awsRoleArn);
            } catch (error) {
                if (error instanceof ValidationError) {
                    errors.push(error.message);
                } else {
                    errors.push(`Invalid AWS Role ARN format: ${m.config.awsRoleArn}. Expected format: arn:aws:iam::123456789012:role/RoleName`);
                }
            }
        }

        const buildTarget = m.config.buildTarget || m.config.deployTarget;
        if (buildTarget && !this._getSupportedOptions().buildTargets.includes(buildTarget)) {
            errors.push(`Unsupported build target: ${buildTarget}. Supported targets: ${this._getSupportedOptions().buildTargets.join(', ')}`);
        }

        if (m.config.codebuildComputeType && !this._getSupportedOptions().codebuildComputeTypes.includes(m.config.codebuildComputeType)) {
            errors.push(`Unsupported CodeBuild compute type: ${m.config.codebuildComputeType}. Supported types: ${this._getSupportedOptions().codebuildComputeTypes.join(', ')}`);
        }

        if (m.config.codebuildProjectName) {
            const projectNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_]{1,254}$/;
            if (!projectNamePattern.test(m.config.codebuildProjectName)) {
                errors.push(`Invalid CodeBuild project name: ${m.config.codebuildProjectName}. Project names must be 2-255 characters, start with a letter or number, and contain only letters, numbers, hyphens, and underscores.`);
            }
        }

        if (m.config.modelPackageArn) {
            const modelPackageArnPattern = /^arn:aws:sagemaker:[a-z0-9-]+:\d{12}:model-package\/[a-zA-Z0-9]([a-zA-Z0-9-])*\/\d+$/;
            if (!modelPackageArnPattern.test(m.config.modelPackageArn)) {
                errors.push('❌ Invalid model package ARN format. Expected: arn:aws:sagemaker:<region>:<account>:model-package/<name>/<version>');
            }
        }

        if (m.skipPrompts) {
            Object.entries(m.parameterMatrix).forEach(([param, config]) => {
                if (config.required &&
                    (m.config[param] === null || m.config[param] === undefined)) {

                    if (param === 'modelFormat') {
                        try {
                            const parts = m.deploymentConfigResolver.decompose(m.config.deploymentConfig);
                            if (parts.architecture === 'transformers' || parts.architecture === 'triton' || parts.architecture === 'diffusors') {
                                return;
                            }
                        } catch {
                            return;
                        }
                    }

                    if (config.promptable && config.default === null && !this._canAutoGenerate(param)) {
                        errors.push(`Required parameter '${param}' is missing and prompts are disabled`);
                    }
                }
            });

            if (m.config.deploymentConfig) {
                try {
                    const parts = m.deploymentConfigResolver.decompose(m.config.deploymentConfig);
                    if (parts.architecture === 'diffusors') {
                        const explicitModelName = m.explicitConfig && m.explicitConfig.modelName;
                        if (!explicitModelName) {
                            errors.push('Model name is required for diffusors architecture. Use --model-name to specify a HuggingFace diffusion model.');
                        }
                    }
                } catch {
                    // deploymentConfig already flagged as invalid above
                }
            }
        }

        // Validate schema-validated parameters
        Object.entries(m.parameterMatrix).forEach(([param, config]) => {
            if (config.schemaValidated && m.config[param] !== null && m.config[param] !== undefined) {
                const result = m.schemaValidator.validate(param, m.config[param], m.config.deploymentTarget);
                if (!result.valid) {
                    errors.push(result.error);
                }
            }
        });

        return errors;
    }

    /**
     * Validates required parameters before file generation
     * @param {Object} finalConfig - The complete configuration object
     * @returns {Array} Array of validation errors
     */
    validateRequiredParameters(finalConfig) {
        const errors = [];
        const m = this.manager;

        // Validate individual parameter values
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

        // Validate required parameters are present
        Object.entries(m.parameterMatrix).forEach(([param, config]) => {
            if (config.required) {
                const value = finalConfig[param];
                const isEmpty = value === null || value === undefined || value === '';

                if (param === 'modelFormat' && (finalConfig.architecture === 'transformers' || finalConfig.architecture === 'triton' || finalConfig.architecture === 'diffusors' || finalConfig.architecture === 'marketplace')) {
                    return;
                }

                if (finalConfig.architecture === 'marketplace' && (param === 'includeSampleModel' || param === 'buildTarget')) {
                    return;
                }

                if (param === 'instanceType' && finalConfig.deploymentTarget === 'hyperpod-eks' && !finalConfig.instanceType) {
                    return;
                }

                if (param === 'instanceType' && finalConfig.existingEndpointName) {
                    return;
                }

                if (isEmpty) {
                    if (config.promptable) {
                        errors.push(`Required parameter '${param}' is missing. This parameter is required for ${finalConfig.architecture || 'the selected'} architecture.`);
                    } else {
                        errors.push(`Required non-promptable parameter '${param}' is missing. This parameter must be provided through CLI options, environment variables, or configuration files.`);
                    }
                }
            }
        });

        // Validate parameter combinations
        const combinationErrors = this._validateParameterCombinations(finalConfig);
        errors.push(...combinationErrors);

        return errors;
    }

    /**
     * Validates parameter combinations and dependencies
     * @param {Object} config - The configuration object to validate
     * @returns {Array} Array of validation errors
     * @private
     */
    _validateParameterCombinations(config) {
        const errors = [];

        if (config.architecture === 'transformers' && config.includeSampleModel === true) {
            errors.push(`Architecture '${config.architecture}' does not support sample models. The 'includeSampleModel' parameter will be automatically set to false.`);
        }
        if (config.architecture === 'diffusors' && config.includeSampleModel === true) {
            errors.push(`Architecture '${config.architecture}' does not support sample models. The 'includeSampleModel' parameter will be automatically set to false.`);
        }
        if (config.architecture === 'triton' && config.includeSampleModel === true) {
            const backendMeta = tritonBackends[config.backend];
            if (!backendMeta || !backendMeta.supportsSampleModel) {
                errors.push(`Triton backend '${config.backend}' does not support sample models. The 'includeSampleModel' parameter will be automatically set to false.`);
            }
        }

        return errors;
    }

    /**
     * Validates a single parameter value
     * @param {string} parameter - Parameter name
     * @param {*} value - Parameter value
     * @param {Object} context - Additional context
     * @throws {ValidationError} If parameter value is invalid
     * @private
     */
    _validateParameterValue(parameter, value, context = {}) {
        const m = this.manager;

        // Schema-derived validation rules
        const schemaRule = validationRules[parameter];
        if (schemaRule && value !== null && value !== undefined) {
            const skipSchemaValidation = ['framework', 'modelServer', 'deploymentConfig', 'deploymentTarget', 'codebuildComputeType'].includes(parameter);
            if (!skipSchemaValidation) {
                const error = schemaRule(value);
                if (error) {
                    throw new ValidationError(error, parameter, value);
                }
            }
        }

        const supportedOptions = this._getSupportedOptions();

        switch (parameter) {
        case 'deploymentConfig':
            if (value) {
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
                if (!m.deploymentConfigResolver.isValid(value)) {
                    const valid = m.deploymentConfigResolver.getAllConfigs().join(', ');
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
                const instancePattern = /^ml\.[a-z0-9]+\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/;
                if (!instancePattern.test(value)) {
                    throw new ValidationError(
                        `Invalid instance type format: ${value}. Expected format: ml.{family}.{size} (e.g., ml.m5.large, ml.g4dn.xlarge)`,
                        parameter,
                        value
                    );
                }
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

        case 'modelPackageArn':
            if (value) {
                const modelPackageArnPattern = /^arn:aws:sagemaker:[a-z0-9-]+:\d{12}:model-package\/[a-zA-Z0-9]([a-zA-Z0-9-])*\/\d+$/;
                if (!modelPackageArnPattern.test(value)) {
                    throw new ValidationError(
                        '❌ Invalid model package ARN format. Expected: arn:aws:sagemaker:<region>:<account>:model-package/<name>/<version>',
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
     */
    _resolveHfToken(tokenValue) {
        if (!tokenValue || tokenValue.trim() === '') {
            return null;
        }

        if (tokenValue.trim() === '$HF_TOKEN') {
            const envToken = process.env.HF_TOKEN;
            if (!envToken) {
                console.warn('⚠️  Warning: $HF_TOKEN specified but HF_TOKEN environment variable is not set');
                console.warn('   The container will be built without authentication.');
                return null;
            }
            return envToken;
        }

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
            deploymentConfigs: this.manager.deploymentConfigResolver.getAllConfigs(),
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

    /**
     * Fills auto-prompt defaults for parameters that have sensible defaults.
     * @private
     */
    _fillAutoPromptDefaults() {
        const m = this.manager;
        if (!m.explicitConfig) {
            m.explicitConfig = {};
        }

        let architecture = m.config.architecture;
        if (!architecture && m.config.deploymentConfig) {
            try {
                const parts = m.deploymentConfigResolver.decompose(m.config.deploymentConfig);
                architecture = parts.architecture;
                m.config.architecture = parts.architecture;
                m.config.backend = parts.backend;
                m.config.engine = parts.engine;
            } catch {
                // Invalid deploymentConfig — will be caught by validation
            }
        }

        Object.entries(m.parameterMatrix).forEach(([param, config]) => {
            if (m.explicitConfig[param] !== undefined && m.explicitConfig[param] !== null) {
                return;
            }

            if (!config.required) {
                if (m.config[param] !== undefined && m.config[param] !== null) {
                    m.explicitConfig[param] = m.config[param];
                } else if (config.default !== null && config.default !== undefined) {
                    m.config[param] = config.default;
                    m.explicitConfig[param] = config.default;
                }
                return;
            }

            if (m.config[param] === undefined || m.config[param] === null) {
                if (param === 'instanceType') {
                    const arch = architecture || 'http';
                    m.config[param] = arch === 'http' ? 'ml.m5.large' : 'ml.g5.xlarge';
                } else if (param === 'modelFormat') {
                    if (architecture === 'transformers' || architecture === 'triton' || architecture === 'diffusors') {
                        return;
                    }
                    const engine = m.config.engine || 'sklearn';
                    const formatMap = { sklearn: 'pkl', xgboost: 'json', tensorflow: 'keras' };
                    m.config[param] = formatMap[engine] || 'pkl';
                } else if (param === 'projectName') {
                    m.config[param] = m._generateProjectName(architecture);
                } else {
                    return;
                }
            }

            if (m.config[param] !== undefined && m.config[param] !== null) {
                if (config.default !== null || this._canAutoGenerate(param)) {
                    m.explicitConfig[param] = m.config[param];
                }
            }
        });
    }

    /**
     * Returns whether auto-prompt mode is active
     * @returns {boolean}
     */
    isAutoPrompt() {
        return this.manager.autoPrompt;
    }

    /**
     * Gets the list of required parameters that are truly missing.
     * @returns {string[]} Array of parameter names that need prompting
     */
    getMissingRequiredParameters() {
        const m = this.manager;
        const missing = [];

        Object.entries(m.parameterMatrix).forEach(([param, config]) => {
            if (!config.required || !config.promptable) return;

            const value = m.config[param];
            const hasValue = value !== undefined && value !== null;

            if (hasValue) return;

            if (param === 'modelFormat') {
                const architecture = m.config.architecture;
                if (architecture === 'transformers' || architecture === 'triton' || architecture === 'diffusors') {
                    return;
                }
                if (m.config.engine || m.config.deploymentConfig) {
                    return;
                }
            }

            if (this._canAutoGenerate(param)) return;
            if (config.default !== null && config.default !== undefined) return;

            missing.push(param);
        });

        return missing;
    }

    /**
     * Checks if a parameter can be auto-generated when missing
     * @param {string} param - Parameter name
     * @returns {boolean}
     * @private
     */
    _canAutoGenerate(param) {
        const autoGeneratable = [
            'modelFormat',
            'includeSampleModel',
            'includeTesting',
            'instanceType'
        ];
        return autoGeneratable.includes(param);
    }
}

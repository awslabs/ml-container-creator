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
    frameworkPrompts,
    frameworkVersionPrompts,
    frameworkProfilePrompts,
    modelFormatPrompts,
    modelServerPrompts,
    modelProfilePrompts,
    hfTokenPrompts,
    ngcApiKeyPrompts,
    modulePrompts,
    infrastructurePrompts,
    projectPrompts,
    destinationPrompts
} from './prompts.js';

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

        // Phase 1: Core Configuration (deployment config first)
        console.log('\n🔧 Core Configuration');
        const deploymentConfigAnswers = await this._runPhase(deploymentConfigPrompts, {}, explicitConfig, existingConfig);
        
        // Derive framework and modelServer from deploymentConfig
        // Requirements: 16.3
        let framework, modelServer;
        if (deploymentConfigAnswers.deploymentConfig) {
            const parts = deploymentConfigAnswers.deploymentConfig.split('-');
            framework = parts[0];
            // Handle multi-part model servers (e.g., tensorrt-llm)
            modelServer = parts.slice(1).join('-');
        }
        
        // Add derived values to answers
        const frameworkAnswers = {
            ...deploymentConfigAnswers,
            framework: framework || deploymentConfigAnswers.framework,
            modelServer: modelServer || deploymentConfigAnswers.modelServer
        };
        
        // Populate framework version choices from registry
        const frameworkVersionChoices = this._getFrameworkVersionChoices(frameworkAnswers.framework);
        const frameworkVersionAnswers = await this._runPhase(
            frameworkVersionPrompts, 
            {...frameworkAnswers, _frameworkVersionChoices: frameworkVersionChoices}, 
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
            {...frameworkAnswers, ...frameworkVersionAnswers, _frameworkProfileChoices: frameworkProfileChoices},
            explicitConfig,
            existingConfig
        );
        
        const modelFormatAnswers = await this._runPhase(
            modelFormatPrompts, 
            {...frameworkAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers}, 
            explicitConfig, 
            existingConfig
        );
        
        // Model server prompts are now deprecated (empty array)
        const modelServerAnswers = await this._runPhase(
            modelServerPrompts, 
            {...frameworkAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers}, 
            explicitConfig, 
            existingConfig
        );
        
        // Populate model profile choices from registry (if model ID is available)
        const currentAnswers = {...frameworkAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers, ...modelFormatAnswers, ...modelServerAnswers};
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
            { ...frameworkAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers, ...modelFormatAnswers, ...modelServerAnswers, ...modelProfileAnswers }, 
            explicitConfig, existingConfig);

        const ngcApiKeyAnswers = await this._runPhase(ngcApiKeyPrompts,
            { ...frameworkAnswers, ...frameworkVersionAnswers, ...frameworkProfileAnswers, ...modelFormatAnswers, ...modelServerAnswers, ...modelProfileAnswers },
            explicitConfig, existingConfig);

        // Phase 2: Module Selection
        console.log('\n📦 Module Selection');
        const moduleAnswers = await this._runPhase(modulePrompts, frameworkAnswers, explicitConfig, existingConfig);
        
        // Ensure transformers don't get sample model
        if (frameworkAnswers.framework === 'transformers') {
            moduleAnswers.includeSampleModel = false;
        }

        // Phase 3: Infrastructure & Performance
        console.log('\n💪 Infrastructure & Performance');
        const infraAnswers = await this._runPhase(infrastructurePrompts, frameworkAnswers, explicitConfig, existingConfig);

        // Validate instance type against framework requirements
        // Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
        const instanceType = infraAnswers.customInstanceType || infraAnswers.instanceType;
        if (instanceType && frameworkVersionAnswers.frameworkVersion) {
            await this._validateAndDisplayInstanceType(
                instanceType,
                frameworkAnswers.framework,
                frameworkVersionAnswers.frameworkVersion
            );
        }

        // Show warning for SageMaker deployment target
        // Note: sagemaker deploy target has been removed; only codebuild is supported

        // Phase 4: Project Configuration (moved to end)
        console.log('\n📋 Project Configuration');
        const allTechnicalAnswers = {
            ...frameworkAnswers,
            ...modelFormatAnswers,
            ...modelServerAnswers,
            ...moduleAnswers,
            ...infraAnswers
        };
        const projectAnswers = await this._runPhase(projectPrompts, allTechnicalAnswers, explicitConfig, existingConfig);
        const destinationAnswers = await this._runPhase(destinationPrompts, 
            { ...allTechnicalAnswers, ...projectAnswers }, explicitConfig, existingConfig);

        // Phase 5: Deployment Instructions
        this._showDeploymentInstructions();

        // Combine all answers
        const combinedAnswers = {
            ...frameworkAnswers,
            ...frameworkVersionAnswers,
            ...frameworkProfileAnswers,
            ...modelFormatAnswers,
            ...modelServerAnswers,
            ...modelProfileAnswers,
            ...hfTokenAnswers,
            ...ngcApiKeyAnswers,
            ...moduleAnswers,
            ...infraAnswers,
            ...projectAnswers,
            ...destinationAnswers,
            buildTimestamp
        };

        // Handle custom model name for transformers
        if (combinedAnswers.framework === 'transformers' && combinedAnswers.customModelName) {
            combinedAnswers.modelName = combinedAnswers.customModelName;
            delete combinedAnswers.customModelName;
        }

        // Handle custom instance type
        if (combinedAnswers.customInstanceType) {
            combinedAnswers.instanceType = combinedAnswers.customInstanceType;
            delete combinedAnswers.customInstanceType;
        }

        // Handle custom AWS region
        if (combinedAnswers.customAwsRegion) {
            combinedAnswers.awsRegion = combinedAnswers.customAwsRegion;
            delete combinedAnswers.customAwsRegion;
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
            choices: prompt.choices ? (answers) => {
                if (typeof prompt.choices === 'function') {
                    return prompt.choices({...allPreviousAnswers, ...answers});
                }
                return prompt.choices;
            } : undefined
        })));
    }

    /**
     * Shows deployment instructions to user
     * @private
     */
    _showDeploymentInstructions() {
        console.log('\n🚀 Manual Deployment');
        console.log('\n☁️ The following steps assume authentication to an AWS account.');
        console.log('\n💰 The following commands will incur charges to your AWS account.');
        console.log('\t ./build_and_push.sh -- Builds the image and pushes to ECR.');
        console.log('\t ./deploy.sh -- Deploys the image to a SageMaker AI Managed Inference Endpoint.');
        console.log('\t\t deploy.sh needs a valid IAM Role ARN as a parameter.');
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
        console.log(`   • Source: Framework_Registry`);
        
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
                    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
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
        const registryConfigManager = this.generator.registryConfigManager;
        
        if (!registryConfigManager) {
            return;
        }
        
        console.log(`\n🔍 Fetching model information for: ${modelId}`);
        
        const sources = [];
        let chatTemplate = null;
        let modelFamily = null;
        
        // Try HuggingFace API first
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
            
            // Try pattern matching if no exact match
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
                    chatTemplate = modelConfig.chatTemplate; // Model registry overrides HF
                }
                if (modelConfig.family) {
                    modelFamily = modelConfig.family;
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
}


// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt Runner - Orchestrates the prompting phases with clear user feedback
 * 
 * This module handles running prompts in organized phases with console output
 * to guide users through the configuration process.
 */

import {
    frameworkPrompts,
    modelFormatPrompts,
    modelServerPrompts,
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

        // Phase 1: Core Configuration (framework first)
        console.log('\n🔧 Core Configuration');
        const frameworkAnswers = await this._runPhase(frameworkPrompts, {}, existingConfig);
        const modelFormatAnswers = await this._runPhase(modelFormatPrompts, frameworkAnswers, existingConfig);
        const modelServerAnswers = await this._runPhase(modelServerPrompts, frameworkAnswers, existingConfig);

        // Phase 2: Module Selection
        console.log('\n📦 Module Selection');
        const moduleAnswers = await this._runPhase(modulePrompts, frameworkAnswers, existingConfig);
        
        // Ensure transformers don't get sample model
        if (frameworkAnswers.framework === 'transformers') {
            moduleAnswers.includeSampleModel = false;
        }

        // Phase 3: Infrastructure & Performance
        console.log('\n💪 Infrastructure & Performance');
        const infraAnswers = await this._runPhase(infrastructurePrompts, frameworkAnswers, existingConfig);

        // Phase 4: Project Configuration (moved to end)
        console.log('\n📋 Project Configuration');
        const allTechnicalAnswers = {
            ...frameworkAnswers,
            ...modelFormatAnswers,
            ...modelServerAnswers,
            ...moduleAnswers,
            ...infraAnswers
        };
        const projectAnswers = await this._runPhase(projectPrompts, allTechnicalAnswers, existingConfig);
        const destinationAnswers = await this._runPhase(destinationPrompts, 
            { ...allTechnicalAnswers, ...projectAnswers }, existingConfig);

        // Phase 5: Deployment Instructions
        this._showDeploymentInstructions();

        // Combine all answers
        return {
            ...frameworkAnswers,
            ...modelFormatAnswers,
            ...modelServerAnswers,
            ...moduleAnswers,
            ...infraAnswers,
            ...projectAnswers,
            ...destinationAnswers,
            buildTimestamp
        };
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
    async _runPhase(prompts, previousAnswers = {}, existingConfig = {}) {
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
            // Skip prompt if we already have the value from config
            when: prompt.when ? (answers) => {
                // Skip if we have the value from existing config
                if (existingConfig[prompt.name] !== undefined && existingConfig[prompt.name] !== null) {
                    return false;
                }
                return prompt.when({...allPreviousAnswers, ...answers});
            } : (existingConfig[prompt.name] !== undefined && existingConfig[prompt.name] !== null) ? 
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
}


// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt Runner - Orchestrates the prompting phases with clear user feedback
 * 
 * This module handles running prompts in organized phases with console output
 * to guide users through the configuration process.
 */

const {
    projectPrompts,
    destinationPrompts,
    frameworkPrompts,
    modelFormatPrompts,
    modelServerPrompts,
    modulePrompts,
    infrastructurePrompts
} = require('./prompts');

class PromptRunner {
    constructor(generator) {
        this.generator = generator;
    }

    /**
     * Runs all prompting phases and returns combined answers
     * @returns {Promise<Object>} Combined answers from all phases
     */
    async run() {
        const buildTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        // Phase 1: Project Configuration
        console.log('\n📋 Project Configuration');
        const projectAnswers = await this._runPhase(projectPrompts);
        const destinationAnswers = await this._runPhase(destinationPrompts, projectAnswers);

        // Phase 2: Core Configuration
        console.log('\n🔧 Core Configuration');
        const frameworkAnswers = await this._runPhase(frameworkPrompts);
        const modelFormatAnswers = await this._runPhase(modelFormatPrompts, frameworkAnswers);
        const modelServerAnswers = await this._runPhase(modelServerPrompts, frameworkAnswers);

        // Phase 3: Module Selection
        console.log('\n📦 Module Selection');
        const moduleAnswers = await this._runPhase(modulePrompts, frameworkAnswers);
        
        // Ensure transformers don't get sample model
        if (frameworkAnswers.framework === 'transformers') {
            moduleAnswers.includeSampleModel = false;
        }

        // Phase 4: Infrastructure & Performance
        console.log('\n💪 Infrastructure & Performance');
        const infraAnswers = await this._runPhase(infrastructurePrompts, frameworkAnswers);

        // Phase 5: Deployment Instructions
        this._showDeploymentInstructions();

        // Combine all answers
        return {
            ...projectAnswers,
            ...destinationAnswers,
            ...frameworkAnswers,
            ...modelFormatAnswers,
            ...modelServerAnswers,
            ...moduleAnswers,
            ...infraAnswers,
            buildTimestamp
        };
    }

    /**
     * Runs a single phase of prompts
     * @private
     */
    async _runPhase(prompts, previousAnswers = {}) {
        if (prompts.length === 0) return {};
        
        return await this.generator.prompt(prompts.map(prompt => ({
            ...prompt,
            // Provide access to previous answers for conditional logic
            when: prompt.when ? (answers) => prompt.when({...previousAnswers, ...answers}) : undefined,
            choices: prompt.choices ? (answers) => {
                if (typeof prompt.choices === 'function') {
                    return prompt.choices({...previousAnswers, ...answers});
                }
                return prompt.choices;
            } : undefined,
            default: prompt.default ? (answers) => {
                if (typeof prompt.default === 'function') {
                    return prompt.default({...previousAnswers, ...answers});
                }
                return prompt.default;
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

module.exports = PromptRunner;
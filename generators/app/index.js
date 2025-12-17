// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const Generator = require('yeoman-generator').default || require('yeoman-generator');
const PromptRunner = require('./lib/prompt-runner');
const TemplateManager = require('./lib/template-manager');

/**
 * ML Container Creator Generator
 * 
 * Generates Docker containers for deploying ML models to AWS SageMaker
 * using the Bring Your Own Container (BYOC) paradigm.
 * 
 * This generator is organized into clear phases:
 * 1. Prompting - Collect user configuration via PromptRunner
 * 2. Validation - Validate configuration via TemplateManager
 * 3. Writing - Copy and process templates based on configuration
 * 
 * @extends Generator
 * @see https://yeoman.io/authoring/
 */
module.exports = class extends Generator {

    /**
     * Prompting phase - Collects user input through interactive prompts.
     * 
     * Uses PromptRunner to organize prompts into logical phases with clear
     * console output to guide users through the configuration process.
     * 
     * @async
     * @returns {Promise<void>}
     */
    async prompting() {
        const promptRunner = new PromptRunner(this);
        this.answers = await promptRunner.run();
    }

    /**
     * Writing phase - Copies and processes template files.
     * 
     * Uses TemplateManager to determine which templates to include/exclude
     * based on user configuration, then copies and processes all templates.
     * 
     * @returns {void}
     */
    writing() {
        // Set destination directory for generated files
        this.destinationRoot(this.answers.destinationDir);

        // Create template manager and validate configuration
        const templateManager = new TemplateManager(this.answers);
        
        try {
            templateManager.validate();
        } catch (error) {
            this.env.error(error.message);
            return;
        }

        // Get ignore patterns based on configuration
        const ignorePatterns = templateManager.getIgnorePatterns();

        // Copy all templates, processing EJS variables and excluding ignored patterns
        this.fs.copyTpl(
            this.templatePath('**/*'),
            this.destinationPath(),
            this.answers,
            {},
            { globOptions: { ignore: ignorePatterns } }
        );
    }


};
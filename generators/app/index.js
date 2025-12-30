// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Generator from 'yeoman-generator';
import PromptRunner from './lib/prompt-runner.js';
import TemplateManager from './lib/template-manager.js';
import ConfigManager from './lib/config-manager.js';
import CliHandler from './lib/cli-handler.js';

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
export default class extends Generator {

    /**
     * Constructor - Set up CLI options
     */
    constructor(args, opts) {
        super(args, opts);

        // Define CLI options
        this.option('skip-prompts', {
            type: Boolean,
            description: 'Skip interactive prompts and use configuration from other sources'
        });

        this.option('config', {
            type: String,
            description: 'Path to configuration file'
        });

        this.option('help', {
            type: Boolean,
            alias: 'h',
            description: 'Show help information'
        });

        // Project configuration options
        this.option('project-name', {
            type: String,
            description: 'Project name'
        });

        this.option('project-dir', {
            type: String,
            description: 'Output directory path'
        });

        // Core configuration options
        this.option('framework', {
            type: String,
            description: 'ML framework (sklearn, xgboost, tensorflow, transformers)'
        });

        this.option('model-format', {
            type: String,
            description: 'Model serialization format'
        });

        this.option('model-server', {
            type: String,
            description: 'Model server (flask, fastapi, vllm, sglang)'
        });

        // Module options
        this.option('include-sample', {
            type: Boolean,
            description: 'Include sample model code'
        });

        this.option('include-testing', {
            type: Boolean,
            description: 'Include test suite'
        });

        this.option('test-types', {
            type: String,
            description: 'Comma-separated list of test types'
        });

        // Infrastructure options
        this.option('deploy-target', {
            type: String,
            description: 'Deployment target (sagemaker)'
        });

        this.option('instance-type', {
            type: String,
            description: 'Instance type (cpu-optimized, gpu-enabled)'
        });

        this.option('region', {
            type: String,
            description: 'AWS region'
        });

        this.option('role-arn', {
            type: String,
            description: 'AWS IAM role ARN for SageMaker execution'
        });
    }

    /**
     * Initializing phase - Load configuration from all sources
     */
    async initializing() {
        // Handle special CLI arguments first
        const cliHandler = new CliHandler(this);
        const handled = await cliHandler.handleCliArguments();
        
        if (handled) {
            // Special command was executed, exit early
            // Set a flag to indicate we should skip other phases
            this._helpShown = true;
            return;
        }

        this.configManager = new ConfigManager(this);
        
        try {
            this.baseConfig = await this.configManager.loadConfiguration();
        } catch (error) {
            // Configuration loading failed - show error and exit
            console.log(`⚠️  ${error.message}`);
            this._configurationFailed = true;
            return;
        }

        // Validate configuration and set error flag if invalid
        const errors = this.configManager.validateConfiguration();
        if (errors.length > 0) {
            console.log(`⚠️  ${errors[0]}`);
            this._validationFailed = true;
            return;
        }

        // Show configuration source info if not skipping prompts
        if (!this.configManager.shouldSkipPrompts()) {
            console.log('\n⚙️  Configuration will be collected from prompts and merged with:');
            if (this.baseConfig.projectName !== 'ml-container-creator') {
                console.log(`   • Project name: ${this.baseConfig.projectName}`);
            }
            if (this.baseConfig.framework) {
                console.log(`   • Framework: ${this.baseConfig.framework}`);
            }
            if (Object.keys(this.baseConfig).filter(k => this.baseConfig[k] !== null && k !== 'projectName').length === 0) {
                console.log('   • No external configuration found');
            }
        }
    }

    /**
     * Prompting phase - Collects user input through interactive prompts.
     * 
     * Uses PromptRunner to organize prompts into logical phases with clear
     * console output to guide users through the configuration process.
     * Skips prompting if --skip-prompts is used or complete configuration exists.
     * 
     * @async
     * @returns {Promise<void>}
     */
    async prompting() {
        // If help was shown, validation failed, or ConfigManager doesn't exist, skip prompting
        if (this._helpShown || this._validationFailed || !this.configManager) {
            return;
        }

        if (this.configManager.shouldSkipPrompts()) {
            console.log('\n🚀 Skipping prompts - using configuration from other sources');
            this.answers = this.configManager.getFinalConfiguration();
            return;
        }

        const promptRunner = new PromptRunner(this);
        const promptAnswers = await promptRunner.run();
        
        // Merge prompt answers with configuration from other sources
        this.answers = this.configManager.getFinalConfiguration(promptAnswers);
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
        // If help was shown, validation failed, configuration failed, or no answers, skip writing
        if (this._helpShown || this._validationFailed || this._configurationFailed || !this.answers) {
            return;
        }

        // Validate required parameters before file generation
        if (this.configManager) {
            const requiredParamErrors = this.configManager.validateRequiredParameters(this.answers);
            if (requiredParamErrors.length > 0) {
                console.log('\n❌ Required Parameter Validation Failed:');
                requiredParamErrors.forEach(error => {
                    console.log(`   • ${error}`);
                });
                console.log('\nPlease provide the missing required parameters and try again.');
                this.env.error('Required parameters are missing. Cannot proceed with file generation.');
                return;
            }
        }

        // Set destination directory for generated files
        this.destinationRoot(this.answers.destinationDir);

        // Create template manager and validate configuration
        const templateManager = new TemplateManager(this.answers);
        
        try {
            templateManager.validate();
        } catch (error) {
            this.env.error(error.message);
            throw error; // Re-throw the error so tests can catch it
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

}
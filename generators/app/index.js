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

        this.option('model-name', {
            type: String,
            description: 'Hugging Face model name (for transformers framework)'
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
            description: 'Deployment target (sagemaker, codebuild)'
        });

        this.option('codebuild-compute-type', {
            type: String,
            description: 'CodeBuild compute type (BUILD_GENERAL1_SMALL, BUILD_GENERAL1_MEDIUM, BUILD_GENERAL1_LARGE)'
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

    /**
     * End phase - Post-processing tasks after file generation
     * 
     * Runs the sample model training script if includeSampleModel is true
     * to generate the actual model file for immediate use.
     * 
     * @async
     * @returns {Promise<void>}
     */
    async end() {
        // If help was shown, validation failed, configuration failed, or no answers, skip end phase
        if (this._helpShown || this._validationFailed || this._configurationFailed || !this.answers) {
            return;
        }

        // Run sample model training if requested
        if (this.answers.includeSampleModel && this.answers.framework !== 'transformers') {
            await this._runSampleModelTraining();
        }
        
        // Set executable permissions on shell scripts
        this._setExecutablePermissions();
    }

    /**
     * Runs the sample model training script to generate the model file
     * @private
     */
    async _runSampleModelTraining() {
        const { spawn } = await import('child_process');

        console.log('\n🤖 Training sample model...');
        console.log('This will generate the model file needed for Docker build.');

        const trainingScript = this.destinationPath('sample_model/train_abalone.py');
        const sampleModelDir = this.destinationPath('sample_model');

        try {
            // Check if training script exists
            if (!this.fs.exists(trainingScript)) {
                console.log('⚠️  Training script not found, skipping model training');
                return;
            }

            // Run the training script
            await new Promise((resolve, _reject) => {
                const pythonProcess = spawn('python', ['train_abalone.py'], {
                    cwd: sampleModelDir,
                    stdio: 'inherit'
                });

                pythonProcess.on('close', (code) => {
                    if (code === 0) {
                        console.log('✅ Sample model training completed successfully!');
                        console.log(`📁 Model file saved in: ${sampleModelDir}`);
                        resolve();
                    } else {
                        console.log(`⚠️  Training script exited with code ${code}`);
                        console.log('You may need to install dependencies: pip install -r requirements.txt');
                        console.log('Or run the training manually: python sample_model/train_abalone.py');
                        resolve(); // Don't fail the generator, just warn
                    }
                });

                pythonProcess.on('error', (error) => {
                    console.log('⚠️  Could not run training script automatically');
                    console.log('Error:', error.message);
                    console.log('Please run manually: python sample_model/train_abalone.py');
                    resolve(); // Don't fail the generator, just warn
                });
            });

        } catch (error) {
            console.log('⚠️  Error during sample model training:', error.message);
            console.log('Please run manually: python sample_model/train_abalone.py');
        }
    }
    
    /**
     * Set executable permissions on shell scripts
     * @private
     */
    _setExecutablePermissions() {
        const shellScripts = [
            'deploy/build_and_push.sh',
            'deploy/deploy.sh', 
            'deploy/submit_build.sh',
            'deploy/upload_to_s3.sh'
        ];
        
        shellScripts.forEach(script => {
            const scriptPath = this.destinationPath(script);
            try {
                const fs = require('fs');
                if (fs.existsSync(scriptPath)) {
                    const stats = fs.statSync(scriptPath);
                    const newMode = stats.mode | parseInt('755', 8);
                    fs.chmodSync(scriptPath, newMode);
                }
            } catch (error) {
                // Silently continue if chmod fails (e.g., on Windows)
            }
        });
    }

}
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Generator from 'yeoman-generator';
import PromptRunner from './lib/prompt-runner.js';
import TemplateManager from './lib/template-manager.js';
import ConfigManager from './lib/config-manager.js';
import CliHandler from './lib/cli-handler.js';
import ConfigurationManager from './lib/configuration-manager.js';

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
        this.option('deployment-config', {
            type: String,
            description: 'Deployment configuration (sklearn-flask, sklearn-fastapi, xgboost-flask, xgboost-fastapi, tensorflow-flask, tensorflow-fastapi, transformers-vllm, transformers-sglang, transformers-tensorrt-llm, transformers-lmi, transformers-djl)'
        });

        this.option('framework', {
            type: String,
            description: 'ML framework (sklearn, xgboost, tensorflow, transformers) - DEPRECATED: use --deployment-config instead'
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
            description: 'Model server (flask, fastapi, vllm, sglang) - DEPRECATED: use --deployment-config instead'
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

        this.option('hf-token', {
            type: String,
            description: 'HuggingFace authentication token (or "$HF_TOKEN" to use environment variable)'
        });

        // Validation flags
        this.option('validate-env-vars', {
            type: Boolean,
            description: 'Enable environment variable validation (default: true)'
        });

        this.option('validate-with-docker', {
            type: Boolean,
            description: 'Enable Docker-based introspection validation (default: false, opt-in only)'
        });

        this.option('offline', {
            type: Boolean,
            description: 'Disable HuggingFace API lookups for offline mode (default: false)'
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
            this._validationError = errors[0];
            return;
        }

        // Initialize multi-registry configuration manager
        // Requirements: 1.7, 2.8
        try {
            // Determine validation flags with precedence: CLI > env vars > config file > defaults
            // Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 11.12
            const validateEnvVars = this._getValidationFlag('validate-env-vars', 'VALIDATE_ENV_VARS', true);
            const validateWithDocker = this._getValidationFlag('validate-with-docker', 'VALIDATE_WITH_DOCKER', false);
            const offline = this._getValidationFlag('offline', 'OFFLINE_MODE', false);
            
            // If validate-with-docker is enabled but validate-env-vars is disabled, warn and disable Docker validation
            // Requirements: 13.7
            let effectiveValidateWithDocker = validateWithDocker;
            if (validateWithDocker && !validateEnvVars) {
                console.log('\n⚠️  Warning: --validate-with-docker requires --validate-env-vars to be enabled');
                console.log('   Docker validation will be disabled');
                effectiveValidateWithDocker = false;
            }
            
            this.registryConfigManager = new ConfigurationManager({
                validateEnvVars,
                validateWithDocker: effectiveValidateWithDocker,
                offline,
                hfTimeout: 5000
            });
            
            // Load registries during initialization
            await this.registryConfigManager.loadRegistries();
            
            console.log('\n📚 Registry System Initialized');
            console.log('   • Framework Registry: Loaded');
            console.log('   • Model Registry: Loaded');
            console.log('   • Instance Accelerator Mapping: Loaded');
            
            // Show validation configuration
            if (validateEnvVars) {
                console.log('   • Environment Variable Validation: Enabled');
                if (effectiveValidateWithDocker) {
                    console.log('   • Docker Introspection Validation: Enabled (experimental)');
                }
            } else {
                console.log('   • Environment Variable Validation: Disabled');
            }
            
            if (offline) {
                console.log('   • HuggingFace API: Offline mode');
            }
        } catch (error) {
            // Graceful degradation - continue without registries
            console.log('\n⚠️  Registry system initialization failed, using defaults');
            console.log(`   Error: ${error.message}`);
            this.registryConfigManager = null;
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
            if (this.baseConfig.hfToken) {
                // Mask token value, only show reference
                const tokenDisplay = this.baseConfig.hfToken === '$HF_TOKEN' ? '$HF_TOKEN' : '***';
                console.log(`   • HuggingFace token: ${tokenDisplay}`);
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
            
            // Ensure all template variables are initialized
            await this._ensureTemplateVariables();
            
            return;
        }

        const promptRunner = new PromptRunner(this);
        const promptAnswers = await promptRunner.run();
        
        // Merge prompt answers with configuration from other sources
        this.answers = this.configManager.getFinalConfiguration(promptAnswers);
        
        // Ensure all template variables are initialized
        await this._ensureTemplateVariables();
    }

    /**
     * Writing phase - Copies and processes template files.
     * 
     * Validates configuration via TemplateManager, then copies and processes
     * all template files unconditionally. With do-framework integration,
     * conditional logic has been moved to runtime scripts rather than
     * template generation time.
     * 
     * @returns {void}
     */
    async writing() {
        // If help was shown, validation failed, configuration failed, or no answers, skip writing
        if (this._helpShown || this._configurationFailed || !this.answers) {
            return;
        }
        
        // If validation failed in initializing phase, throw the error now
        if (this._validationFailed && this._validationError) {
            this.env.error(this._validationError);
            throw new Error(this._validationError);
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
                const errorMessage = 'Required parameters are missing. Cannot proceed with file generation.';
                this.env.error(errorMessage);
                throw new Error(errorMessage); // Throw so tests can catch it
            }
        }

        // Validate environment variables if registry system is available
        // Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.19, 13.20, 13.21, 13.22, 13.23
        if (this.registryConfigManager && this.answers.frameworkVersion) {
            await this._validateEnvironmentVariables();
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

        // Generate comments for templates using CommentGenerator
        const CommentGenerator = (await import('./lib/comment-generator.js')).default;
        const commentGenerator = new CommentGenerator();
        const comments = commentGenerator.generateDockerfileComments(this.answers);
        
        // Prepare ordered environment variables for template
        const orderedEnvVars = this._getOrderedEnvVars(this.answers.envVars || {});

        // Prepare template variables with comments and ordered env vars
        const templateVars = {
            ...this.answers,
            comments,
            orderedEnvVars
        };

        // Copy all templates, processing EJS variables
        // No conditional file exclusion - all files are generated
        // Runtime scripts handle framework-specific and deployment-specific logic
        this.fs.copyTpl(
            this.templatePath('**/*'),
            this.destinationPath(),
            templateVars
        );

        // Copy PROJECT_README.md as README.md in the generated project
        this.fs.copyTpl(
            this.templatePath('PROJECT_README.md'),
            this.destinationPath('README.md'),
            templateVars
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
            'deploy/upload_to_s3.sh',
            'do/build',
            'do/push',
            'do/deploy',
            'do/run',
            'do/test',
            'do/clean',
            'do/submit'
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

    /**
     * Get validation flag value with precedence: CLI > env vars > config file > defaults
     * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 11.12
     * @param {string} cliOptionName - Name of the CLI option (e.g., 'validate-env-vars')
     * @param {string} envVarName - Name of the environment variable (e.g., 'VALIDATE_ENV_VARS')
     * @param {boolean} defaultValue - Default value if not specified anywhere
     * @returns {boolean} The resolved flag value
     * @private
     */
    _getValidationFlag(cliOptionName, envVarName, defaultValue) {
        // Precedence order: CLI > env vars > config file > defaults
        
        // 1. Check CLI option (highest priority)
        if (this.options[cliOptionName] !== undefined) {
            return this.options[cliOptionName];
        }
        
        // 2. Check environment variable
        if (process.env[envVarName] !== undefined) {
            // Convert string to boolean
            const envValue = process.env[envVarName].toLowerCase();
            return envValue === 'true' || envValue === '1' || envValue === 'yes';
        }
        
        // 3. Check config file (if loaded)
        if (this.baseConfig && this.baseConfig[cliOptionName] !== undefined) {
            return this.baseConfig[cliOptionName];
        }
        
        // 4. Use default value
        return defaultValue;
    }

    /**
     * Validate environment variables using registry system
     * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.19, 13.20, 13.21, 13.22, 13.23
     * @private
     */
    async _validateEnvironmentVariables() {
        // Get framework configuration
        const frameworkConfig = this.registryConfigManager.frameworkRegistry?.[this.answers.framework]?.[this.answers.frameworkVersion];
        
        if (!frameworkConfig || !frameworkConfig.envVars) {
            return; // No env vars to validate
        }
        
        console.log('\n🔍 Validating environment variables...');
        
        // Validate environment variables
        const validationResult = this.registryConfigManager.validateEnvironmentVariables(
            frameworkConfig.envVars,
            frameworkConfig
        );
        
        // Display validation results
        if (validationResult.errors && validationResult.errors.length > 0) {
            console.log('\n❌ Environment Variable Validation Errors:');
            validationResult.errors.forEach(error => {
                console.log(`   • ${error.key}: ${error.message}`);
            });
            
            // If skip-prompts is enabled, throw error immediately
            if (this.options['skip-prompts']) {
                throw new Error('Environment variable validation failed. Please fix the errors and try again.');
            }
            
            // Require user confirmation to proceed
            const proceed = await this.prompt([{
                type: 'confirm',
                name: 'proceedWithErrors',
                message: 'Environment variable validation found errors. Proceed anyway?',
                default: false
            }]);
            
            if (!proceed.proceedWithErrors) {
                throw new Error('Environment variable validation failed. Please fix the errors and try again.');
            }
        }
        
        if (validationResult.warnings && validationResult.warnings.length > 0) {
            console.log('\n⚠️  Environment Variable Validation Warnings:');
            validationResult.warnings.forEach(warning => {
                console.log(`   • ${warning.key ? `${warning.key}: ` : ''}${warning.message}`);
            });
        }
        
        if (validationResult.strategiesUsed && validationResult.strategiesUsed.length > 0) {
            console.log(`\n✅ Validation methods used: ${validationResult.strategiesUsed.join(', ')}`);
        }
        
        if (!validationResult.errors || validationResult.errors.length === 0) {
            if (!validationResult.warnings || validationResult.warnings.length === 0) {
                console.log('   ✅ All environment variables validated successfully');
            }
        }
    }

    /**
     * Get environment variables in correct order
     * Preserves dependency order (e.g., CUDA paths before framework variables)
     * @private
     * @param {Object} envVars - Environment variables object
     * @returns {Array<{key: string, value: string}>} Ordered array of env vars
     */
    _getOrderedEnvVars(envVars) {
        const entries = Object.entries(envVars);
        
        // Define priority order for environment variable categories
        const priorities = {
            // System paths (highest priority)
            'LD_LIBRARY_PATH': 1,
            'PATH': 1,
            'CUDA_HOME': 1,
            'CUDA_PATH': 1,
            
            // CUDA configuration
            'CUDA_VISIBLE_DEVICES': 2,
            'NVIDIA_VISIBLE_DEVICES': 2,
            'NVIDIA_DRIVER_CAPABILITIES': 2,
            
            // Framework-specific (medium priority)
            'VLLM': 3,
            'TENSORRT': 3,
            'SGLANG': 3,
            'TRANSFORMERS': 3,
            
            // Application configuration (lower priority)
            'MAX': 4,
            'BATCH': 4,
            'WORKER': 4,
            'THREAD': 4,
            
            // Other variables (lowest priority)
            'default': 5
        };

        // Sort entries by priority
        const sorted = entries.sort(([keyA], [keyB]) => {
            const priorityA = this._getEnvVarPriority(keyA, priorities);
            const priorityB = this._getEnvVarPriority(keyB, priorities);
            
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }
            
            // If same priority, sort alphabetically
            return keyA.localeCompare(keyB);
        });

        // Convert to array of objects for template
        return sorted.map(([key, value]) => ({ key, value }));
    }

    /**
     * Get priority for an environment variable
     * @private
     * @param {string} key - Environment variable name
     * @param {Object} priorities - Priority mapping
     * @returns {number} Priority value (lower = higher priority)
     */
    _getEnvVarPriority(key, priorities) {
        // Check for exact match first
        if (priorities[key]) {
            return priorities[key];
        }

        // Check for partial matches
        for (const [pattern, priority] of Object.entries(priorities)) {
            if (pattern !== 'default' && key.includes(pattern)) {
                return priority;
            }
        }

        // Default priority
        return priorities.default;
    }

    /**
     * Ensure all template variables are initialized with proper defaults
     * This prevents "undefined" errors in templates
     * @private
     */
    async _ensureTemplateVariables() {
        // Initialize all template variables with defaults to prevent "undefined" errors
        const defaults = {
            chatTemplate: null,
            chatTemplateSource: null,
            hfToken: null,
            envVars: {},
            inferenceAmiVersion: null,
            accelerator: null,
            frameworkVersion: null,
            validationLevel: 'unknown',
            configSources: [],
            recommendedInstanceTypes: []
        };
        
        // Apply defaults for any missing fields
        Object.entries(defaults).forEach(([key, value]) => {
            if (this.answers[key] === undefined) {
                this.answers[key] = value;
            }
        });
        
        // For transformer models, try to enrich with registry data if available
        if (this.answers.framework === 'transformers' && this.answers.modelName && this.registryConfigManager) {
            try {
                // Fetch HuggingFace data for model-specific info
                const hfData = await this.registryConfigManager._fetchHuggingFaceData(this.answers.modelName);
                
                // Merge chatTemplate if available and not already set
                if (hfData && hfData.chatTemplate && !this.answers.chatTemplate) {
                    this.answers.chatTemplate = hfData.chatTemplate;
                    this.answers.chatTemplateSource = 'HuggingFace_Hub_API';
                }
                
                // Check Model Registry for overrides
                if (this.registryConfigManager.modelRegistry) {
                    let modelConfig = this.registryConfigManager.modelRegistry[this.answers.modelName];
                    
                    // Try pattern matching if no exact match
                    if (!modelConfig) {
                        for (const [pattern, config] of Object.entries(this.registryConfigManager.modelRegistry)) {
                            if (pattern.includes('*')) {
                                const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
                                if (regex.test(this.answers.modelName)) {
                                    modelConfig = config;
                                    break;
                                }
                            }
                        }
                    }
                    
                    // Apply model registry overrides
                    if (modelConfig) {
                        if (modelConfig.chatTemplate) {
                            this.answers.chatTemplate = modelConfig.chatTemplate;
                            this.answers.chatTemplateSource = 'Model_Registry';
                        }
                        if (modelConfig.envVars) {
                            this.answers.envVars = { ...this.answers.envVars, ...modelConfig.envVars };
                        }
                    }
                }
                
                // Fetch framework-specific data if frameworkVersion is available
                if (this.answers.frameworkVersion && this.registryConfigManager.frameworkRegistry) {
                    const frameworkConfig = this.registryConfigManager.frameworkRegistry[this.answers.framework]?.[this.answers.frameworkVersion];
                    
                    if (frameworkConfig) {
                        // Merge framework environment variables
                        if (frameworkConfig.envVars) {
                            this.answers.envVars = { ...frameworkConfig.envVars, ...this.answers.envVars };
                        }
                        
                        // Set inference AMI version
                        if (frameworkConfig.inferenceAmiVersion) {
                            this.answers.inferenceAmiVersion = frameworkConfig.inferenceAmiVersion;
                        }
                        
                        // Set accelerator info
                        if (frameworkConfig.accelerator) {
                            this.answers.accelerator = frameworkConfig.accelerator;
                        }
                    }
                }
            } catch (error) {
                // Silently continue - defaults are already set
            }
        }
    }

}
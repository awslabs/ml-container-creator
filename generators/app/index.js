// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const fs = require('fs');
const path = require('path');
const os = require('os');
const Generator = require('yeoman-generator').default || require('yeoman-generator');

// Module-level constant for reusability across generator methods
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.ml-container-creator-rc.json');

/**
 * ML Container Creator Generator
 * 
 * Generates Docker containers for deploying ML models to AWS SageMaker
 * using the Bring Your Own Container (BYOC) paradigm.
 * 
 * @extends Generator
 * @see https://yeoman.io/authoring/
 */
module.exports = class extends Generator {
/**
 * Tracks which features are currently implemented and available.
 * Used for validation to prevent users from selecting unsupported options.
 * 
 * @type {Object}
 * @property {string[]} frameworks - Supported ML frameworks
 * @property {string[]} modelServer - Supported model serving frameworks
 * @property {string[]} deployment - Supported deployment targets
 * @property {string[]} testTypes - Available test types
 * @property {string[]} instanceTypes - Supported instance configurations
 * @property {string[]} awsRegions - Available AWS regions
 */
    SUPPORTED_OPTIONS = {
        frameworks: ['sklearn', 'xgboost', 'tensorflow', 'transformers'],
        modelServer: ['flask', 'fast-api', 'vllm', 'sglang'],
        deployment: ['sagemaker'],
        testTypes: ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'],
        instanceTypes: ['cpu-optimized'],
        awsRegions: ['us-east-1']
    };

    /**
     * Initializing phase - Handles pre-run configuration checks.
     * 
     * Checks for the existence of a global configuration file. If found, loads 
     * the configuration. If not found (first-time setup), prompts the user to 
     * configure defaults and saves them to the global config file.
     * 
     * @returns {Promise<void>}
     */
    async initializing() {
        this.log('🔍 Checking for existing configuration...');
        this.globalConfig = {};
        
        // Check if config exists before attempting to read
        if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
            try {
                this.globalConfig = JSON.parse(await fs.promises.readFile(GLOBAL_CONFIG_PATH, 'utf8'));
                this.log('✅ Configuration found. Loading defaults...');
            } catch (e) {
                // Log error details if file is corrupted
                this.log('⚠️ Could not read configuration file: ' + (e && e.message ? e.message : e) + '. Using defaults.');
            }
        } else {
            this.log('\n👋 First time setup detected! Please configure your defaults.');
            
            // Prompt only on first run
            const setupAnswers = await this.prompt([
                {
                    type: 'list',
                    name: 'defaultAwsRegion',
                    message: 'What is your preferred default AWS Region?',
                    choices: ['us-east-1'],
                    default: 'us-east-1'
                }
            ]);

            this.globalConfig = setupAnswers;
            
            // Save configuration asynchronously to avoid blocking the event loop
            try {
                await fs.promises.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(this.globalConfig, null, 2), { mode: 0o600 });
                this.log(`✅ Configuration saved to ${GLOBAL_CONFIG_PATH}\n`);
            } catch (err) {
                this.log('⚠️ Could not save configuration file: ' + (err && err.message ? err.message : err));
            }
        }
    }

    /**
     * Prompting phase - Collects user input through interactive prompts.
     * 
     * Prompts are organized into logical phases:
     * 1. Project Configuration - Basic project setup
     * 2. Core Configuration - ML framework and model details
     * 3. Module Selection - Optional features (sample model, tests)
     * 4. Infrastructure & Performance - Deployment settings
     * 
     * All answers are stored in this.answers for use in the writing phase.
     * 
     * @async
     * @returns {Promise<void>}
     */
    async prompting() {

        // Generate timestamp for unique project directory names
        const buildTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        
        // Phase 1: Project Configuration
        // Collect basic project information before framework-specific questions
        console.log('\n📋 Project Configuration');
        const projectNameAnswer = await this.prompt([
            {
                type: 'input',
                name: 'projectName',
                message: 'What is the Project Name?',
                default: 'ml-container-creator'
            }
        ]);
        const destinationAnswer = await this.prompt([
            {
                type: 'input',
                name: 'destinationDir',
                message: 'Where will the output directory be?',
                default: `./${projectNameAnswer.projectName}-${buildTimestamp}`
            }
        ]);
        const projectAnswers = { ...projectNameAnswer, ...destinationAnswer };

        // Phase 2: Core Configuration
        // Framework and model server selection - determines template structure
        console.log('\n🔧 Core Configuration');
        const coreAnswers = await this.prompt([
            {
                type: 'list',
                name: 'framework',
                message: 'Which ML framework are you using?',
                choices: ['sklearn', 'xgboost', 'tensorflow', 'transformers'],
                when: answers => answers.framework !== 'transformers'
            },
            {
                type: 'list',
                name: 'modelFormat',
                message: 'In which format is your model serialized?',
                // Model format choices are framework-specific
                choices: (answers) => {
                    if (answers.framework === 'xgboost') {
                        return ['json', 'model', 'ubj'];
                    }
                    if (answers.framework === 'sklearn') {
                        return ['pkl', 'joblib'];
                    }
                    if (answers.framework === 'tensorflow') {
                        return ['keras', 'h5', 'SavedModel'];
                    }
                },
                // Transformers load from Hugging Face Hub, no format selection needed
                when: answers => answers.framework !== 'transformers'
            },
            {
                type: 'list',
                name: 'modelServer',
                message: 'Which model server are you serving with?',
                // Traditional ML uses Flask/FastAPI, transformers use vLLM/SGLang
                choices: (answers) => { 
                    if (answers.framework !== 'transformers') {
                        return ['flask', 'fastapi'];
                    }
                    if (answers.framework === 'transformers') {
                        return ['vllm', 'sglang'];
                    }
                }
            }
        ]);

        // Phase 3: Module Selection
        // Optional features that can be included in the generated project
        console.log('\n📦 Module Selection');
        const moduleAnswers = await this.prompt([
            {
                type: 'confirm',
                name: 'includeSampleModel',
                message: 'Include sample Abalone classifier?',
                default: false,
                // Sample model only available for traditional ML frameworks
                when: () => coreAnswers.framework !== 'transformers'
            },
            {
                type: 'confirm',
                name: 'includeTesting',
                message: 'Include test suite?',
                default: true
            },
            {
                type: 'checkbox',
                name: 'testTypes',
                message: 'Test type?',
                choices: (answers) => {
                    // Transformers can only be tested on hosted endpoints (require GPU)
                    if (coreAnswers.framework === 'transformers') {
                        return ['hosted-model-endpoint'];
                    }
                    // Traditional ML can be tested locally or on hosted endpoints
                    return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
                },
                when: answers => answers.includeTesting,
                default: (answers) => {
                    if (coreAnswers.framework === 'transformers') {
                        return ['hosted-model-endpoint'];
                    }
                    return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
                }
            }
        ]);

        // Ensure transformers don't get sample model (not applicable)
        if (coreAnswers.framework === 'transformers') {
            moduleAnswers.includeSampleModel = false;
        }

        // Phase 4: Infrastructure & Performance
        // Deployment configuration and instance type selection
        console.log('\n💪 Infrastructure & Performance');
        const infraAnswers = await this.prompt([
            {
                type: 'list',
                name: 'deployTarget',
                message: 'Deployment target?',
                choices: ['sagemaker'],
                default: 'sagemaker'
            },
            {
                type: 'list',
                name: 'instanceType',
                message: 'Instance type?',
                choices: (answers) => {
                    // Traditional ML can run on CPU or GPU
                    if (coreAnswers.framework !== 'transformers') {
                        return ['cpu-optimized', 'gpu-enabled'];
                    }
                    // Transformers require GPU instances
                    if (coreAnswers.framework === 'transformers') {
                        return ['gpu-enabled'];
                    }
                },
                default: 'cpu-optimized'
            },
            {
                type: 'list',
                name: 'awsRegion',
                message: 'Target AWS region?',
                choices: ['us-east-1'],
                default: this.globalConfig?.defaultAwsRegion ?? 'us-east-1'
            }
        ]);

        // Phase 5: Deployment Instructions
        // Display important information about manual deployment steps
        console.log('\n🚀 Manual Deployment');
        console.log('\n☁️ The following steps assume authentication to an AWS account.');
        console.log('\n💰 The following commands will incur charges to your AWS account.');
        console.log('\t ./build_and_push.sh -- Builds the image and pushes to ECR.');
        console.log('\t ./deploy.sh -- Deploys the image to a SageMaker AI Managed Inference Endpoint.');
        console.log('\t\t deploy.sh needs a valid IAM Role ARN as a parameter.');

        // Combine all phase answers into single object for template processing
        this.answers = {
            ...projectAnswers,
            ...coreAnswers,
            ...moduleAnswers,
            ...infraAnswers,
            buildTimestamp
        };
    }

    /**
     * Writing phase - Copies and processes template files.
     * 
     * Templates are conditionally copied based on user configuration:
     * - Transformers exclude traditional ML serving code (Flask/FastAPI)
     * - Traditional ML excludes transformer serving code (vLLM/SGLang)
     * - Optional modules (sample model, tests) are excluded if not selected
     * 
     * All template files are processed with EJS, replacing variables with user answers.
     * 
     * @returns {void}
     */
    writing() {
        // Set destination directory for generated files
        this.destinationRoot(this.answers.destinationDir);

        // Build list of template files to exclude based on configuration
        const ignorePatterns = [
            // Exclude template system documentation (generators/app/templates/README.md)
            // This file documents how the template system works and should not be
            // copied to generated projects. It's synced to docs/template-system.md instead.
            '**/README.md'
        ];
        
        // Transformers use vLLM/SGLang with built-in serving
        // Exclude traditional ML serving infrastructure
        if (this.answers.framework === 'transformers')  {
            ignorePatterns.push('**/code/model_handler.py');  // Custom model loading
            ignorePatterns.push('**/code/start_server.py');   // Flask/FastAPI startup
            ignorePatterns.push('**/code/serve.py');          // Flask/FastAPI server
            ignorePatterns.push('**/nginx.conf**');           // Nginx reverse proxy
            ignorePatterns.push('**/requirements.txt**');     // Traditional ML dependencies
            ignorePatterns.push('**/test/test_local_image.sh');     // Local testing
            ignorePatterns.push('**/test/test_model_handler.py');   // Unit tests
        } else {
            // Traditional ML doesn't need transformer-specific files
            ignorePatterns.push('**/code/serve');              // vLLM/SGLang entrypoint
            ignorePatterns.push('**/deploy/upload_to_s3.sh'); // S3 model upload script
        }
        
        // Exclude non-Flask server code if Flask is not selected
        if (this.answers.modelServer !== 'flask') {
            ignorePatterns.push('**/code/flask/**');
        }
        
        // Exclude optional modules based on user selection
        if (!this.answers.includeSampleModel) {
            ignorePatterns.push('**/sample_model/**');
        }
        if (!this.answers.includeTesting) {
            ignorePatterns.push('**/test/**');
        }

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
     * Validates user answers against supported options.
     * 
     * Ensures users don't select configurations that aren't implemented yet.
     * Throws descriptive errors if unsupported options are detected.
     * 
     * Note: This method is currently unused but kept for future validation needs.
     * Consider calling this at the end of prompting() phase if validation is needed.
     * 
     * @private
     * @throws {Error} When an unsupported configuration is selected
     * @returns {void}
     */
    _validateAnswers() {
        const {
            framework,
            modelServer,
            deployTarget,
            testTypes,
            instanceType
        } = this.answers;

        // Validate framework selection
        if (!this.SUPPORTED_OPTIONS.frameworks.includes(framework)) {
            this.env.error(`⚠️  ${framework} not implemented yet.`);
        }

        // Validate model server selection
        if (!this.SUPPORTED_OPTIONS.modelServer.includes(modelServer)) {
            this.env.error(`⚠️  ${modelServer} not implemented yet.`);
        }

        // Validate deployment target
        if (!this.SUPPORTED_OPTIONS.deployment.includes(deployTarget)) {
            this.env.error(`⚠️  ${deployTarget} deployment not implemented yet.`);
        }

        // Validate test types (if testing is enabled)
        if (testTypes && !this.SUPPORTED_OPTIONS.testTypes.includes(testTypes)) {
            this.env.error(`⚠️  ${testTypes} tests not implemented yet.`);
        }

        // Validate instance type selection
        if (!this.SUPPORTED_OPTIONS.instanceTypes.includes(instanceType)) {
            this.env.error(`⚠️  ${instanceType} instances not implemented yet.`);
        }
    }
};

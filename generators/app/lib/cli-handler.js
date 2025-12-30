// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI Handler - Handles special CLI arguments and commands
 * 
 * Supports behavioral CLI arguments like:
 * - yo ml-container-creator configure
 * - yo ml-container-creator generate-empty-config
 * - yo ml-container-creator --help
 */

import fs from 'fs';
// import path from 'path'; // Unused import removed

export default class CliHandler {
    constructor(generator) {
        this.generator = generator;
    }

    /**
     * Handles special CLI arguments
     * @returns {boolean} True if special command was handled, false to continue normal flow
     */
    async handleCliArguments() {
        const args = this.generator.args;
        const options = this.generator.options;
        
        // Check for help flags in options first
        if (options.help || options.h) {
            this._showHelp();
            return true;
        }
        
        if (args.length === 0) {
            return false; // Normal generation flow
        }

        const command = args[0].toLowerCase();

        switch (command) {
        case 'configure':
            await this._handleConfigure();
            return true;
                
        case 'generate-empty-config':
            await this._handleGenerateEmptyConfig();
            return true;
                
        case 'help':
        case '--help':
        case '-h':
            this._showHelp();
            return true;
                
        default:
            // If it's not a special command, treat as project name
            return false;
        }
    }

    /**
     * Interactive configuration setup
     * @private
     */
    async _handleConfigure() {
        console.log('\n🔧 ML Container Creator Configuration');
        console.log('\nThis will help you set up configuration files for your project.\n');

        const answers = await this.generator.prompt([
            {
                type: 'list',
                name: 'configType',
                message: 'What type of configuration would you like to create?',
                choices: [
                    { name: 'Package.json section (recommended for projects)', value: 'package' },
                    { name: 'Custom config file (ml-container.config.json)', value: 'custom' },
                    { name: 'Show environment variable examples', value: 'env' },
                    { name: 'Show CLI option examples', value: 'cli' }
                ]
            }
        ]);

        switch (answers.configType) {
        case 'package':
            await this._createPackageJsonConfig();
            break;
        case 'custom':
            await this._createCustomConfig();
            break;
        case 'env':
            this._showEnvironmentExamples();
            break;
        case 'cli':
            this._showCliExamples();
            break;
        }
    }

    /**
     * Generate empty configuration file
     * @private
     */
    async _handleGenerateEmptyConfig() {
        const answers = await this.generator.prompt([
            {
                type: 'list',
                name: 'configType',
                message: 'Which configuration file format?',
                choices: [
                    { name: 'Custom config (ml-container.config.json)', value: 'custom' }
                ]
            }
        ]);

        const emptyConfig = this._getEmptyConfig();

        if (answers.configType === 'custom') {
            const configPath = 'ml-container.config.json';
            fs.writeFileSync(configPath, JSON.stringify(emptyConfig, null, 2));
            console.log(`\n✅ Created empty configuration file: ${configPath}`);
        }

        console.log('\n📝 Edit the configuration file and run the generator again.');
    }

    /**
     * Show comprehensive help
     * @private
     */
    _showHelp() {
        console.log(`
🚀 ML Container Creator Generator

USAGE:
  yo ml-container-creator [command] [project-name] [options]

COMMANDS:
  configure              Interactive configuration setup
  generate-empty-config  Generate empty configuration file
  help                   Show this help message

EXAMPLES:
  yo ml-container-creator                           # Interactive mode
  yo ml-container-creator my-project               # With project name
  yo ml-container-creator --skip-prompts           # Skip prompts, use config
  yo ml-container-creator --framework=sklearn      # With CLI options
  yo ml-container-creator --config=prod.json       # With config file

CLI OPTIONS:
  --skip-prompts              Skip interactive prompts
  --config=<file>             Load configuration from file
  --project-name=<name>       Project name
  --project-dir=<dir>         Output directory path
  --framework=<framework>     ML framework (sklearn|xgboost|tensorflow|transformers)
  --model-server=<server>     Model server (flask|fastapi|vllm|sglang)
  --model-format=<format>     Model format (depends on framework)
  --include-sample            Include sample model code
  --include-testing           Include test suite
  --instance-type=<type>      Instance type (cpu-optimized|gpu-enabled)
  --region=<region>           AWS region
  --role-arn=<arn>            AWS IAM role ARN for SageMaker execution

ENVIRONMENT VARIABLES:
  ML_INSTANCE_TYPE           Instance type
  AWS_REGION                 AWS region
  AWS_ROLE                   AWS IAM role ARN
  ML_CONTAINER_CREATOR_CONFIG Config file path

CONFIGURATION FILES (in precedence order):
  1. CLI options (highest precedence)
  2. Environment variables
  3. --config file
  4. ml-container.config.json
  5. package.json "ml-container-creator" section
  6. Generator defaults
  7. Interactive prompts (lowest precedence)

For more information, visit: https://github.com/awslabs/ml-container-creator
`);
    }

    /**
     * Create package.json configuration section
     * @private
     */
    async _createPackageJsonConfig() {
        const packageJsonPath = 'package.json';
        let packageJson = {};

        if (fs.existsSync(packageJsonPath)) {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        }

        const config = await this._promptForConfig();
        packageJson['ml-container-creator'] = config;

        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
        console.log(`\n✅ Added configuration to ${packageJsonPath}`);
        console.log('\n📝 You can now run: yo ml-container-creator --skip-prompts');
    }

    /**
     * Create custom configuration file
     * @private
     */
    async _createCustomConfig() {
        const config = await this._promptForConfig();
        const configPath = 'ml-container.config.json';
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`\n✅ Created configuration file: ${configPath}`);
        console.log('\n📝 You can now run: yo ml-container-creator --skip-prompts');
    }



    /**
     * Prompt for configuration values
     * @private
     */
    async _promptForConfig() {
        return await this.generator.prompt([
            {
                type: 'input',
                name: 'projectName',
                message: 'Project name:',
                default: 'my-ml-project'
            },
            {
                type: 'list',
                name: 'framework',
                message: 'ML framework:',
                choices: ['sklearn', 'xgboost', 'tensorflow', 'transformers']
            },
            {
                type: 'list',
                name: 'modelServer',
                message: 'Model server:',
                choices: (answers) => {
                    if (answers.framework === 'transformers') {
                        return ['vllm', 'sglang'];
                    }
                    return ['flask', 'fastapi'];
                }
            },
            {
                type: 'list',
                name: 'modelFormat',
                message: 'Model format:',
                choices: (answers) => {
                    const formatMap = {
                        'xgboost': ['json', 'model', 'ubj'],
                        'sklearn': ['pkl', 'joblib'],
                        'tensorflow': ['keras', 'h5', 'SavedModel']
                    };
                    return formatMap[answers.framework] || [];
                },
                when: answers => answers.framework !== 'transformers'
            },
            {
                type: 'confirm',
                name: 'includeSampleModel',
                message: 'Include sample model:',
                default: false,
                when: answers => answers.framework !== 'transformers'
            },
            {
                type: 'confirm',
                name: 'includeTesting',
                message: 'Include testing:',
                default: true
            },
            {
                type: 'list',
                name: 'instanceType',
                message: 'Instance type:',
                choices: (answers) => {
                    if (answers.framework === 'transformers') {
                        return ['gpu-enabled'];
                    }
                    return ['cpu-optimized', 'gpu-enabled'];
                },
                default: 'cpu-optimized'
            },
            {
                type: 'list',
                name: 'awsRegion',
                message: 'AWS region:',
                choices: ['us-east-1'],
                default: 'us-east-1'
            }
        ]);
    }

    /**
     * Show environment variable examples
     * @private
     */
    _showEnvironmentExamples() {
        console.log(`
🌍 Environment Variable Examples:

# Basic configuration
# Note: Core parameters (framework, model-server, etc.) are only supported via CLI options and config files

# Optional settings
export ML_INSTANCE_TYPE="cpu-optimized"
export AWS_REGION="us-east-1"
export AWS_ROLE="arn:aws:iam::123456789012:role/SageMakerRole"
export ML_CONTAINER_CREATOR_CONFIG="./my-config.json"

# Then run with CLI options for core parameters:
yo ml-container-creator --framework=sklearn --model-server=flask --model-format=pkl --skip-prompts
`);
    }

    /**
     * Show CLI option examples
     * @private
     */
    _showCliExamples() {
        console.log(`
💻 CLI Option Examples:

# Basic sklearn project
yo ml-container-creator my-sklearn-project \\
  --framework=sklearn \\
  --model-server=flask \\
  --model-format=pkl \\
  --skip-prompts

# Transformers project with vLLM
yo ml-container-creator my-llm-project \\
  --framework=transformers \\
  --model-server=vllm \\
  --instance-type=gpu-enabled \\
  --region=us-east-1 \\
  --skip-prompts

# XGBoost with FastAPI and custom role
yo ml-container-creator my-xgb-project \\
  --framework=xgboost \\
  --model-server=fastapi \\
  --model-format=json \\
  --include-sample \\
  --include-testing \\
  --role-arn=arn:aws:iam::123456789012:role/SageMakerRole \\
  --skip-prompts

# Using configuration file
yo ml-container-creator --config=production.json --skip-prompts
`);
    }

    /**
     * Get empty configuration template
     * @private
     */
    _getEmptyConfig() {
        return {
            'projectName': 'my-ml-project',
            'framework': 'sklearn',
            'modelServer': 'flask',
            'modelFormat': 'pkl',
            'includeSampleModel': false,
            'includeTesting': true,
            'testTypes': ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'],
            'deployTarget': 'sagemaker',
            'instanceType': 'cpu-optimized',
            'awsRegion': 'us-east-1'
        };
    }
}


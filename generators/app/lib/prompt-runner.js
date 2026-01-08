import chalk from 'chalk';
import inquirer from 'inquirer';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * PromptRunner handles the interactive prompts for the ML Container Creator.
 */
export default class PromptRunner {
  constructor(generator) {
    this.generator = generator;
  }
  
  import GlobalConfig from './global-config.js';

  /**
   * Run first-time setup wizard if global config doesn't exist
   */
  async runFirstTimeSetup() {
    const globalConfig = new GlobalConfig();
    
    if (!globalConfig.exists()) {
      this.generator.log(chalk.cyan('\n=============================================='));
      this.generator.log(chalk.cyan('Welcome to ML Container Creator!'));
      this.generator.log(chalk.cyan('==============================================\n'));
      this.generator.log('It looks like this is your first time running the generator.');
      this.generator.log('Let\'s set up some default configurations to make future runs easier.\n');
      
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'defaultRegion',
          message: 'Default AWS Region:',
          default: 'us-east-1'
        },
        {
          type: 'input',
          name: 'defaultInstanceType',
          message: 'Default SageMaker instance type:',
          default: 'ml.m5.xlarge'
        },
        {
          type: 'input',
          name: 'defaultRoleArn',
          message: 'Default SageMaker execution role ARN (leave empty to skip):',
          default: ''
        },
        {
          type: 'confirm',
          name: 'defaultIncludeTesting',
          message: 'Include testing infrastructure by default?',
          default: true
        }
      ]);
      
      globalConfig.save(answers);
      
      this.generator.log(chalk.green('\n✓ Configuration saved successfully!'));
      this.generator.log('You can update these settings anytime by running the generator with --reconfigure flag.\n');
    }
  }

  /**
   * Main method to run all prompts
   */
  async run() {
    await this.runFirstTimeSetup();
    
    const buildTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    
    this.generator.log(chalk.bold('\nML Container Creator'));
    this.generator.log(chalk.gray('Build intelligent ML containers for SageMaker\n'));

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectName',
        message: 'Project name:',
        default: this.generator.appname.replace(/\s+/g, '-').toLowerCase(),
        validate: (input) => {
          if (/^[a-z0-9-]+$/.test(input)) {
            return true;
          }
          return 'Project name must contain only lowercase letters, numbers, and hyphens';
        }
      },
      {
        type: 'input',
        name: 'projectDescription',
        message: 'Project description:',
        default: 'ML Container for Amazon SageMaker'
      },
      {
        type: 'list',
        name: 'mlFramework',
        message: 'Which ML framework would you like to use?',
        choices: [
          { name: 'TensorFlow', value: 'tensorflow' },
          { name: 'PyTorch', value: 'pytorch' },
          { name: 'Scikit-learn', value: 'scikit-learn' },
          { name: 'XGBoost', value: 'xgboost' },
          { name: 'Custom', value: 'custom' }
        ],
        default: 'tensorflow'
      },
      {
        type: 'list',
        name: 'containerType',
        message: 'Container type:',
        choices: [
          { name: 'Training', value: 'training' },
          { name: 'Inference', value: 'inference' },
          { name: 'Both (Training + Inference)', value: 'both' }
        ],
        default: 'both'
      },
      {
        type: 'input',
        name: 'awsRegion',
        message: 'AWS Region:',
        default: 'us-east-1'
      },
      {
        type: 'input',
        name: 'ecrRepository',
        message: 'ECR repository name:',
        default: (answers) => answers.projectName
      },
      {
        type: 'confirm',
        name: 'includeTesting',
        message: 'Include testing infrastructure?',
        default: true
      },
      {
        type: 'confirm',
        name: 'includeCI',
        message: 'Include CI/CD pipeline (GitHub Actions)?',
        default: true
      }
    ]);

    // Add derived properties
    answers.buildTimestamp = buildTimestamp;
    answers.needsTraining = answers.containerType === 'training' || answers.containerType === 'both';
    answers.needsInference = answers.containerType === 'inference' || answers.containerType === 'both';

    return answers;
  }
}

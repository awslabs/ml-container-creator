// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt definitions organized by phase for better maintainability.
 * Each phase handles a specific aspect of project configuration.
 */

/**
 * Phase 1: Basic project information
 */
const projectPrompts = [
    {
        type: 'input',
        name: 'projectName',
        message: 'What is the Project Name?',
        default: 'ml-container-creator'
    }
];

const destinationPrompts = [
    {
        type: 'input',
        name: 'destinationDir',
        message: 'Where will the output directory be?',
        default: (answers) => {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            return `./${answers.projectName}-${timestamp}`;
        }
    }
];

/**
 * Phase 2: Core ML configuration
 */
const frameworkPrompts = [
    {
        type: 'list',
        name: 'framework',
        message: 'Which ML framework are you using?',
        choices: ['sklearn', 'xgboost', 'tensorflow', 'transformers']
    }
];

const modelFormatPrompts = [
    {
        type: 'list',
        name: 'modelFormat',
        message: 'In which format is your model serialized?',
        choices: (answers) => {
            const formatMap = {
                'xgboost': ['json', 'model', 'ubj'],
                'sklearn': ['pkl', 'joblib'],
                'tensorflow': ['keras', 'h5', 'SavedModel']
            };
            return formatMap[answers.framework] || [];
        },
        when: answers => answers.framework !== 'transformers'
    }
];

const modelServerPrompts = [
    {
        type: 'list',
        name: 'modelServer',
        message: 'Which model server are you serving with?',
        choices: (answers) => {
            if (answers.framework === 'transformers') {
                return ['vllm', 'sglang'];
            }
            return ['flask', 'fastapi'];
        }
    }
];

/**
 * Phase 3: Optional modules
 */
const modulePrompts = [
    {
        type: 'confirm',
        name: 'includeSampleModel',
        message: 'Include sample Abalone classifier?',
        default: false,
        when: (answers) => answers.framework !== 'transformers'
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
            if (answers.framework === 'transformers') {
                return ['hosted-model-endpoint'];
            }
            return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
        },
        when: answers => answers.includeTesting,
        default: (answers) => {
            if (answers.framework === 'transformers') {
                return ['hosted-model-endpoint'];
            }
            return ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'];
        }
    }
];

/**
 * Phase 4: Infrastructure configuration
 */
const infrastructurePrompts = [
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
        message: 'Target AWS region?',
        choices: ['us-east-1'],
        default: 'us-east-1'
    }
];

module.exports = {
    projectPrompts,
    destinationPrompts,
    frameworkPrompts,
    modelFormatPrompts,
    modelServerPrompts,
    modulePrompts,
    infrastructurePrompts
};
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project prompt definitions.
 * Covers: project name, destination directory.
 */

/**
 * Generate pseudo-randomized project name based on framework
 * @param {string} framework - The ML framework
 * @returns {string} Generated project name
 */
function generateProjectName(framework) {
    const adjectives = [
        'smart', 'fast', 'clever', 'bright', 'swift', 'agile', 'sharp', 'quick',
        'wise', 'keen', 'bold', 'sleek', 'neat', 'cool', 'fresh', 'prime'
    ];
    
    const frameworkNames = {
        'sklearn': ['sklearn', 'scikit', 'sk'],
        'xgboost': ['xgb', 'xgboost', 'boost'],
        'tensorflow': ['tf', 'tensorflow', 'tensor'],
        'transformers': ['llm', 'transformer', 'gpt', 'bert', 'ai']
    };
    
    const suffixes = [
        'model', 'predictor', 'classifier', 'engine', 'service', 'api',
        'container', 'deployment', 'inference', 'ml', 'ai', 'bot'
    ];
    
    // Get random elements
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const frameworkName = frameworkNames[framework] ? 
        frameworkNames[framework][Math.floor(Math.random() * frameworkNames[framework].length)] :
        'ml';
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    
    return `${adjective}-${frameworkName}-${suffix}`;
}

const projectPrompts = [
    {
        type: 'input',
        name: 'projectName',
        message: 'What is the Project Name?',
        default: (answers) => {
            // Derive framework from deploymentConfig if not already set
            const framework = answers.framework || answers.deploymentConfig?.split('-')[0];
            return generateProjectName(framework);
        },
        validate: (input) => {
            if (!input || input.length < 2) {
                return 'Project name must be at least 2 characters.';
            }
            if (input.length > 63) {
                return 'Project name must be 63 characters or fewer.';
            }
            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(input)) {
                return 'Project name must be lowercase alphanumeric with hyphens (e.g. "qwen3-0-6b-v1-test"). No uppercase, dots, or underscores.';
            }
            return true;
        }
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

export {
    projectPrompts,
    destinationPrompts
};

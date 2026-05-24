// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marketplace Flow - Handles the marketplace-specific prompt flow.
 * Uses delegation pattern: receives parent PromptRunner reference to access shared state.
 */

import {
    infraAsyncPrompts,
    infraBatchTransformPrompts,
    projectPrompts,
    destinationPrompts
} from './prompts/index.js';

export default class MarketplaceFlow {
    constructor(runner) {
        this.runner = runner;
    }

    /**
     * Marketplace-specific prompt flow.
     * Skips all container-related prompts and prompts only for:
     * model package ARN, instance type, deployment target, region.
     *
     * Requirements: 2.3, 2.4, 2.5
     */
    async _runMarketplaceFlow(frameworkAnswers, explicitConfig, existingConfig, buildTimestamp) {
        console.log('\n🏪 Marketplace Model Package Configuration');

        // Query marketplace-picker MCP server for subscription discovery
        let mcpSubscriptions = [];
        const cm = this.runner.configManager;
        if (cm && cm.getMcpServerNames && cm.getMcpServerNames().includes('marketplace-picker')) {
            try {
                console.log('   🔍 Querying marketplace-picker for subscriptions...');
                const result = await cm.queryMcpServer('marketplace-picker', {
                    region: explicitConfig.awsRegion || existingConfig.awsRegion || process.env.AWS_REGION || 'us-east-1'
                });
                if (result && result.metadata?.subscriptions?.length > 0) {
                    mcpSubscriptions = result.metadata.subscriptions;
                    console.log(`   ✅ Found ${mcpSubscriptions.length} Marketplace subscription(s)`);
                } else {
                    console.log('   ℹ️  No Marketplace subscriptions found — enter ARN manually');
                }
            } catch (err) {
                console.log(`   ⚠️  marketplace-picker unavailable: ${err.message}`);
                console.log('   Falling back to manual ARN entry');
            }
        }

        // Marketplace-specific prompts: model package ARN
        const marketplacePrompts = [
            {
                type: mcpSubscriptions.length > 0 ? 'list' : 'input',
                name: 'modelPackageArn',
                message: mcpSubscriptions.length > 0
                    ? 'Select a Marketplace model package:'
                    : 'Model package ARN (arn:aws:sagemaker:<region>:<account>:model-package/<name>/<version>):',
                ...(mcpSubscriptions.length > 0 ? {
                    choices: [
                        ...mcpSubscriptions.map(sub => ({
                            name: `${sub.modelName} (${sub.vendor}) — ${sub.arn}`,
                            value: sub.arn,
                            short: sub.modelName
                        })),
                        { type: 'separator', separator: '──────────────' },
                        { name: 'Enter ARN manually...', value: '__manual__', short: 'manual' }
                    ]
                } : {
                    validate: (input) => {
                        if (!input || input.trim() === '') {
                            return 'Model package ARN is required';
                        }
                        const arnPattern = /^arn:aws:sagemaker:[a-z0-9-]+:\d{12}:model-package\/[\w-]+\/\d+$/;
                        if (!arnPattern.test(input.trim())) {
                            return 'Invalid ARN format. Expected: arn:aws:sagemaker:<region>:<account>:model-package/<name>/<version>';
                        }
                        return true;
                    }
                })
            },
            {
                type: 'input',
                name: 'modelPackageArnManual',
                message: 'Model package ARN (arn:aws:sagemaker:<region>:<account>:model-package/<name>/<version>):',
                when: (answers) => answers.modelPackageArn === '__manual__',
                validate: (input) => {
                    if (!input || input.trim() === '') {
                        return 'Model package ARN is required';
                    }
                    const arnPattern = /^arn:aws:sagemaker:[a-z0-9-]+:\d{12}:model-package\/[\w-]+\/\d+$/;
                    if (!arnPattern.test(input.trim())) {
                        return 'Invalid ARN format. Expected: arn:aws:sagemaker:<region>:<account>:model-package/<name>/<version>';
                    }
                    return true;
                }
            }
        ];
        const marketplaceAnswers = await this.runner._runPhase(marketplacePrompts, { ...frameworkAnswers }, explicitConfig, existingConfig);

        // Handle manual ARN entry fallback
        if (marketplaceAnswers.modelPackageArn === '__manual__' && marketplaceAnswers.modelPackageArnManual) {
            marketplaceAnswers.modelPackageArn = marketplaceAnswers.modelPackageArnManual;
            delete marketplaceAnswers.modelPackageArnManual;
        }

        // Infrastructure prompts: region, deployment target, instance type
        console.log('\n💪 Infrastructure & Deployment');
        const bootstrapRegion = existingConfig.awsRegion || explicitConfig.awsRegion;
        const regionPreviousAnswers = bootstrapRegion ? { _bootstrapRegion: bootstrapRegion } : {};

        const marketplaceInfraPrompts = [
            {
                type: 'list',
                name: 'awsRegion',
                message: 'Target AWS region?',
                choices: (answers) => {
                    const bootstrapReg = answers._bootstrapRegion;
                    const choices = ['us-east-1'];
                    if (bootstrapReg && bootstrapReg !== 'us-east-1') {
                        choices.unshift({ name: `${bootstrapReg} (from bootstrap profile)`, value: bootstrapReg });
                    }
                    choices.push({ name: 'Custom...', value: 'custom' });
                    return choices;
                },
                default: (answers) => answers._bootstrapRegion || 'us-east-1'
            },
            {
                type: 'input',
                name: 'customAwsRegion',
                message: 'Enter AWS region (e.g., us-west-2, eu-west-1):',
                when: answers => answers.awsRegion === 'custom'
            },
            {
                type: 'list',
                name: 'deploymentTarget',
                message: 'Deployment target?',
                choices: [
                    { name: 'SageMaker Real-Time Inference', value: 'realtime-inference' },
                    { name: 'SageMaker Async Inference', value: 'async-inference' },
                    { name: 'SageMaker Batch Transform', value: 'batch-transform' }
                ],
                default: 'realtime-inference'
            },
            {
                type: 'list',
                name: 'instanceType',
                message: 'Instance type for deployment?',
                choices: [
                    { name: 'ml.g5.xlarge (1 GPU, 24GB)', value: 'ml.g5.xlarge' },
                    { name: 'ml.g5.2xlarge (1 GPU, 24GB)', value: 'ml.g5.2xlarge' },
                    { name: 'ml.g5.4xlarge (1 GPU, 24GB)', value: 'ml.g5.4xlarge' },
                    { name: 'ml.g5.12xlarge (4 GPUs, 96GB)', value: 'ml.g5.12xlarge' },
                    { name: 'ml.p3.2xlarge (1 GPU, 16GB V100)', value: 'ml.p3.2xlarge' },
                    { name: 'ml.m5.xlarge (CPU, 16GB)', value: 'ml.m5.xlarge' },
                    { name: 'Custom...', value: 'custom' }
                ],
                default: 'ml.g5.xlarge'
            },
            {
                type: 'input',
                name: 'customInstanceType',
                message: 'Enter instance type (e.g., ml.g5.xlarge):',
                validate: (input) => {
                    if (!input || input.trim() === '') {
                        return 'Instance type is required';
                    }
                    if (!input.startsWith('ml.')) {
                        return 'Instance type must start with "ml." (e.g., ml.g5.xlarge)';
                    }
                    return true;
                },
                when: answers => answers.instanceType === 'custom'
            }
        ];
        const infraAnswers = await this.runner._runPhase(marketplaceInfraPrompts, { ...frameworkAnswers, ...regionPreviousAnswers }, explicitConfig, existingConfig);

        // Async-specific prompts
        let asyncAnswers = {};
        if (infraAnswers.deploymentTarget === 'async-inference') {
            asyncAnswers = await this.runner._runPhase(infraAsyncPrompts, { ...infraAnswers }, explicitConfig, existingConfig);
        }

        // Batch transform-specific prompts
        let batchTransformAnswers = {};
        if (infraAnswers.deploymentTarget === 'batch-transform') {
            batchTransformAnswers = await this.runner._runPhase(
                infraBatchTransformPrompts,
                { ...infraAnswers },
                explicitConfig,
                existingConfig
            );
        }

        // Role ARN prompt
        const rolePrompts = [
            {
                type: 'input',
                name: 'awsRoleArn',
                message: 'AWS IAM Role ARN for SageMaker execution (optional)?',
                validate: (input) => {
                    if (!input || input.trim() === '') {
                        return true;
                    }
                    const arnPattern = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
                    if (!arnPattern.test(input)) {
                        return 'Invalid ARN format. Expected: arn:aws:iam::123456789012:role/RoleName';
                    }
                    return true;
                }
            }
        ];
        const roleAnswers = await this.runner._runPhase(rolePrompts, { ...infraAnswers }, explicitConfig, existingConfig);

        // Project name + destination
        console.log('\n📋 Project Configuration');
        const allTechnicalAnswers = {
            ...frameworkAnswers,
            ...marketplaceAnswers,
            ...infraAnswers,
            ...asyncAnswers,
            ...batchTransformAnswers,
            ...roleAnswers
        };
        const projectAnswers = await this.runner._runPhase(projectPrompts, allTechnicalAnswers, explicitConfig, existingConfig);
        const destinationAnswers = await this.runner._runPhase(destinationPrompts,
            { ...allTechnicalAnswers, ...projectAnswers }, explicitConfig, existingConfig);

        // Combine all marketplace answers
        const combinedAnswers = {
            ...frameworkAnswers,
            ...marketplaceAnswers,
            ...infraAnswers,
            ...asyncAnswers,
            ...batchTransformAnswers,
            ...roleAnswers,
            ...projectAnswers,
            ...destinationAnswers,
            buildTimestamp
        };

        // Handle custom instance type
        if (combinedAnswers.customInstanceType) {
            combinedAnswers.instanceType = combinedAnswers.customInstanceType;
            delete combinedAnswers.customInstanceType;
        }

        // Handle custom AWS region
        if (combinedAnswers.customAwsRegion) {
            combinedAnswers.awsRegion = combinedAnswers.customAwsRegion;
            delete combinedAnswers.customAwsRegion;
        }

        // Map awsRoleArn to roleArn for templates
        if (combinedAnswers.awsRoleArn) {
            combinedAnswers.roleArn = combinedAnswers.awsRoleArn;
            delete combinedAnswers.awsRoleArn;
        }

        // Ensure CLI-provided values are in combinedAnswers
        if (explicitConfig.modelPackageArn && !combinedAnswers.modelPackageArn) {
            combinedAnswers.modelPackageArn = explicitConfig.modelPackageArn;
        }

        // Handle marketplace:// prefix from --model-name CLI option
        const modelName = explicitConfig.modelName || combinedAnswers.modelName;
        if (modelName && modelName.startsWith('marketplace://')) {
            const arn = modelName.replace(/^marketplace:\/\//, '');
            combinedAnswers.modelPackageArn = arn;
            delete combinedAnswers.modelName;
        }

        return combinedAnswers;
    }
}

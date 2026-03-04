// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager - Handles configuration validation
 * 
 * This module validates user configuration choices to ensure they are
 * supported by the generator. With do-framework integration, conditional
 * file exclusion logic has been removed - all template files are now
 * generated unconditionally, and runtime scripts handle conditional logic.
 */

export default class TemplateManager {
    constructor(answers) {
        this.answers = answers;
    }



    /**
     * Validates that the configuration is supported
     * @throws {Error} If unsupported configuration detected
     */
    validate() {
        const supportedOptions = {
            deploymentConfigs: [
                'sklearn-flask', 'sklearn-fastapi',
                'xgboost-flask', 'xgboost-fastapi',
                'tensorflow-flask', 'tensorflow-fastapi',
                'transformers-vllm', 'transformers-sglang',
                'transformers-tensorrt-llm', 'transformers-lmi', 'transformers-djl'
            ],
            deployment: ['sagemaker', 'codebuild'],
            testTypes: ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'],
            awsRegions: [
                'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
                'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1',
                'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
                'ca-central-1', 'sa-east-1'
            ]
        };

        // Validate deployment configuration if present
        if (this.answers.deploymentConfig) {
            this._validateChoice('deploymentConfig', supportedOptions.deploymentConfigs);
        } else {
            // Fallback: validate framework and modelServer separately (for backward compatibility)
            const frameworks = ['sklearn', 'xgboost', 'tensorflow', 'transformers'];
            const modelServers = ['flask', 'fastapi', 'vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl'];
            
            this._validateChoice('framework', frameworks);
            this._validateChoice('modelServer', modelServers);
            
            // Validate tensorrt-llm is only used with transformers framework
            if (this.answers.modelServer === 'tensorrt-llm' && this.answers.framework !== 'transformers') {
                throw new Error('⚠️  TensorRT-LLM is only supported with the transformers framework. Please select "transformers" as your framework or choose a different model server.');
            }
        }

        this._validateChoice('deployTarget', supportedOptions.deployment);
        
        // Validate instance type format (ml.*.*)
        if (this.answers.instanceType && this.answers.instanceType !== 'custom') {
            const instancePattern = /^ml\.[a-z0-9]+\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/;
            if (!instancePattern.test(this.answers.instanceType)) {
                throw new Error(`⚠️  Invalid instance type format: ${this.answers.instanceType}. Expected format: ml.{family}.{size} (e.g., ml.m5.large, ml.g5.xlarge)`);
            }
        }
        
        this._validateChoice('awsRegion', supportedOptions.awsRegions);

        // Validate test types if testing is enabled
        if (this.answers.includeTesting && this.answers.testTypes) {
            for (const testType of this.answers.testTypes) {
                this._validateChoice('testType', supportedOptions.testTypes, testType);
            }
        }
    }

    /**
     * Validates a single configuration choice
     * @private
     */
    _validateChoice(field, supportedValues, value = null) {
        const actualValue = value || this.answers[field];
        if (actualValue && !supportedValues.includes(actualValue)) {
            throw new Error(`⚠️  ${actualValue} not implemented yet for ${field}.`);
        }
    }
}


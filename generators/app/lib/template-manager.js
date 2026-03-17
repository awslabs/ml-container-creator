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
            buildTargets: ['codebuild'],
            deploymentTargets: ['managed-inference', 'hyperpod-eks'],
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

        // Validate buildTarget (replaces deployTarget)
        if (this.answers.buildTarget) {
            this._validateChoice('buildTarget', supportedOptions.buildTargets);
        } else if (this.answers.deployTarget) {
            // Backward compatibility: validate deployTarget against buildTargets
            this._validateChoice('deployTarget', supportedOptions.buildTargets);
        }

        // Validate deploymentTarget
        if (this.answers.deploymentTarget) {
            this._validateChoice('deploymentTarget', supportedOptions.deploymentTargets);
        }

        // Validate HyperPod EKS specific fields
        if (this.answers.deploymentTarget === 'hyperpod-eks') {
            this._validateHyperPodConfig();
        }
        
        // Validate instance type format (ml.*.*) - only for managed-inference
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
     * Validates HyperPod EKS specific configuration
     * @private
     * @throws {Error} If HyperPod configuration is invalid
     */
    _validateHyperPodConfig() {
        // Validate hyperPodCluster is non-empty
        if (!this.answers.hyperPodCluster || this.answers.hyperPodCluster.trim() === '') {
            throw new Error('⚠️  hyperPodCluster is required when deploymentTarget is "hyperpod-eks". Please provide a valid HyperPod cluster name.');
        }

        // Validate hyperPodNamespace conforms to RFC 1123 DNS label format
        if (this.answers.hyperPodNamespace) {
            if (!this._isValidRfc1123DnsLabel(this.answers.hyperPodNamespace)) {
                throw new Error(`⚠️  Invalid hyperPodNamespace: "${this.answers.hyperPodNamespace}". Namespace must conform to RFC 1123 DNS label format: lowercase alphanumeric characters or hyphens, must start and end with an alphanumeric character, and be at most 63 characters.`);
            }
        }

        // Validate hyperPodReplicas is an integer >= 1
        if (this.answers.hyperPodReplicas !== undefined) {
            const replicas = this.answers.hyperPodReplicas;
            if (!Number.isInteger(replicas) || replicas < 1) {
                throw new Error(`⚠️  Invalid hyperPodReplicas: "${replicas}". Replicas must be an integer greater than or equal to 1.`);
            }
        }
    }

    /**
     * Validates a string conforms to RFC 1123 DNS label format
     * @private
     * @param {string} value - The value to validate
     * @returns {boolean} True if valid RFC 1123 DNS label
     */
    _isValidRfc1123DnsLabel(value) {
        if (!value || typeof value !== 'string') {
            return false;
        }
        // RFC 1123 DNS label: lowercase alphanumeric, hyphens allowed (not at start/end), max 63 chars
        const rfc1123Pattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
        return value.length <= 63 && rfc1123Pattern.test(value);
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


// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager - Handles configuration validation
 * 
 * This module validates user configuration choices to ensure they are
 * supported by the generator. With do-framework integration, conditional
 * file exclusion logic has been removed - all template files are now
 * generated unconditionally, and runtime scripts handle conditional logic.
 * 
 * Requirements: 7.1, 7.2, 7.3, 7.4, 2.1
 */

/**
 * GPU-requiring Triton backends that must use GPU instance types
 */
const GPU_REQUIRING_BACKENDS = ['triton-vllm', 'triton-tensorrtllm']

/**
 * CPU-only instance type families (patterns that indicate non-GPU instances)
 */
const CPU_ONLY_INSTANCE_PATTERNS = [
    /^ml\.m[0-9]+\./,   // ml.m4.*, ml.m5.*, ml.m6i.*, etc.
    /^ml\.c[0-9]+\./,   // ml.c4.*, ml.c5.*, ml.c6i.*, etc.
    /^ml\.t[0-9]+\./,   // ml.t2.*, ml.t3.*, etc.
    /^ml\.r[0-9]+\./,   // ml.r5.*, ml.r6i.*, etc.
]

/**
 * Check if an instance type is CPU-only (no GPU)
 * @param {string} instanceType - e.g. 'ml.m5.large', 'ml.g5.xlarge'
 * @returns {boolean} true if CPU-only, false if GPU-capable
 */
function isCpuOnlyInstance(instanceType) {
    if (!instanceType || instanceType === 'custom') {
        return false
    }
    return CPU_ONLY_INSTANCE_PATTERNS.some(pattern => pattern.test(instanceType))
}

export default class TemplateManager {
    constructor(answers) {
        this.answers = answers
    }

    /**
     * Validates that the configuration is supported
     * @throws {Error} If unsupported configuration detected
     */
    validate() {
        const supportedOptions = {
            // 14 canonical deployment-config values (2 http, 5 transformers, 7 triton)
            deploymentConfigs: [
                // HTTP architecture (2)
                'http-flask', 'http-fastapi',
                // Transformers architecture (5)
                'transformers-vllm', 'transformers-sglang',
                'transformers-tensorrt-llm', 'transformers-lmi', 'transformers-djl',
                // Triton architecture (7)
                'triton-fil', 'triton-onnxruntime', 'triton-tensorflow',
                'triton-pytorch', 'triton-vllm', 'triton-tensorrtllm', 'triton-python'
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
        }

        // Validate deployment configuration if present
        if (this.answers.deploymentConfig) {
            this._validateChoice('deploymentConfig', supportedOptions.deploymentConfigs)
            
            // GPU instance type enforcement for GPU-requiring backends
            this._validateGpuRequirement()
        } else {
            // Fallback: validate architecture and backend separately (new canonical format)
            const architectures = ['http', 'transformers', 'triton']
            const backends = [
                // http backends
                'flask', 'fastapi',
                // transformers backends
                'vllm', 'sglang', 'tensorrt-llm', 'lmi', 'djl',
                // triton backends
                'fil', 'onnxruntime', 'tensorflow', 'pytorch', 'tensorrtllm', 'python'
            ]
            
            this._validateChoice('architecture', architectures)
            this._validateChoice('backend', backends)
            
            // Validate tensorrt-llm is only used with transformers architecture
            if (this.answers.backend === 'tensorrt-llm' && this.answers.architecture !== 'transformers') {
                throw new Error('⚠️  TensorRT-LLM is only supported with the transformers architecture. Please select "transformers" as your architecture or choose a different backend.')
            }
            
            // GPU instance type enforcement for GPU-requiring backends (fallback path)
            const deploymentConfig = this.answers.architecture && this.answers.backend
                ? `${this.answers.architecture}-${this.answers.backend}`
                : null
            if (deploymentConfig && GPU_REQUIRING_BACKENDS.includes(deploymentConfig)) {
                this._validateGpuRequirementForConfig(deploymentConfig)
            }
        }

        // Validate buildTarget (replaces deployTarget)
        if (this.answers.buildTarget) {
            this._validateChoice('buildTarget', supportedOptions.buildTargets)
        } else if (this.answers.deployTarget) {
            // Backward compatibility: validate deployTarget against buildTargets
            this._validateChoice('deployTarget', supportedOptions.buildTargets)
        }

        // Validate deploymentTarget
        if (this.answers.deploymentTarget) {
            this._validateChoice('deploymentTarget', supportedOptions.deploymentTargets)
        }

        // Validate HyperPod EKS specific fields
        if (this.answers.deploymentTarget === 'hyperpod-eks') {
            this._validateHyperPodConfig()
        }
        
        // Validate instance type format (ml.*.*) - only for managed-inference
        if (this.answers.instanceType && this.answers.instanceType !== 'custom') {
            const instancePattern = /^ml\.[a-z0-9]+\.(nano|micro|small|medium|large|xlarge|[0-9]+xlarge)$/
            if (!instancePattern.test(this.answers.instanceType)) {
                throw new Error(`⚠️  Invalid instance type format: ${this.answers.instanceType}. Expected format: ml.{family}.{size} (e.g., ml.m5.large, ml.g5.xlarge)`)
            }
        }
        
        this._validateChoice('awsRegion', supportedOptions.awsRegions)

        // Validate test types if testing is enabled
        if (this.answers.includeTesting && this.answers.testTypes) {
            for (const testType of this.answers.testTypes) {
                this._validateChoice('testType', supportedOptions.testTypes, testType)
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
            throw new Error('⚠️  hyperPodCluster is required when deploymentTarget is "hyperpod-eks". Please provide a valid HyperPod cluster name.')
        }

        // Validate hyperPodNamespace conforms to RFC 1123 DNS label format
        if (this.answers.hyperPodNamespace) {
            if (!this._isValidRfc1123DnsLabel(this.answers.hyperPodNamespace)) {
                throw new Error(`⚠️  Invalid hyperPodNamespace: "${this.answers.hyperPodNamespace}". Namespace must conform to RFC 1123 DNS label format: lowercase alphanumeric characters or hyphens, must start and end with an alphanumeric character, and be at most 63 characters.`)
            }
        }

        // Validate hyperPodReplicas is an integer >= 1
        if (this.answers.hyperPodReplicas !== undefined) {
            const replicas = this.answers.hyperPodReplicas
            if (!Number.isInteger(replicas) || replicas < 1) {
                throw new Error(`⚠️  Invalid hyperPodReplicas: "${replicas}". Replicas must be an integer greater than or equal to 1.`)
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
            return false
        }
        // RFC 1123 DNS label: lowercase alphanumeric, hyphens allowed (not at start/end), max 63 chars
        const rfc1123Pattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
        return value.length <= 63 && rfc1123Pattern.test(value)
    }

    /**
     * Validates GPU instance type requirement for GPU-requiring backends.
     * Called when deploymentConfig is present.
     * @private
     * @throws {Error} If a GPU-requiring backend is paired with a CPU-only instance
     */
    _validateGpuRequirement() {
        const dc = this.answers.deploymentConfig
        if (GPU_REQUIRING_BACKENDS.includes(dc)) {
            this._validateGpuRequirementForConfig(dc)
        }
    }

    /**
     * Validates that a GPU-requiring deployment config is not paired with a CPU-only instance.
     * @private
     * @param {string} deploymentConfig - The deployment config string
     * @throws {Error} If instance type is CPU-only
     */
    _validateGpuRequirementForConfig(deploymentConfig) {
        const instanceType = this.answers.instanceType
        if (isCpuOnlyInstance(instanceType)) {
            throw new Error(
                `⚠️  ${deploymentConfig} requires a GPU instance type. ` +
                `Selected: ${instanceType}. ` +
                `Recommended: ml.g5.xlarge, ml.g5.2xlarge`
            )
        }
    }

    /**
     * Validates a single configuration choice
     * @private
     */
    _validateChoice(field, supportedValues, value = null) {
        const actualValue = value || this.answers[field]
        if (actualValue && !supportedValues.includes(actualValue)) {
            throw new Error(`⚠️  ${actualValue} not implemented yet for ${field}.`)
        }
    }
}


/**
 * CommentGenerator - Generates documentation comments for templates
 * 
 * Responsible for creating comprehensive inline documentation for generated
 * Dockerfiles and deployment scripts, including configuration sources,
 * validation information, and troubleshooting tips.
 */

export default class CommentGenerator {
    /**
     * Generate comprehensive Dockerfile comments
     * @param {Object} config - Configuration profile
     * @returns {Object} Comment sections for Dockerfile
     */
    generateDockerfileComments(config) {
        return {
            acceleratorInfo: this.generateAcceleratorComment(config),
            envVarExplanations: this.generateEnvVarComments(config),
            validationInfo: this.generateValidationComment(config),
            troubleshooting: this.generateTroubleshootingTips(config),
            chatTemplate: this.generateChatTemplateComment(config)
        };
    }

    /**
     * Generate deployment script comments
     * @param {Object} config - Configuration profile
     * @returns {Object} Comment sections for deployment scripts
     */
    generateDeploymentComments(config) {
        const comments = {
            header: this.generateDeploymentHeader(config),
            amiVersion: this.generateAmiVersionComment(config),
            instanceType: this.generateInstanceTypeComment(config),
            configSource: this.generateConfigSourceComment(config)
        };

        return comments;
    }

    /**
     * Generate accelerator compatibility comment
     * @param {Object} config - Configuration profile
     * @returns {string} Accelerator compatibility information
     */
    generateAcceleratorComment(config) {
        if (!config.accelerator) {
            return '# No accelerator requirements specified';
        }

        const lines = [
            '# Accelerator Compatibility Information',
            `# Framework: ${config.framework} ${config.version}`,
            `# Required Accelerator: ${config.accelerator.type} ${config.accelerator.version || 'any'}`
        ];

        if (config.instanceType) {
            lines.push(`# Instance Type: ${config.instanceType}`);
        }

        if (config.instanceHardware) {
            lines.push(`# Hardware: ${config.instanceHardware}`);
        }

        if (config.inferenceAmiVersion) {
            lines.push(`# SageMaker AMI: ${config.inferenceAmiVersion}`);
        }

        if (config.validationResults?.accelerator) {
            const result = config.validationResults.accelerator;
            const status = result.compatible ? '✓ Compatible' : '⚠ Issues detected';
            lines.push(`# Validation: ${status}`);

            if (result.info) {
                lines.push(`# Info: ${result.info}`);
            }

            if (result.warning) {
                lines.push(`# Warning: ${result.warning}`);
            }

            if (result.error) {
                lines.push(`# Error: ${result.error}`);
            }
        }

        if (config.validationLevel) {
            lines.push(`# Validation Level: ${config.validationLevel}`);
        }

        const timestamp = config.generatedAt || new Date().toISOString().split('T')[0];
        lines.push(`# Generated: ${timestamp}`);

        return lines.join('\n');
    }

    /**
     * Generate environment variable comments
     * @param {Object} config - Configuration profile
     * @returns {Object} Environment variable explanations grouped by category
     */
    generateEnvVarComments(config) {
        const comments = {};

        if (!config.envVars || Object.keys(config.envVars).length === 0) {
            return { general: '# No environment variables configured' };
        }

        // Group environment variables by category
        const groups = this._groupEnvVars(config.envVars, config.framework);

        for (const [category, vars] of Object.entries(groups)) {
            const categoryComments = [
                `# ${category} Configuration`,
                `# Source: ${this._getEnvVarSource(config, category)}`
            ];

            // Add warnings for specific variable types
            const warnings = this._getEnvVarWarnings(vars, config.framework);
            if (warnings.length > 0) {
                categoryComments.push('# Warnings:');
                warnings.forEach(warning => {
                    categoryComments.push(`#   - ${warning}`);
                });
            }

            // Add documentation links if available
            const docLink = this._getDocumentationLink(config.framework, category);
            if (docLink) {
                categoryComments.push(`# Documentation: ${docLink}`);
            }

            comments[category] = categoryComments.join('\n');
        }

        return comments;
    }

    /**
     * Generate validation information comment
     * @param {Object} config - Configuration profile
     * @returns {string} Validation information
     */
    generateValidationComment(config) {
        const lines = [
            '# Configuration Validation Information'
        ];

        // Add configuration sources
        if (config.configSources && config.configSources.length > 0) {
            lines.push('# Configuration Sources:');
            config.configSources.forEach(source => {
                lines.push(`#   - ${source}`);
            });
        }

        // Add validation level
        if (config.validationLevel) {
            lines.push(`# Validation Level: ${config.validationLevel}`);
            lines.push(`# ${this._getValidationLevelExplanation(config.validationLevel)}`);
        }

        // Add validation results
        if (config.validationResults) {
            if (config.validationResults.envVars) {
                const envResult = config.validationResults.envVars;
                if (envResult.validated) {
                    lines.push('# Environment Variables: Validated');
                    if (envResult.methods && envResult.methods.length > 0) {
                        lines.push(`#   Methods: ${envResult.methods.join(', ')}`);
                    }
                }
            }

            if (config.validationResults.instanceType) {
                const instResult = config.validationResults.instanceType;
                if (instResult.validated) {
                    lines.push('# Instance Type: Validated');
                }
            }
        }

        return lines.join('\n');
    }

    /**
     * Generate troubleshooting tips
     * @param {Object} config - Configuration profile
     * @returns {string} Troubleshooting tips
     */
    generateTroubleshootingTips(config) {
        const lines = [
            '# Troubleshooting Tips'
        ];

        // Framework-specific tips
        const frameworkTips = this._getFrameworkTroubleshootingTips(config.framework);
        if (frameworkTips.length > 0) {
            lines.push(`# ${config.framework} Common Issues:`);
            frameworkTips.forEach(tip => {
                lines.push(`#   - ${tip}`);
            });
        }

        // Accelerator-specific tips
        if (config.accelerator) {
            const acceleratorTips = this._getAcceleratorTroubleshootingTips(config.accelerator.type);
            if (acceleratorTips.length > 0) {
                lines.push(`# ${config.accelerator.type.toUpperCase()} Issues:`);
                acceleratorTips.forEach(tip => {
                    lines.push(`#   - ${tip}`);
                });
            }
        }

        // General tips
        lines.push('# General Tips:');
        lines.push('#   - Check CloudWatch logs for detailed error messages');
        lines.push('#   - Verify model artifacts are in /opt/ml/model/');
        lines.push('#   - Test locally with docker run before deploying');
        lines.push('#   - Ensure IAM role has necessary permissions');

        return lines.join('\n');
    }

    /**
     * Generate chat template comment
     * @param {Object} config - Configuration profile
     * @returns {string} Chat template information
     */
    generateChatTemplateComment(config) {
        if (!config.chatTemplate) {
            return '# Chat Template: Not configured\n' +
                   '# Note: Chat endpoints may not work without a chat template.\n' +
                   '# You may need to configure this manually for your model.';
        }

        const lines = [
            '# Chat Template Configuration',
            `# Source: ${config.chatTemplateSource || 'Unknown'}`,
            '# This template formats chat messages for the model.',
            '# It is automatically applied by the serving framework.'
        ];

        if (config.chatTemplateSource === 'HuggingFace_Hub_API') {
            lines.push('# Template was fetched from HuggingFace Hub.');
        } else if (config.chatTemplateSource === 'Model_Registry') {
            lines.push('# Template was provided by Model Registry.');
        }

        return lines.join('\n');
    }

    /**
     * Generate deployment script header
     * @param {Object} config - Configuration profile
     * @returns {string} Deployment header comment
     */
    generateDeploymentHeader(config) {
        const lines = [
            '#!/bin/bash',
            '#',
            '# SageMaker Deployment Script',
            `# Framework: ${config.framework} ${config.version}`,
            `# Generated: ${config.generatedAt || new Date().toISOString().split('T')[0]}`,
            '#'
        ];

        if (config.validationLevel) {
            lines.push(`# Validation Level: ${config.validationLevel}`);
        }

        return lines.join('\n');
    }

    /**
     * Generate AMI version comment
     * @param {Object} config - Configuration profile
     * @returns {string} AMI version explanation
     */
    generateAmiVersionComment(config) {
        if (!config.inferenceAmiVersion) {
            return '# AMI Version: Using default SageMaker AMI';
        }

        const lines = [
            `# AMI Version: ${config.inferenceAmiVersion}`,
            '# This AMI provides the required accelerator drivers and runtime.'
        ];

        if (config.accelerator) {
            lines.push(`# Supports: ${config.accelerator.type} ${config.accelerator.version || ''}`);
        }

        if (config.configSources && config.configSources.includes('Framework_Registry')) {
            lines.push('# Source: Framework Registry');
        }

        return lines.join('\n');
    }

    /**
     * Generate instance type comment
     * @param {Object} config - Configuration profile
     * @returns {string} Instance type explanation
     */
    generateInstanceTypeComment(config) {
        if (!config.instanceType) {
            return '# Instance Type: Not specified';
        }

        const lines = [
            `# Instance Type: ${config.instanceType}`
        ];

        if (config.instanceHardware) {
            lines.push(`# Hardware: ${config.instanceHardware}`);
        }

        if (config.recommendedInstanceTypes && config.recommendedInstanceTypes.length > 0) {
            lines.push('# Recommended alternatives:');
            config.recommendedInstanceTypes.slice(0, 3).forEach(type => {
                lines.push(`#   - ${type}`);
            });
        }

        return lines.join('\n');
    }

    /**
     * Generate configuration source comment
     * @param {Object} config - Configuration profile
     * @returns {string} Configuration source information
     */
    generateConfigSourceComment(config) {
        const lines = [
            '# Configuration Sources:'
        ];

        if (config.configSources && config.configSources.length > 0) {
            config.configSources.forEach(source => {
                lines.push(`#   - ${source}`);
            });
        } else {
            lines.push('#   - Default configuration');
        }

        return lines.join('\n');
    }

    // Private helper methods

    /**
     * Group environment variables by category
     * @private
     */
    _groupEnvVars(envVars, framework) {
        const groups = {
            'Framework': [],
            'Memory': [],
            'Performance': [],
            'CUDA': [],
            'Other': []
        };

        for (const [key, value] of Object.entries(envVars)) {
            if (key.includes('CUDA') || key.includes('NVIDIA')) {
                groups['CUDA'].push({ key, value });
            } else if (key.includes('MEMORY') || key.includes('MEM')) {
                groups['Memory'].push({ key, value });
            } else if (key.includes('BATCH') || key.includes('WORKER') || key.includes('THREAD')) {
                groups['Performance'].push({ key, value });
            } else if (framework && key.toLowerCase().includes(framework.toLowerCase())) {
                groups['Framework'].push({ key, value });
            } else {
                groups['Other'].push({ key, value });
            }
        }

        // Remove empty groups
        return Object.fromEntries(
            Object.entries(groups).filter(([_, vars]) => vars.length > 0)
        );
    }

    /**
     * Get environment variable source
     * @private
     */
    _getEnvVarSource(config, _category) {
        if (config.configSources) {
            if (config.configSources.includes('Model_Registry')) {
                return 'Model Registry (highest priority)';
            } else if (config.configSources.includes('HuggingFace_Hub_API')) {
                return 'HuggingFace Hub API';
            } else if (config.configSources.includes('Framework_Registry')) {
                return 'Framework Registry';
            }
        }
        return 'Default configuration';
    }

    /**
     * Get warnings for environment variables
     * @private
     */
    _getEnvVarWarnings(vars, _framework) {
        const warnings = [];

        vars.forEach(({ key, value: _value }) => {
            if (key.includes('MEMORY') && key.includes('FRACTION')) {
                warnings.push(`${key}: Adjust based on model size and available GPU memory`);
            }
            if (key.includes('CUDA_VISIBLE_DEVICES')) {
                warnings.push(`${key}: Ensure this matches your instance GPU count`);
            }
            if (key.includes('MAX_BATCH_SIZE')) {
                warnings.push(`${key}: May need tuning based on model size and latency requirements`);
            }
        });

        return warnings;
    }

    /**
     * Get documentation link for framework and category
     * @private
     */
    _getDocumentationLink(framework, _category) {
        const links = {
            'vllm': 'https://docs.vllm.ai/en/latest/serving/env_vars.html',
            'tensorrt-llm': 'https://nvidia.github.io/TensorRT-LLM/',
            'sglang': 'https://sgl-project.github.io/',
            'transformers': 'https://huggingface.co/docs/transformers/'
        };

        return links[framework?.toLowerCase()] || null;
    }

    /**
     * Get validation level explanation
     * @private
     */
    _getValidationLevelExplanation(level) {
        const explanations = {
            'tested': 'This configuration has been tested on AWS SageMaker and verified to work.',
            'community-validated': 'This configuration has been validated by community members.',
            'experimental': 'This configuration is experimental and may require adjustments.',
            'unknown': 'This configuration has not been tested. Proceed with caution.'
        };

        return explanations[level] || 'Validation level unknown.';
    }

    /**
     * Get framework-specific troubleshooting tips
     * @private
     */
    _getFrameworkTroubleshootingTips(framework) {
        const tips = {
            'vllm': [
                'If OOM errors occur, reduce MAX_MODEL_LEN or GPU_MEMORY_UTILIZATION',
                'For slow startup, check model download from HuggingFace Hub',
                'Tensor parallelism requires multiple GPUs on same instance'
            ],
            'tensorrt-llm': [
                'Ensure CUDA version matches TensorRT-LLM requirements',
                'Model must be converted to TensorRT format before deployment',
                'Check UCX settings if using multi-GPU configurations'
            ],
            'sglang': [
                'Verify model is compatible with SGLang runtime',
                'Check memory settings if experiencing OOM errors',
                'Ensure correct chat template is configured'
            ],
            'transformers': [
                'Verify model files are present in /opt/ml/model/',
                'Check tokenizer configuration for chat models',
                'Ensure sufficient memory for model loading'
            ]
        };

        return tips[framework?.toLowerCase()] || [];
    }

    /**
     * Get accelerator-specific troubleshooting tips
     * @private
     */
    _getAcceleratorTroubleshootingTips(acceleratorType) {
        const tips = {
            'cuda': [
                'Verify CUDA version with nvidia-smi in container',
                'Check GPU memory usage with nvidia-smi',
                'Ensure CUDA libraries are in LD_LIBRARY_PATH'
            ],
            'neuron': [
                'Verify Neuron SDK version with neuron-ls',
                'Check Neuron device availability',
                'Review Neuron compiler logs for optimization issues'
            ],
            'rocm': [
                'Verify ROCm installation with rocm-smi',
                'Check GPU visibility with HIP_VISIBLE_DEVICES',
                'Ensure ROCm libraries are properly loaded'
            ],
            'cpu': [
                'Monitor CPU usage and memory consumption',
                'Consider using optimized CPU inference libraries',
                'Adjust thread count based on vCPU count'
            ]
        };

        return tips[acceleratorType?.toLowerCase()] || [];
    }
}

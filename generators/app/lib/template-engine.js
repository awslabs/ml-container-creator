// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import CommentGenerator from './comment-generator.js';

/**
 * TemplateEngine - Generates files with injected configurations
 * 
 * Responsible for generating Dockerfiles and deployment scripts with
 * configuration data from catalogs, HuggingFace API, and user input.
 * Integrates CommentGenerator for comprehensive documentation.
 */
export default class TemplateEngine {
    /**
     * @param {Object} generator - Yeoman generator instance
     */
    constructor(generator) {
        this.generator = generator;
        this.commentGenerator = new CommentGenerator();
    }

    /**
     * Generate Dockerfile with configuration injection
     * @param {Object} config - Configuration profile
     * @returns {void}
     */
    generateDockerfile(config) {
        // Generate comments for documentation
        const comments = this.commentGenerator.generateDockerfileComments(config);

        // Prepare template variables with configuration and comments
        const templateVars = {
            ...config,
            comments,
            // Preserve environment variable ordering
            orderedEnvVars: this._getOrderedEnvVars(config.envVars || {})
        };

        // Copy and process Dockerfile template
        this.generator.fs.copyTpl(
            this.generator.templatePath('Dockerfile'),
            this.generator.destinationPath('Dockerfile'),
            templateVars
        );
    }

    /**
     * Generate deployment script with configuration injection
     * @param {Object} config - Configuration profile
     * @returns {void}
     */
    generateDeploymentScript(config) {
        // Generate comments for documentation
        const comments = this.commentGenerator.generateDeploymentComments(config);

        // Prepare template variables with configuration and comments
        const templateVars = {
            ...config,
            comments
        };

        // Copy and process deployment script template
        this.generator.fs.copyTpl(
            this.generator.templatePath('deploy/deploy.sh'),
            this.generator.destinationPath('deploy/deploy.sh'),
            templateVars
        );
    }

    /**
     * Get environment variables in correct order
     * Preserves dependency order (e.g., CUDA paths before framework variables)
     * @private
     * @param {Object} envVars - Environment variables object
     * @returns {Array<{key: string, value: string}>} Ordered array of env vars
     */
    _getOrderedEnvVars(envVars) {
        const entries = Object.entries(envVars);
        
        // Define priority order for environment variable categories
        const priorities = {
            // System paths (highest priority)
            'LD_LIBRARY_PATH': 1,
            'PATH': 1,
            'CUDA_HOME': 1,
            'CUDA_PATH': 1,
            
            // CUDA configuration
            'CUDA_VISIBLE_DEVICES': 2,
            'NVIDIA_VISIBLE_DEVICES': 2,
            'NVIDIA_DRIVER_CAPABILITIES': 2,
            
            // Framework-specific (medium priority)
            'VLLM': 3,
            'TENSORRT': 3,
            'SGLANG': 3,
            'TRANSFORMERS': 3,
            
            // Application configuration (lower priority)
            'MAX': 4,
            'BATCH': 4,
            'WORKER': 4,
            'THREAD': 4,
            
            // Other variables (lowest priority)
            'default': 5
        };

        // Sort entries by priority
        const sorted = entries.sort(([keyA], [keyB]) => {
            const priorityA = this._getEnvVarPriority(keyA, priorities);
            const priorityB = this._getEnvVarPriority(keyB, priorities);
            
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }
            
            // If same priority, sort alphabetically
            return keyA.localeCompare(keyB);
        });

        // Convert to array of objects for template
        return sorted.map(([key, value]) => ({ key, value }));
    }

    /**
     * Get priority for an environment variable
     * @private
     * @param {string} key - Environment variable name
     * @param {Object} priorities - Priority mapping
     * @returns {number} Priority value (lower = higher priority)
     */
    _getEnvVarPriority(key, priorities) {
        // Check for exact match first
        if (priorities[key]) {
            return priorities[key];
        }

        // Check for partial matches
        for (const [pattern, priority] of Object.entries(priorities)) {
            if (pattern !== 'default' && key.includes(pattern)) {
                return priority;
            }
        }

        // Default priority
        return priorities.default;
    }
}

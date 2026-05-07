// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import ejs from 'ejs';
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
     * @param {Object} options - Configuration options
     * @param {string} options.templateDir - Root directory containing template files
     * @param {string} options.destDir - Root directory for generated output
     */
    constructor({ templateDir, destDir }) {
        this.templateDir = templateDir;
        this.destDir = destDir;
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

        // Render and write Dockerfile template
        this._renderTemplate('Dockerfile', 'Dockerfile', templateVars);
    }

    /**
     * Generate deployment script with configuration injection
     * @param {Object} config - Configuration profile
     * @returns {void}
     */
    generateDeploymentScript(_config) {
        // No-op: legacy deploy/ scripts have been removed.
        // Deployment is handled by do/deploy in the do-framework.
    }

    /**
     * Render a single EJS template file to the destination directory.
     * @private
     * @param {string} templateRelPath - Relative path within templateDir
     * @param {string} destRelPath - Relative path within destDir
     * @param {Object} vars - Template variables for EJS rendering
     */
    _renderTemplate(templateRelPath, destRelPath, vars) {
        const src = path.resolve(this.templateDir, templateRelPath);
        const dest = path.resolve(this.destDir, destRelPath);

        fs.mkdirSync(path.dirname(dest), { recursive: true });

        const content = fs.readFileSync(src, 'utf8');
        const rendered = ejs.render(content, vars, { filename: src });
        fs.writeFileSync(dest, rendered);
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

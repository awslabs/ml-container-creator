// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template Manager - Handles conditional template copying based on configuration
 * 
 * This module centralizes the logic for determining which template files
 * should be included or excluded based on user configuration choices.
 */

export default class TemplateManager {
    constructor(answers) {
        this.answers = answers;
    }

    /**
     * Builds list of glob patterns for files to exclude from template copying
     * @returns {string[]} Array of glob patterns to ignore
     */
    getIgnorePatterns() {
        const patterns = [
            // Always exclude template documentation
            '**/README.md'
        ];

        // Framework-specific exclusions
        if (this.answers.framework === 'transformers') {
            patterns.push(...this._getTransformerExclusions());
        } else {
            patterns.push(...this._getTraditionalMLExclusions());
        }

        // Server-specific exclusions
        if (this.answers.modelServer !== 'flask') {
            patterns.push('**/code/flask/**');
        }

        // Deployment target exclusions
        if (this.answers.deployTarget === 'codebuild') {
            patterns.push(...this._getSageMakerOnlyExclusions());
        } else if (this.answers.deployTarget === 'sagemaker') {
            patterns.push(...this._getCodeBuildOnlyExclusions());
        }

        // Optional module exclusions
        if (!this.answers.includeSampleModel) {
            patterns.push('**/sample_model/**');
        }

        if (!this.answers.includeTesting) {
            patterns.push('**/test/**');
        }

        return patterns;
    }

    /**
     * Files to exclude for transformer models (use vLLM/SGLang serving)
     * @private
     */
    _getTransformerExclusions() {
        return [
            '**/code/model_handler.py',     // Custom model loading
            '**/code/start_server.py',      // Flask/FastAPI startup
            '**/code/serve.py',             // Flask/FastAPI server
            '**/nginx.conf**',              // Nginx reverse proxy
            '**/requirements.txt**',        // Traditional ML dependencies
            '**/test/test_local_image.sh',  // Local testing
            '**/test/test_model_handler.py' // Unit tests
        ];
    }

    /**
     * Files to exclude for traditional ML models (sklearn, xgboost, tensorflow)
     * @private
     */
    _getTraditionalMLExclusions() {
        return [
            '**/code/serve',                // vLLM/SGLang entrypoint
            '**/deploy/upload_to_s3.sh'     // S3 model upload script
        ];
    }

    /**
     * Files to exclude when CodeBuild deployment target is selected (exclude SageMaker-only files)
     * @private
     */
    _getSageMakerOnlyExclusions() {
        return [
            '**/deploy/build_and_push.sh'   // Local Docker build script (SageMaker only)
        ];
    }

    /**
     * Files to exclude when SageMaker deployment target is selected (exclude CodeBuild-only files)
     * @private
     */
    _getCodeBuildOnlyExclusions() {
        return [
            '**/buildspec.yml',             // CodeBuild project configuration
            '**/deploy/submit_build.sh',    // CodeBuild job submission script
            '**/IAM_PERMISSIONS.md'         // CodeBuild IAM documentation
        ];
    }

    /**
     * Validates that the configuration is supported
     * @throws {Error} If unsupported configuration detected
     */
    validate() {
        const supportedOptions = {
            frameworks: ['sklearn', 'xgboost', 'tensorflow', 'transformers'],
            modelServer: ['flask', 'fastapi', 'vllm', 'sglang'],
            deployment: ['sagemaker', 'codebuild'],
            testTypes: ['local-model-cli', 'local-model-server', 'hosted-model-endpoint'],
            instanceTypes: ['cpu-optimized', 'gpu-enabled', 'custom'],
            awsRegions: [
                'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
                'eu-west-1', 'eu-west-2', 'eu-central-1', 'eu-north-1',
                'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
                'ca-central-1', 'sa-east-1'
            ]
        };

        this._validateChoice('framework', supportedOptions.frameworks);
        this._validateChoice('modelServer', supportedOptions.modelServer);
        this._validateChoice('deployTarget', supportedOptions.deployment);
        this._validateChoice('instanceType', supportedOptions.instanceTypes);
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


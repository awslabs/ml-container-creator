// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Train Config Validator
 *
 * Validates training configuration objects parsed from do/training/config.yaml.
 * Checks that all required fields are present and provides descriptive error
 * messages naming the specific missing field.
 *
 * This module mirrors the validation logic in the bash `_validate_config`
 * function in templates/do/train, enabling property-based testing of the
 * validation rules in isolation.
 *
 * Requirements: 2.12, 10.1
 */

/**
 * Required fields for a valid training configuration.
 * Each entry maps the field name to a human-readable description and expected format.
 */
export const REQUIRED_FIELDS = {
    image: {
        description: 'The container image URI',
        format: 'image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-training:latest"'
    },
    script: {
        description: 'The training script S3 path',
        format: 'script: "s3://my-bucket/scripts/train.py"'
    },
    instance_type: {
        description: 'The SageMaker instance type',
        format: 'instance_type: "ml.g5.xlarge"'
    },
    dataset: {
        description: 'The S3 dataset path',
        format: 'dataset: "s3://my-bucket/data/train/"'
    },
    output_path: {
        description: 'The S3 output path',
        format: 'output_path: "s3://my-bucket/output/"'
    }
};

/**
 * Validate that all required fields are present in a training config.
 *
 * @param {Object} config - The parsed training configuration object
 * @returns {{ valid: boolean, errors: Array<{ field: string, message: string }> }}
 *   - valid: true if all required fields are present and non-empty
 *   - errors: array of error objects, each naming the missing field
 */
export function validateRequiredFields(config) {
    const errors = [];

    for (const [field, meta] of Object.entries(REQUIRED_FIELDS)) {
        const value = config ? config[field] : undefined;

        if (value === undefined || value === null || value === '') {
            errors.push({
                field,
                message: `Missing required field: ${field}\n   ${meta.description} is required in do/training/config.yaml\n\n   Expected format: ${meta.format}`
            });
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validate spot training checkpoint requirement.
 * When enable_spot is true, checkpoint_path must be specified.
 *
 * @param {Object} config - The parsed training configuration object
 * @returns {{ valid: boolean, errors: Array<{ field: string, message: string }> }}
 */
export function validateSpotConfig(config) {
    const errors = [];

    if (config && config.enable_spot === true && (!config.checkpoint_path || config.checkpoint_path === '')) {
        errors.push({
            field: 'checkpoint_path',
            message: 'Checkpoint path required for spot training\n   When enable_spot is true, a checkpoint S3 path must be specified\n   so training can resume after spot interruptions.'
        });
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Full validation of a training config — checks required fields and spot config.
 *
 * @param {Object} config - The parsed training configuration object
 * @returns {{ valid: boolean, errors: Array<{ field: string, message: string }> }}
 */
export function validateTrainingConfig(config) {
    const requiredResult = validateRequiredFields(config);
    const spotResult = validateSpotConfig(config);

    const allErrors = [...requiredResult.errors, ...spotResult.errors];

    return {
        valid: allErrors.length === 0,
        errors: allErrors
    };
}
